import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  aiProvenance,
  originalProvenance,
  singleCorrectSpec,
  textBody,
} from '../../../testing/content-fixtures.js';
import type { Result } from '../domain/result.js';
import { transitionItem, type Item } from '../domain/item.js';
import type { ItemVersion } from '../domain/item-version.js';
import { createReviewDecision } from '../domain/review-decision.js';
import { transitionMediaAsset } from '../domain/media-asset.js';
import { RegisterMediaAssetHandler } from './handlers/media-handlers.js';
import { transitionSolution, type Solution } from '../domain/solution.js';
import { transitionStimulus, type Stimulus } from '../domain/stimulus.js';
import type { PublicationError } from '../domain/publication-preconditions.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import { PostgresMediaAssetRepository } from '../infrastructure/media-asset.repository.js';
import { PostgresReviewDecisionRepository } from '../infrastructure/review-decision.repository.js';
import { PostgresSolutionRepository } from '../infrastructure/solution.repository.js';
import { PostgresStimulusRepository } from '../infrastructure/stimulus.repository.js';
import type { ApplicationError } from './authorization.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';
import {
  CreateItemDraftHandler,
  UpdateItemDraftHandler,
  type ItemAuthoringDependencies,
} from './handlers/authoring-handlers.js';
import {
  CreateSolutionDraftHandler,
  type SolutionAuthoringDependencies,
} from './handlers/solution-handlers.js';
import {
  CreateStimulusDraftHandler,
  type StimulusAuthoringDependencies,
} from './handlers/stimulus-handlers.js';
import {
  PublishItemVersionHandler,
  PublishSolutionVersionHandler,
  PublishStimulusVersionHandler,
  RecordItemReviewDecisionHandler,
  RecordSolutionReviewDecisionHandler,
  RecordStimulusReviewDecisionHandler,
  RetireItemHandler,
  RetireStimulusHandler,
  PublishMediaAssetVersionHandler,
  RecordMediaAssetReviewDecisionHandler,
  SubmitItemForReviewHandler,
  SubmitMediaAssetForReviewHandler,
  SubmitSolutionForReviewHandler,
  SubmitStimulusForReviewHandler,
  SuspendItemHandler,
  WithdrawItemFromReviewHandler,
  type LifecycleDependencies,
} from './handlers/lifecycle-handlers.js';
import {
  InMemoryAuditRecorder,
  InMemoryIdempotencyStore,
  InMemoryMediaStore,
  InMemoryReviewProgress,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
  type RenderValidator,
} from './ports.js';

/**
 * DEC-1's load-bearing criterion, end to end against a real database:
 * publication is blocked without tags, provenance, resolved licensing, a
 * solution, a reviewer signature and a valid answer specification, and every
 * one of those checks lives in the domain.
 */

let database: TestDatabase;
let items: PostgresItemRepository;
let stimuli: PostgresStimulusRepository;
let solutions: PostgresSolutionRepository;
let assets: PostgresMediaAssetRepository;
let reviews: PostgresReviewDecisionRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  stimuli = new PostgresStimulusRepository(database.pool);
  solutions = new PostgresSolutionRepository(database.pool);
  assets = new PostgresMediaAssetRepository(database.pool);
  reviews = new PostgresReviewDecisionRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-e000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();
const REVIEWER_ID = freshUuid();
const OPS_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();

const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author', 'subject:physics'] };
const reviewer: PrincipalRef = { kind: 'human', id: REVIEWER_ID, roleContext: ['reviewer', 'subject:physics'] };
const contentOps: PrincipalRef = { kind: 'human', id: OPS_ID, roleContext: ['content_ops'] };
const learner: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['learner'] };

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-1' });
const asOps = (): ApplicationContext => ({ principal: contentOps, correlationId: 'corr-1', stepUpSatisfied: true });
type Refusal = Result<unknown, ApplicationError>;

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: () => freshUuid() };
const reviewProgress = new InMemoryReviewProgress();
const mediaStore = new InMemoryMediaStore();

const passingRenderer: RenderValidator = {
  async validate(version: ItemVersion) {
    return {
      itemVersionId: version.versionId,
      surfacesChecked: ['web', 'mobile', 'offline', 'print'],
      failures: [],
    };
  },
};

function shared() {
  return {
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
  };
}

function lifecycle(renderer: RenderValidator = passingRenderer): LifecycleDependencies & {
  readonly audit: InMemoryAuditRecorder;
} {
  return {
    items,
    assets,
    store: mediaStore,
    stimuli,
    solutions,
    reviews,
    renderer,
    reviewProgress,
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
  };
}

const itemBench = (): ItemAuthoringDependencies => ({ items, ...shared() });
const solutionBench = (): SolutionAuthoringDependencies => ({ solutions, items, ...shared() });
const stimulusBench = (): StimulusAuthoringDependencies => ({ stimuli, items, ...shared() });

function itemContent(overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [
      { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
    ],
    difficultyEstimate: 'moderate',
    provenance: originalProvenance(),
    licensing: { status: 'owned' },
    ...overrides,
  };
}

async function draftItem(overrides: Partial<AuthoredItemContent> = {}): Promise<Item> {
  return expectValue(
    await new CreateItemDraftHandler(itemBench()).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: itemContent(overrides) },
      as(author),
    ),
  );
}

/** A published solution for the item's first version — INV-08's precondition. */
async function publishedSolutionFor(item: Item, correctOptionId = 'b'): Promise<Solution> {
  const solution = expectValue(
    await new CreateSolutionDraftHandler(solutionBench()).handle(
      {
        itemId: item.itemId,
        targetItemVersionId: item.versions[0]!.versionId,
        subject: 'physics',
        content: {
          finalAnswerAssertion: { kind: 'OPTION', optionId: correctOptionId },
          steps: [{ ordinal: 1, body: textBody('Resolve the weight along the incline.'), conceptRefs: [] }],
        },
      },
      as(author),
    ),
  );

  const deps = lifecycle();
  expectValue(await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: solution.solutionId }, as(author)));
  expectValue(
    await new RecordSolutionReviewDecisionHandler(deps).handle(
      {
        solutionId: solution.solutionId,
        solutionVersionId: solution.versions[0]!.versionId,
        outcome: 'approve',
      },
      as(reviewer),
    ),
  );
  return expectValue(
    await new PublishSolutionVersionHandler(deps).handle(
      { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId },
      asOps(),
    ),
  );
}

/** Moves an item to `approved` through the real review path. */
async function approved(item: Item, deps = lifecycle()): Promise<Item> {
  expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
  return expectValue(
    await new RecordItemReviewDecisionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    ),
  );
}

/**
 * The precondition list travels as structured detail, so the validation panel
 * groups by code rather than reading a message.
 */
function unmetCodes(error: ApplicationError): readonly string[] {
  return (error.detail as PublicationError['unmet']).map((failure) => failure.code);
}

/** Puts an item in `approved` without any decision having been recorded. */
function placeInApproved(item: Item): Item {
  const submitted = expectValue(transitionItem(item, { transition: 'submit_for_review' }));
  return expectValue(transitionItem(submitted, { transition: 'approve' }));
}

describe('the whole path from draft to published', () => {
  it('publishes an item that satisfies every precondition', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);

    const published = expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );

    expect(published.lifecycleState).toBe('published');
    expect(published.currentPublishedVersionId).toBe(item.versions[0]!.versionId);

    const loaded = expectValue(await items.findPublishedVersion(item.itemId));
    expect(loaded.versionId).toBe(item.versions[0]!.versionId);
  });

  it('audits every transition on the way', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);
    expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );

    expect(deps.audit.entries.map((entry) => entry.action)).toEqual([
      'SubmitItemForReview',
      'RecordItemReviewDecision',
      'PublishItemVersion',
    ]);
    for (const entry of deps.audit.entries) {
      expect(entry.targetContext).toBe('content');
      expect(entry.principal.id).toBeTruthy();
      expect(entry.correlationId).toBe('corr-1');
    }
  });

  it('locks the draft against author edits from submission (FR-TCH-08 rule 1)', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));

    const refused = await new UpdateItemDraftHandler(itemBench()).handle(
      { itemId: item.itemId, content: itemContent(), idempotencyKey: 'k' },
      as(author),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_EDITABLE');
  });

  it('returns a changes-requested item to the author, who can edit it again', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
    const returned = expectValue(
      await new RecordItemReviewDecisionHandler(deps).handle(
        {
          itemId: item.itemId,
          itemVersionId: item.versions[0]!.versionId,
          outcome: 'request_changes',
          justification: 'the stem does not say the ramp is frictionless',
        },
        as(reviewer),
      ),
    );
    expect(returned.lifecycleState).toBe('changes_requested');

    expectValue(
      await new UpdateItemDraftHandler(itemBench()).handle(
        { itemId: item.itemId, content: itemContent({ difficultyEstimate: 'challenging' }), idempotencyKey: 'k' },
        as(author),
      ),
    );
  });

  it('refuses a decision with no justification when work is sent back', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));

    const refused = await new RecordItemReviewDecisionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'reject' },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('JUSTIFICATION_REQUIRED');
  });

  it('refuses a self-review at the decision (INV-12)', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));

    const refused = await new RecordItemReviewDecisionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve' },
      as({ ...author, roleContext: ['reviewer', 'author'] }),
    );
    expect(expectError(refused).code).toBe('REVIEWER_IS_AUTHOR');
  });

  it('keeps the decision history rather than overwriting it', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    const versionId = item.versions[0]!.versionId;
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
    expectValue(
      await new RecordItemReviewDecisionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: versionId, outcome: 'request_changes', justification: 'unclear' },
        as(reviewer),
      ),
    );
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
    expectValue(
      await new RecordItemReviewDecisionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: versionId, outcome: 'approve' },
        as(reviewer),
      ),
    );

    const history = expectValue(await reviews.findAllFor('item_version', versionId));
    expect(history).toHaveLength(2);
    expect(expectValue(await reviews.findApprovalFor('item_version', versionId)).outcome).toBe('approve');
  });
});

describe('publication is refused for each unmet precondition', () => {
  it('reports every unmet precondition at once, not the first', async () => {
    const deps = lifecycle();
    // No licensing statement, no solution, and no signature.
    const item = await draftItem({ licensing: { status: 'unresolved' } });
    expectValue(await items.save(placeInApproved(item)));

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    const error = expectError(refused);
    expect(error.code).toBe('PUBLICATION_PRECONDITIONS_UNMET');
    expect(unmetCodes(error)).toEqual(
      expect.arrayContaining(['LICENSING_NOT_RESOLVED', 'REVIEWER_SIGNATURE_MISSING', 'SOLUTION_MISSING']),
    );
  });

  it('refuses without a reviewer signature, however the item reached approved', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    expectValue(await items.save(placeInApproved(item)));

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('REVIEWER_SIGNATURE_MISSING');
  });

  it('refuses when the recorded signature is the version’s own author (INV-12)', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    expectValue(await items.save(placeInApproved(item)));
    // Written straight to the record: the handler refuses a self-review, and
    // the precondition must refuse it too, or the guarantee depends on one
    // code path staying correct.
    expectValue(
      await reviews.record(
        expectValue(
          createReviewDecision({
            decisionId: freshUuid(),
            ownerType: 'item_version',
            ownerVersionId: item.versions[0]!.versionId,
            reviewer: author,
            outcome: 'approve',
            decidedAt: NOW.toISOString(),
          }),
        ),
      ),
    );

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('REVIEWER_IS_AUTHOR');
  });

  it('refuses AI-sourced content signed by a machine (INV-01)', async () => {
    const deps = lifecycle();
    // The generation identifiers are `uuid` columns, so the shared fixture's
    // readable ones cannot be stored.
    const item = await draftItem({
      provenance: aiProvenance({
        modelVersionId: freshUuid(),
        promptVersionId: freshUuid(),
        generationRunId: freshUuid(),
      }),
    });
    await publishedSolutionFor(item);
    expectValue(await items.save(placeInApproved(item)));
    expectValue(
      await reviews.record(
        expectValue(
          createReviewDecision({
            decisionId: freshUuid(),
            ownerType: 'item_version',
            ownerVersionId: item.versions[0]!.versionId,
            reviewer: { kind: 'ai_agent', id: freshUuid(), roleContext: ['reviewer'] },
            outcome: 'approve',
            decidedAt: NOW.toISOString(),
          }),
        ),
      ),
    );

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('AI_CONTENT_NOT_HUMAN_REVIEWED');
  });

  it('refuses without a published solution (INV-08)', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await approved(item, deps);

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('SOLUTION_MISSING');
  });

  // The case D5 exists for: the solution was right when it was written, and
  // the author then changed the key underneath it.
  it('refuses when the key changed after the solution was published', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);

    expectValue(
      await new UpdateItemDraftHandler(itemBench()).handle(
        {
          itemId: item.itemId,
          content: itemContent({ responseSpec: singleCorrectSpec({ correctOptionId: 'c' }) }),
          idempotencyKey: 'key-changed',
        },
        as(author),
      ),
    );
    await approved(item, deps);

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('SOLUTION_DISAGREES_WITH_KEY');
  });

  it('refuses when licensing is unresolved', async () => {
    const deps = lifecycle();
    const item = await draftItem({ licensing: { status: 'unresolved' } });
    await publishedSolutionFor(item);
    await approved(item, deps);

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('LICENSING_NOT_RESOLVED');
  });

  it('refuses when the licence has expired at the supplied instant', async () => {
    const deps = lifecycle();
    const item = await draftItem({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'NCERT',
        expiresAt: '2026-01-01T00:00:00.000Z',
      },
    });
    await publishedSolutionFor(item);
    await approved(item, deps);

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('LICENSING_NOT_RESOLVED');
  });

  it('refuses when a surface fails to render (FR-QM-14 rule 2)', async () => {
    const failing: RenderValidator = {
      async validate(version: ItemVersion) {
        return {
          itemVersionId: version.versionId,
          surfacesChecked: ['web', 'mobile', 'offline', 'print'],
          failures: ['print: blocks[0] notation does not render'],
        };
      },
    };
    const deps = lifecycle(failing);
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('RENDER_FAILED');
  });

  it('refuses a verdict that is not about this version', async () => {
    const misdirected: RenderValidator = {
      async validate() {
        return { itemVersionId: 'some-other-version', surfacesChecked: ['web'], failures: [] };
      },
    };
    const deps = lifecycle(misdirected);
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(unmetCodes(expectError(refused))).toContain('RENDER_VERDICT_MISSING');
  });

  it('reports a version the item does not hold', async () => {
    const item = await draftItem();
    const refused = await new PublishItemVersionHandler(lifecycle()).handle(
      { itemId: item.itemId, itemVersionId: freshUuid() },
      asOps(),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_FOUND');
  });

  it('leaves the item unpublished after every refusal', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await approved(item, deps);
    await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );

    const loaded = expectValue(await items.findById(item.itemId));
    expect(loaded.lifecycleState).toBe('approved');
    expect(loaded.currentPublishedVersionId).toBeUndefined();
  });
});

describe('withdrawal (FR-TCH-08 rule 2)', () => {
  it('is permitted before a reviewer has started', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));

    const withdrawn = expectValue(
      await new WithdrawItemFromReviewHandler(deps).handle({ itemId: item.itemId }, as(author)),
    );
    expect(withdrawn.lifecycleState).toBe('draft');
  });

  it('is refused once review has begun', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
    reviewProgress.claim(item.versions[0]!.versionId);

    const refused = await new WithdrawItemFromReviewHandler(deps).handle({ itemId: item.itemId }, as(author));
    expect(expectError(refused).code).toBe('REVIEW_ALREADY_BEGUN');
  });

  it('is refused for an item that is not in review at all', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    const refused = await new WithdrawItemFromReviewHandler(deps).handle({ itemId: item.itemId }, as(author));
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });
});

describe('suspension and retirement', () => {
  async function publishedItem(): Promise<Item> {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);
    return expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );
  }

  it('suspends a published item, keeping the version it published', async () => {
    const item = await publishedItem();
    const suspended = expectValue(
      await new SuspendItemHandler(lifecycle()).handle(
        { itemId: item.itemId, justification: 'defect report under investigation' },
        asOps(),
      ),
    );
    expect(suspended.lifecycleState).toBe('suspended');
    expect(suspended.currentPublishedVersionId).toBe(item.currentPublishedVersionId);
  });

  it('retires with a categorized reason and refuses without one', async () => {
    const item = await publishedItem();
    const deps = lifecycle();

    const refused = await new RetireItemHandler(deps).handle(
      { itemId: item.itemId, retirementReason: '   ' },
      asOps(),
    );
    expect(expectError(refused).code).toBe('RETIREMENT_REASON_REQUIRED');

    const retired = expectValue(
      await new RetireItemHandler(deps).handle(
        { itemId: item.itemId, retirementReason: 'syllabus removed this concept' },
        asOps(),
      ),
    );
    expect(retired.lifecycleState).toBe('retired');
    expect(retired.retirementReason).toBe('syllabus removed this concept');
  });

  it('refuses to suspend something that was never published', async () => {
    const item = await draftItem();
    const refused = await new SuspendItemHandler(lifecycle()).handle(
      { itemId: item.itemId, justification: 'x' },
      asOps(),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });

  it('reports an item that does not exist', async () => {
    const deps = lifecycle();
    const refusals: readonly Refusal[] = [
      await new SubmitItemForReviewHandler(deps).handle({ itemId: freshUuid() }, as(author)),
      await new WithdrawItemFromReviewHandler(deps).handle({ itemId: freshUuid() }, as(author)),
      await new RecordItemReviewDecisionHandler(deps).handle(
        { itemId: freshUuid(), itemVersionId: freshUuid(), outcome: 'approve' },
        as(reviewer),
      ),
      await new PublishItemVersionHandler(deps).handle(
        { itemId: freshUuid(), itemVersionId: freshUuid() },
        asOps(),
      ),
      await new SuspendItemHandler(deps).handle({ itemId: freshUuid(), justification: 'x' }, asOps()),
      await new RetireItemHandler(deps).handle({ itemId: freshUuid(), retirementReason: 'x' }, asOps()),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).kind).toBe('NotFound');
    }
  });
});

describe('the stimulus lifecycle', () => {
  async function draftStimulus(): Promise<Stimulus> {
    return expectValue(
      await new CreateStimulusDraftHandler(stimulusBench()).handle(
        {
          stimulusType: 'passage',
          subject: 'physics',
          body: textBody('A 2 kg block rests on a 30° incline.'),
          licensing: { status: 'owned' },
        },
        as(author),
      ),
    );
  }

  it('publishes a stimulus that carries an approval', async () => {
    const deps = lifecycle();
    const stimulus = await draftStimulus();
    expectValue(
      await new SubmitStimulusForReviewHandler(deps).handle({ stimulusId: stimulus.stimulusId }, as(author)),
    );
    expectValue(
      await new RecordStimulusReviewDecisionHandler(deps).handle(
        {
          stimulusId: stimulus.stimulusId,
          stimulusVersionId: stimulus.versions[0]!.versionId,
          outcome: 'approve',
        },
        as(reviewer),
      ),
    );
    const published = expectValue(
      await new PublishStimulusVersionHandler(deps).handle(
        { stimulusId: stimulus.stimulusId, stimulusVersionId: stimulus.versions[0]!.versionId },
        asOps(),
      ),
    );
    expect(published.lifecycleState).toBe('published');
    expect(published.currentPublishedVersionId).toBe(stimulus.versions[0]!.versionId);
  });

  it('refuses publication of a stimulus version nobody approved', async () => {
    const deps = lifecycle();
    const stimulus = await draftStimulus();
    const readied = expectValue(
      transitionStimulus(
        expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    expectValue(await stimuli.save(readied));

    const refused = await new PublishStimulusVersionHandler(deps).handle(
      { stimulusId: stimulus.stimulusId, stimulusVersionId: stimulus.versions[0]!.versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('REVIEWER_SIGNATURE_MISSING');
  });

  it('refuses retirement while a published item pins it (FR-TCH-03 rule 3)', async () => {
    const deps = lifecycle();
    const stimulus = await draftStimulus();
    expectValue(
      await new SubmitStimulusForReviewHandler(deps).handle({ stimulusId: stimulus.stimulusId }, as(author)),
    );
    expectValue(
      await new RecordStimulusReviewDecisionHandler(deps).handle(
        {
          stimulusId: stimulus.stimulusId,
          stimulusVersionId: stimulus.versions[0]!.versionId,
          outcome: 'approve',
        },
        as(reviewer),
      ),
    );
    expectValue(
      await new PublishStimulusVersionHandler(deps).handle(
        { stimulusId: stimulus.stimulusId, stimulusVersionId: stimulus.versions[0]!.versionId },
        asOps(),
      ),
    );

    const item = await draftItem({ stimulusVersionRef: stimulus.versions[0]!.versionId });
    await publishedSolutionFor(item);
    await approved(item, deps);
    expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );

    const refused = await new RetireStimulusHandler(deps).handle(
      { stimulusId: stimulus.stimulusId, retirementReason: 'no longer used' },
      asOps(),
    );
    expect(expectError(refused).code).toBe('STILL_REFERENCED');
  });

  it('refuses a self-review on a stimulus version', async () => {
    const deps = lifecycle();
    const stimulus = await draftStimulus();
    expectValue(
      await new SubmitStimulusForReviewHandler(deps).handle({ stimulusId: stimulus.stimulusId }, as(author)),
    );
    const refused = await new RecordStimulusReviewDecisionHandler(deps).handle(
      {
        stimulusId: stimulus.stimulusId,
        stimulusVersionId: stimulus.versions[0]!.versionId,
        outcome: 'approve',
      },
      as({ ...author, roleContext: ['reviewer'] }),
    );
    expect(expectError(refused).code).toBe('REVIEWER_IS_AUTHOR');
  });

  it('reports a stimulus version the stimulus does not hold', async () => {
    const deps = lifecycle();
    const stimulus = await draftStimulus();
    const refused = await new RecordStimulusReviewDecisionHandler(deps).handle(
      { stimulusId: stimulus.stimulusId, stimulusVersionId: freshUuid(), outcome: 'approve' },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_FOUND');
  });

  it('reports a stimulus that does not exist', async () => {
    const deps = lifecycle();
    const refusals: readonly Refusal[] = [
      await new SubmitStimulusForReviewHandler(deps).handle({ stimulusId: freshUuid() }, as(author)),
      await new RecordStimulusReviewDecisionHandler(deps).handle(
        { stimulusId: freshUuid(), stimulusVersionId: freshUuid(), outcome: 'approve' },
        as(reviewer),
      ),
      await new PublishStimulusVersionHandler(deps).handle(
        { stimulusId: freshUuid(), stimulusVersionId: freshUuid() },
        asOps(),
      ),
      await new RetireStimulusHandler(deps).handle(
        { stimulusId: freshUuid(), retirementReason: 'x' },
        asOps(),
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).kind).toBe('NotFound');
    }
  });
});

describe('the solution lifecycle', () => {
  it('refuses publication of a solution version nobody approved', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    const solution = expectValue(
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [{ ordinal: 1, body: textBody('one step'), conceptRefs: [] }],
          },
        },
        as(author),
      ),
    );
    expectValue(
      await solutions.save(
        expectValue(
          transitionSolution(
            expectValue(transitionSolution(solution, { transition: 'submit_for_review' })),
            { transition: 'approve' },
          ),
        ),
      ),
    );

    const refused = await new PublishSolutionVersionHandler(deps).handle(
      { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('REVIEWER_SIGNATURE_MISSING');
  });

  it('refuses publication when the key moved after approval', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    const solution = expectValue(
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [{ ordinal: 1, body: textBody('one step'), conceptRefs: [] }],
          },
        },
        as(author),
      ),
    );
    expectValue(
      await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: solution.solutionId }, as(author)),
    );
    expectValue(
      await new RecordSolutionReviewDecisionHandler(deps).handle(
        {
          solutionId: solution.solutionId,
          solutionVersionId: solution.versions[0]!.versionId,
          outcome: 'approve',
        },
        as(reviewer),
      ),
    );

    expectValue(
      await new UpdateItemDraftHandler(itemBench()).handle(
        {
          itemId: item.itemId,
          content: itemContent({ responseSpec: singleCorrectSpec({ correctOptionId: 'd' }) }),
          idempotencyKey: 'moved',
        },
        as(author),
      ),
    );

    const refused = await new PublishSolutionVersionHandler(deps).handle(
      { solutionId: solution.solutionId, solutionVersionId: solution.versions[0]!.versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('SOLUTION_DISAGREES_WITH_KEY');
  });

  it('reports a solution version the solution does not hold', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    const solution = await publishedSolutionFor(item);

    for (const refused of [
      await new RecordSolutionReviewDecisionHandler(deps).handle(
        { solutionId: solution.solutionId, solutionVersionId: freshUuid(), outcome: 'approve' },
        as(reviewer),
      ),
      await new PublishSolutionVersionHandler(deps).handle(
        { solutionId: solution.solutionId, solutionVersionId: freshUuid() },
        asOps(),
      ),
    ]) {
      expect(expectError(refused).code).toBe('VERSION_NOT_FOUND');
    }
  });

  it('reports a solution that does not exist', async () => {
    const deps = lifecycle();
    const refusals: readonly Refusal[] = [
      await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: freshUuid() }, as(author)),
      await new RecordSolutionReviewDecisionHandler(deps).handle(
        { solutionId: freshUuid(), solutionVersionId: freshUuid(), outcome: 'approve' },
        as(reviewer),
      ),
      await new PublishSolutionVersionHandler(deps).handle(
        { solutionId: freshUuid(), solutionVersionId: freshUuid() },
        asOps(),
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).kind).toBe('NotFound');
    }
  });

  it('refuses a self-review on a solution version', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    const solution = expectValue(
      await new CreateSolutionDraftHandler(solutionBench()).handle(
        {
          itemId: item.itemId,
          targetItemVersionId: item.versions[0]!.versionId,
          subject: 'physics',
          content: {
            finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
            steps: [{ ordinal: 1, body: textBody('one step'), conceptRefs: [] }],
          },
        },
        as(author),
      ),
    );
    expectValue(
      await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: solution.solutionId }, as(author)),
    );

    const refused = await new RecordSolutionReviewDecisionHandler(deps).handle(
      {
        solutionId: solution.solutionId,
        solutionVersionId: solution.versions[0]!.versionId,
        outcome: 'approve',
      },
      as({ ...author, roleContext: ['reviewer'] }),
    );
    expect(expectError(refused).code).toBe('REVIEWER_IS_AUTHOR');
  });
});

describe('every transition is permission-gated', () => {
  it('refuses a learner on every transition', async () => {
    const deps = lifecycle();
    const learnerContext = as(learner);
    const refusals: readonly Refusal[] = [
      await new SubmitItemForReviewHandler(deps).handle({ itemId: 'x' }, learnerContext),
      await new WithdrawItemFromReviewHandler(deps).handle({ itemId: 'x' }, learnerContext),
      await new RecordItemReviewDecisionHandler(deps).handle(
        { itemId: 'x', itemVersionId: 'v', outcome: 'approve' },
        learnerContext,
      ),
      await new PublishItemVersionHandler(deps).handle({ itemId: 'x', itemVersionId: 'v' }, learnerContext),
      await new SuspendItemHandler(deps).handle({ itemId: 'x', justification: 'j' }, learnerContext),
      await new RetireItemHandler(deps).handle({ itemId: 'x', retirementReason: 'r' }, learnerContext),
      await new SubmitStimulusForReviewHandler(deps).handle({ stimulusId: 'x' }, learnerContext),
      await new RecordStimulusReviewDecisionHandler(deps).handle(
        { stimulusId: 'x', stimulusVersionId: 'v', outcome: 'approve' },
        learnerContext,
      ),
      await new PublishStimulusVersionHandler(deps).handle(
        { stimulusId: 'x', stimulusVersionId: 'v' },
        learnerContext,
      ),
      await new RetireStimulusHandler(deps).handle({ stimulusId: 'x', retirementReason: 'r' }, learnerContext),
      await new SubmitSolutionForReviewHandler(deps).handle({ solutionId: 'x' }, learnerContext),
      await new RecordSolutionReviewDecisionHandler(deps).handle(
        { solutionId: 'x', solutionVersionId: 'v', outcome: 'approve' },
        learnerContext,
      ),
      await new PublishSolutionVersionHandler(deps).handle(
        { solutionId: 'x', solutionVersionId: 'v' },
        learnerContext,
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).code).toBe('NOT_PERMITTED');
    }
  });

  it('refuses an author acting as reviewer, and a reviewer publishing', async () => {
    const deps = lifecycle();
    expect(
      expectError(
        await new RecordItemReviewDecisionHandler(deps).handle(
          { itemId: 'x', itemVersionId: 'v', outcome: 'approve' },
          as(author),
        ),
      ).code,
    ).toBe('NOT_PERMITTED');
    expect(
      expectError(
        await new PublishItemVersionHandler(deps).handle({ itemId: 'x', itemVersionId: 'v' }, as(reviewer)),
      ).code,
    ).toBe('NOT_PERMITTED');
  });

  it('refuses publication and retirement without step-up', async () => {
    const deps = lifecycle();
    const withoutStepUp = as(contentOps);
    const refusals: readonly Refusal[] = [
      await new PublishItemVersionHandler(deps).handle({ itemId: 'x', itemVersionId: 'v' }, withoutStepUp),
      await new RetireItemHandler(deps).handle({ itemId: 'x', retirementReason: 'r' }, withoutStepUp),
      await new PublishStimulusVersionHandler(deps).handle(
        { stimulusId: 'x', stimulusVersionId: 'v' },
        withoutStepUp,
      ),
      await new RetireStimulusHandler(deps).handle({ stimulusId: 'x', retirementReason: 'r' }, withoutStepUp),
      await new PublishSolutionVersionHandler(deps).handle(
        { solutionId: 'x', solutionVersionId: 'v' },
        withoutStepUp,
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).code).toBe('STEP_UP_REQUIRED');
    }
  });
});

describe('a publication emits its event in the same transaction (§9 rule 4)', () => {
  async function outboxRows(aggregateId: string) {
    const found = await database.pool.query<{
      event_type: string;
      aggregate_type: string;
      payload: Record<string, unknown>;
    }>(
      `SELECT event_type, aggregate_type, payload
         FROM platform.outbox_message WHERE aggregate_id = $1 ORDER BY occurred_at, event_type`,
      [aggregateId],
    );
    return found.rows;
  }

  it('writes ItemPublished when an item publishes', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);
    expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );

    const rows = await outboxRows(item.itemId);
    expect(rows.map((row) => row.event_type)).toEqual(['ItemPublished']);
    expect(rows[0]!.payload).toMatchObject({
      itemVersionId: item.versions[0]!.versionId,
      itemType: 'SINGLE_CORRECT_MCQ',
      sourceType: 'original',
      primaryConceptIdentityId: CONCEPT_ID,
      taxonomyVersionId: TAXONOMY_ID,
    });
  });

  // The event and the aggregate move together, so a refused publication leaves
  // nothing behind claiming an item reached students.
  it('writes nothing when the publication is refused', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await approved(item, deps);

    expectError(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );
    expect(await outboxRows(item.itemId)).toEqual([]);
  });

  // Supersession has no producer: publication is legal only from `approved`,
  // and an item refuses a new version in any state past draft. Recorded as
  // debt D25 rather than tested against a path that cannot exist.
  it('refuses to republish an item that is already published', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);
    expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
    expect(await outboxRows(item.itemId)).toHaveLength(1);
  });

  it('writes ItemSuspended and ItemRetired with the operator’s reason', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item);
    await approved(item, deps);
    expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );
    expectValue(
      await new SuspendItemHandler(deps).handle(
        { itemId: item.itemId, justification: 'defect report under investigation' },
        asOps(),
      ),
    );
    expectValue(
      await new RetireItemHandler(deps).handle(
        { itemId: item.itemId, retirementReason: 'syllabus removed this concept' },
        asOps(),
      ),
    );

    const rows = await outboxRows(item.itemId);
    expect(rows.map((row) => row.event_type)).toEqual([
      'ItemPublished',
      'ItemRetired',
      'ItemSuspended',
    ]);
    const suspended = rows.find((row) => row.event_type === 'ItemSuspended')!;
    expect(suspended.payload['reason']).toBe('defect report under investigation');
    const retired = rows.find((row) => row.event_type === 'ItemRetired')!;
    expect(retired.payload['retirementReason']).toBe('syllabus removed this concept');
  });

  it('writes StimulusPublished and SolutionPublished on their own aggregates', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    const solution = await publishedSolutionFor(item);

    const solutionRows = await outboxRows(solution.solutionId);
    expect(solutionRows.map((row) => row.event_type)).toEqual(['SolutionPublished']);
    expect(solutionRows[0]!.aggregate_type).toBe('Solution');
    // No explanation text on the bus.
    expect(JSON.stringify(solutionRows[0]!.payload)).not.toContain('steps');
  });
});

describe('the media asset lifecycle', () => {
  async function registeredAsset() {
    const stored = await mediaStore.put(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), 'image/png');
    const asset = expectValue(
      await new RegisterMediaAssetHandler({
        assets,
        store: mediaStore,
        clock,
        identifiers,
        audit: new InMemoryAuditRecorder(),
      }).handle(
        {
          assetType: 'diagram',
          subject: 'physics',
          version: {
            storageKey: stored.storageKey,
            mimeType: 'image/png',
            width: 800,
            height: 600,
            altText: 'A block on a ramp inclined at thirty degrees',
            longDescription: 'The ramp rises left to right at 30°.',
            licensing: { status: 'owned' },
          },
        },
        as(author),
      ),
    );
    return { asset, storageKey: stored.storageKey };
  }

  it('publishes an approved asset and emits MediaAssetPublished', async () => {
    const deps = lifecycle();
    const { asset } = await registeredAsset();
    const versionId = asset.versions[0]!.versionId;

    expectValue(await new SubmitMediaAssetForReviewHandler(deps).handle({ assetId: asset.assetId }, as(author)));
    expectValue(
      await new RecordMediaAssetReviewDecisionHandler(deps).handle(
        { assetId: asset.assetId, assetVersionId: versionId, outcome: 'approve' },
        as(reviewer),
      ),
    );
    const published = expectValue(
      await new PublishMediaAssetVersionHandler(deps).handle(
        { assetId: asset.assetId, assetVersionId: versionId },
        asOps(),
      ),
    );
    expect(published.lifecycleState).toBe('published');

    const rows = await database.pool.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM platform.outbox_message WHERE aggregate_id = $1`,
      [asset.assetId],
    );
    expect(rows.rows.map((row) => row.event_type)).toEqual(['MediaAssetPublished']);
    expect(rows.rows[0]!.payload).toMatchObject({ assetType: 'diagram', mimeType: 'image/png' });
  });

  // M3-27's checksum, doing the job it exists for.
  it('refuses to publish an asset whose object was replaced after review', async () => {
    const deps = lifecycle();
    const { asset, storageKey } = await registeredAsset();
    const versionId = asset.versions[0]!.versionId;

    expectValue(await new SubmitMediaAssetForReviewHandler(deps).handle({ assetId: asset.assetId }, as(author)));
    expectValue(
      await new RecordMediaAssetReviewDecisionHandler(deps).handle(
        { assetId: asset.assetId, assetVersionId: versionId, outcome: 'approve' },
        as(reviewer),
      ),
    );
    await mediaStore.replace(storageKey, new Uint8Array([0xff, 0xd8, 0xff]), 'image/png');

    const refused = await new PublishMediaAssetVersionHandler(deps).handle(
      { assetId: asset.assetId, assetVersionId: versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('CHECKSUM_MISMATCH');
    expect(expectValue(await assets.findById(asset.assetId)).lifecycleState).toBe('approved');
  });

  it('refuses to publish an asset version nobody approved', async () => {
    const deps = lifecycle();
    const { asset } = await registeredAsset();
    const versionId = asset.versions[0]!.versionId;
    expectValue(await new SubmitMediaAssetForReviewHandler(deps).handle({ assetId: asset.assetId }, as(author)));
    expectValue(
      await assets.save(
        expectValue(
          transitionMediaAsset(expectValue(await assets.findById(asset.assetId)), { transition: 'approve' }),
        ),
      ),
    );

    const refused = await new PublishMediaAssetVersionHandler(deps).handle(
      { assetId: asset.assetId, assetVersionId: versionId },
      asOps(),
    );
    expect(expectError(refused).code).toBe('REVIEWER_SIGNATURE_MISSING');
  });

  it('refuses a self-review, an unknown version, and a missing asset', async () => {
    const deps = lifecycle();
    const { asset } = await registeredAsset();
    expectValue(await new SubmitMediaAssetForReviewHandler(deps).handle({ assetId: asset.assetId }, as(author)));

    expect(
      expectError(
        await new RecordMediaAssetReviewDecisionHandler(deps).handle(
          { assetId: asset.assetId, assetVersionId: asset.versions[0]!.versionId, outcome: 'approve' },
          as({ ...author, roleContext: ['reviewer'] }),
        ),
      ).code,
    ).toBe('REVIEWER_IS_AUTHOR');

    expect(
      expectError(
        await new RecordMediaAssetReviewDecisionHandler(deps).handle(
          { assetId: asset.assetId, assetVersionId: freshUuid(), outcome: 'approve' },
          as(reviewer),
        ),
      ).code,
    ).toBe('VERSION_NOT_FOUND');

    const missing: readonly Refusal[] = [
      await new SubmitMediaAssetForReviewHandler(deps).handle({ assetId: freshUuid() }, as(author)),
      await new RecordMediaAssetReviewDecisionHandler(deps).handle(
        { assetId: freshUuid(), assetVersionId: freshUuid(), outcome: 'approve' },
        as(reviewer),
      ),
      await new PublishMediaAssetVersionHandler(deps).handle(
        { assetId: freshUuid(), assetVersionId: freshUuid() },
        asOps(),
      ),
    ];
    for (const refused of missing) {
      expect(expectError(refused).kind).toBe('NotFound');
    }
  });

  it('refuses every media transition to a learner, and publication without step-up', async () => {
    const deps = lifecycle();
    const learnerContext = as(learner);
    const refusals: readonly Refusal[] = [
      await new SubmitMediaAssetForReviewHandler(deps).handle({ assetId: 'x' }, learnerContext),
      await new RecordMediaAssetReviewDecisionHandler(deps).handle(
        { assetId: 'x', assetVersionId: 'v', outcome: 'approve' },
        learnerContext,
      ),
      await new PublishMediaAssetVersionHandler(deps).handle(
        { assetId: 'x', assetVersionId: 'v' },
        learnerContext,
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).code).toBe('NOT_PERMITTED');
    }

    expect(
      expectError(
        await new PublishMediaAssetVersionHandler(deps).handle(
          { assetId: 'x', assetVersionId: 'v' },
          as(contentOps),
        ),
      ).code,
    ).toBe('STEP_UP_REQUIRED');
  });

  it('refuses a decision that sends an asset back with no justification', async () => {
    const deps = lifecycle();
    const { asset } = await registeredAsset();
    expectValue(await new SubmitMediaAssetForReviewHandler(deps).handle({ assetId: asset.assetId }, as(author)));

    const refused = await new RecordMediaAssetReviewDecisionHandler(deps).handle(
      { assetId: asset.assetId, assetVersionId: asset.versions[0]!.versionId, outcome: 'request_changes' },
      as(reviewer),
    );
    expect(expectError(refused).code).toBe('JUSTIFICATION_REQUIRED');
  });
});
