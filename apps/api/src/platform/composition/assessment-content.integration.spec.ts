import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as contentComposition from '../../contexts/content/public/composition.js';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore, InMemoryMediaStore, type ApplicationContext, type RenderValidator } from '../../contexts/content/application/ports.js';
import type { AuthoredItemContent } from '../../contexts/content/application/commands/authoring-commands.js';
import { CreateItemDraftHandler } from '../../contexts/content/application/handlers/authoring-handlers.js';
import { CreateSolutionDraftHandler } from '../../contexts/content/application/handlers/solution-handlers.js';
import {
  PublishItemVersionHandler,
  PublishSolutionVersionHandler,
  RecordItemReviewDecisionHandler,
  RecordSolutionReviewDecisionHandler,
  SubmitItemForReviewHandler,
  SubmitSolutionForReviewHandler,
} from '../../contexts/content/application/handlers/lifecycle-handlers.js';
import { RefreshFingerprintsHandler } from '../../contexts/content/application/review/handlers/fingerprint-handlers.js';
import type { Item } from '../../contexts/content/domain/item.js';
import type { ItemVersion } from '../../contexts/content/domain/item-version.js';
import { PostgresItemRepository } from '../../contexts/content/infrastructure/item.repository.js';
import { PostgresFingerprintRepository } from '../../contexts/content/infrastructure/review/fingerprint.repository.js';
import { PostgresMediaAssetRepository } from '../../contexts/content/infrastructure/media-asset.repository.js';
import { PostgresReviewDecisionRepository } from '../../contexts/content/infrastructure/review-decision.repository.js';
import { PostgresReviewAssignmentRepository } from '../../contexts/content/infrastructure/review/review-assignment.repository.js';
import { PostgresSolutionRepository } from '../../contexts/content/infrastructure/solution.repository.js';
import { PostgresStimulusRepository } from '../../contexts/content/infrastructure/stimulus.repository.js';
import { PostgresTransactionRunner } from '../../contexts/content/infrastructure/transaction-runner.js';
import { addAnchorPoolMember } from '../../contexts/assessment/domain/anchor-pool.js';
import { assembleForm, violatedConstraints } from '../../contexts/assessment/domain/assembly.js';
import { createBlueprint } from '../../contexts/assessment/domain/blueprint.js';
import { PostgresAnchorPoolRepository } from '../../contexts/assessment/infrastructure/anchor-pool.repository.js';
import { ContentCorpus } from '../../contexts/assessment/infrastructure/content-corpus.js';
import { PostgresExposureLedger } from '../../contexts/assessment/infrastructure/exposure-ledger.repository.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../testing/content-fixtures.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { createMediaStore } from '../persistence/filesystem-media-store.js';

/**
 * Assembly meets content — end to end, against real Postgres and **content's
 * real handlers**, through the seam content offers assessment. Lives in the
 * composition tree because it is the one place both contexts may be named
 * together.
 *
 * What it proves that the unit specs cannot: that the near-duplicates assembly
 * refuses are the ones *content's own detection* finds, with no second
 * definition of "near-duplicate" anywhere in assessment, and that nothing of
 * the answer key travels in what assessment gathers.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let seed = 0;
const uuid = () => {
  seed += 1;
  return `00000000-0000-4000-b200-${seed.toString(16).padStart(12, '0')}`;
};

const author: PrincipalRef = { kind: 'human', id: uuid(), roleContext: ['author', 'subject:physics'] };
const reviewer: PrincipalRef = { kind: 'human', id: uuid(), roleContext: ['reviewer'] };
const ops: PrincipalRef = { kind: 'human', id: uuid(), roleContext: ['content_ops'] };
const system: PrincipalRef = { kind: 'system', id: uuid(), roleContext: ['system'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c', ...(principal === ops ? { stepUpSatisfied: true } : {}) });

const CONCEPT = uuid();
const TAXONOMY = uuid();
const NOW = new Date('2026-10-21T09:00:00.000Z');
const clock = { now: () => NOW };
const identifiers = { next: uuid };
const passing: RenderValidator = {
  async validate(version: ItemVersion) {
    return { itemVersionId: version.versionId, surfacesChecked: ['web'], failures: [] };
  },
};

function content(stem: string): AuthoredItemContent {
  return {
    stem: textBody(stem),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [{ conceptIdentityId: CONCEPT, taxonomyVersionId: TAXONOMY, weight: 1, isPrimary: true }],
    difficultyEstimate: 'moderate',
    provenance: originalProvenance(),
    licensing: { status: 'owned' },
  };
}

/** Drafts, reviews and publishes one single-answer item, fingerprinting it while it is in review, as content does. */
async function publish(stem: string): Promise<Item> {
  const items = new PostgresItemRepository(database.pool);
  const shared = { clock, identifiers, audit: new InMemoryAuditRecorder(), idempotency: new InMemoryIdempotencyStore() };
  const draft = expectValue(await new CreateItemDraftHandler({ items, ...shared }).handle({ itemType: 'SINGLE_CORRECT_MCQ', content: content(stem) }, as(author)));
  const solutions = new PostgresSolutionRepository(database.pool);
  const deps = {
    items,
    assets: new PostgresMediaAssetRepository(database.pool),
    store: new InMemoryMediaStore(),
    stimuli: new PostgresStimulusRepository(database.pool),
    solutions,
    reviews: new PostgresReviewDecisionRepository(database.pool),
    renderer: passing,
    assignments: new PostgresReviewAssignmentRepository(database.pool),
    transactions: new PostgresTransactionRunner(database.pool),
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
  };
  const solution = expectValue(
    await new CreateSolutionDraftHandler({ solutions, items, ...shared }).handle(
      {
        itemId: draft.itemId,
        targetItemVersionId: draft.versions[0]!.versionId,
        subject: 'physics',
        content: {
          finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
          steps: [{ ordinal: 1, body: textBody('Resolve the weight along the incline.'), conceptRefs: [] }],
          distractorAnalyses: [{ optionId: 'a', misconception: textBody('Forgot to resolve the weight.') }],
          alternateApproaches: [],
        },
      },
      as(author),
    ),
  );
  expectValue(await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: solution.solutionId }, as(author)));
  expectValue(
    await new RecordSolutionReviewDecisionHandler(deps).handle(
      { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    ),
  );
  expectValue(
    await new PublishSolutionVersionHandler(deps).handle(
      { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId },
      as(ops),
    ),
  );
  expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: draft.itemId }, as(author)));
  // Content fingerprints what is in review; the duplicate signal assembly reads is what that wrote.
  expectValue(
    await new RefreshFingerprintsHandler({ items, fingerprints: new PostgresFingerprintRepository(database.pool) }).handle(
      { since: '2000-01-01T00:00:00.000Z', now: NOW.toISOString() },
      as(ops),
    ),
  );
  expectValue(
    await new RecordItemReviewDecisionHandler(deps).handle(
      { itemId: draft.itemId, itemVersionId: draft.versions[0]!.versionId, outcome: 'approve', candidatesShownIds: [] },
      as(reviewer),
    ),
  );
  return expectValue(
    await new PublishItemVersionHandler(deps).handle({ itemId: draft.itemId, itemVersionId: draft.versions[0]!.versionId }, as(ops)),
  );
}

const STEM_A = 'A block slides down a frictionless ramp. What is its acceleration?';

function seam() {
  return contentComposition.contentForAssessment({
    pool: database.pool,
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    principals: { resolve: () => null },
    mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
    idempotency: new InMemoryIdempotencyStore(),
    reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
  });
}

describe('assembly over content\'s real catalogue and content\'s own duplicate detection', () => {
  it('refuses to put an item and its retyped duplicate in one form, and builds the form that avoids the pair', async () => {
    const a = await publish(STEM_A);
    const b = await publish(STEM_A); // the same item retyped: content calls it an exact match
    const c = await publish('What is the SI unit of capacitance?');
    const d = await publish('State Kirchhoff\'s current law for a junction.');

    const anchors = new PostgresAnchorPoolRepository(database.pool);
    expectValue(await anchors.add(expectValue(addAnchorPoolMember({ itemVersionId: a.versions[0]!.versionId, exposureCap: 10, addedAt: '2026-10-01T00:00:00.000Z' }))));

    const offered = seam();
    const corpus = new ContentCorpus({
      catalogue: offered.listCatalogue as never,
      duplicates: offered.duplicates as never,
      anchors,
      exposure: new PostgresExposureLedger(database.pool),
    });
    const loaded = expectValue(await corpus.load({}, { principal: system, correlationId: 'c' }));

    expect(loaded.unevaluated).toEqual([]);
    expect(loaded.candidates.map((candidate) => candidate.itemId).sort()).toEqual([a, b, c, d].map((item) => item.itemId).sort());
    // content's detection found the pair, from both sides
    const versionOf = (item: Item) => item.versions[0]!.versionId;
    expect(loaded.nearDuplicates.get(versionOf(a))?.has(versionOf(b))).toBe(true);
    expect(loaded.nearDuplicates.get(versionOf(b))?.has(versionOf(a))).toBe(true);
    expect(loaded.nearDuplicates.get(versionOf(c))?.has(versionOf(a))).toBe(false);
    // the anchor is marked from the pool, with its cap
    expect(loaded.candidates.find((candidate) => candidate.itemId === a.itemId)).toMatchObject({ isAnchor: true, anchorExposureCap: 10 });

    // nothing of the key or the solution travelled
    const serialized = JSON.stringify(loaded.candidates);
    for (const leaked of ['correctOptionId', 'isCorrect', 'finalAnswer', 'Resolve the weight', 'Forgot to resolve', 'A block slides']) {
      expect(serialized, leaked).not.toContain(leaked);
    }

    const blueprint = expectValue(
      createBlueprint({
        examProfileVersionId: uuid(),
        formType: 'mock',
        totalMarks: 8,
        difficultyTolerance: 0,
        sections: [{ ordinal: 1, sectionSpecRef: 'physics', itemCount: 2, typeMix: { SINGLE_CORRECT_MCQ: 2 }, marksPerItem: 4, difficultyTarget: { moderate: 2 } }],
      }),
    );
    const request = {
      blueprint,
      candidates: loaded.candidates,
      exposure: loaded.exposure,
      nearDuplicates: loaded.nearDuplicates,
      newSlotId: (section: number, slot: number) => `00000000-0000-4000-b300-${(section * 100 + slot).toString(16).padStart(12, '0')}`,
    };
    const assembled = expectValue(assembleForm(request));
    const picked = assembled.sections[0]!.slots.map((slot) => slot.itemId);
    expect(picked.includes(a.itemId) && picked.includes(b.itemId)).toBe(false);
    expect(violatedConstraints(request, assembled.sections)).toEqual([]);

    // and when the pool has nothing but the pair, it is refused by name
    const onlyThePair = { ...request, candidates: loaded.candidates.filter((candidate) => candidate.itemId === a.itemId || candidate.itemId === b.itemId) };
    expect(expectError(assembleForm(onlyThePair)).constraint).toBe('NEAR_DUPLICATE');
  });

  it('is refused a catalogue to a principal content does not admit', async () => {
    const offered = seam();
    const refused = await offered.listCatalogue.handle({}, { principal: { kind: 'human', id: uuid(), roleContext: ['learner'] }, correlationId: 'c' });
    expect(expectError(refused).kind).toBe('Authorization');
  });
});
