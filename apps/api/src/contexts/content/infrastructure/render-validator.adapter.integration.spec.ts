import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../testing/content-fixtures.js';
import type { Item } from '../domain/item.js';
import type { PublicationError } from '../domain/publication-preconditions.js';
import { PostgresItemRepository } from './item.repository.js';
import { PostgresMediaAssetRepository } from './media-asset.repository.js';
import { PostgresReviewDecisionRepository } from './review-decision.repository.js';
import { PostgresSolutionRepository } from './solution.repository.js';
import { PostgresStimulusRepository } from './stimulus.repository.js';
import { RenderValidatorAdapter } from './render-validator.adapter.js';
import type { AuthoredItemContent } from '../application/commands/authoring-commands.js';
import type { ApplicationError } from '../application/authorization.js';
import { CreateItemDraftHandler, type ItemAuthoringDependencies } from '../application/handlers/authoring-handlers.js';
import { CreateSolutionDraftHandler, type SolutionAuthoringDependencies } from '../application/handlers/solution-handlers.js';
import {
  PublishItemVersionHandler,
  PublishSolutionVersionHandler,
  RecordItemReviewDecisionHandler,
  RecordSolutionReviewDecisionHandler,
  SubmitItemForReviewHandler,
  SubmitSolutionForReviewHandler,
  type LifecycleDependencies,
} from '../application/handlers/lifecycle-handlers.js';
import {
  InMemoryAuditRecorder,
  InMemoryIdempotencyStore,
  InMemoryMediaStore,
  InMemoryReviewProgress,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
} from '../application/ports.js';

/**
 * M0-09's own acceptance: the publication precondition (M3-11) was
 * previously fed by a test-supplied `RenderValidator` fact everywhere,
 * including `lifecycle-handlers.integration.spec.ts`'s `passingRenderer`.
 * This is the one spec where the real adapter drives that precondition
 * against real Postgres — closing the gap `application/ports.ts` named D27,
 * proven rather than asserted.
 */

let database: TestDatabase;
let items: PostgresItemRepository;
let solutions: PostgresSolutionRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  solutions = new PostgresSolutionRepository(database.pool);
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

const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();
const author: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['author', 'subject:physics'] };
const reviewer: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer', 'subject:physics'] };
const contentOps: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['content_ops'] };

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-1' });
const asOps = (): ApplicationContext => ({ principal: contentOps, correlationId: 'corr-1', stepUpSatisfied: true });

const NOW = new Date('2026-08-13T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: () => freshUuid() };
const renderer = new RenderValidatorAdapter();

function shared() {
  return { clock, identifiers, audit: new InMemoryAuditRecorder(), idempotency: new InMemoryIdempotencyStore() };
}

function lifecycle(): LifecycleDependencies {
  return {
    items,
    assets: new PostgresMediaAssetRepository(database.pool),
    store: new InMemoryMediaStore(),
    stimuli: new PostgresStimulusRepository(database.pool),
    solutions,
    reviews: new PostgresReviewDecisionRepository(database.pool),
    renderer,
    reviewProgress: new InMemoryReviewProgress(),
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
  };
}

function itemContent(overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [{ conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true }],
    difficultyEstimate: 'moderate',
    provenance: originalProvenance(),
    licensing: { status: 'owned' },
    ...overrides,
  };
}

async function draftItem(overrides: Partial<AuthoredItemContent> = {}): Promise<Item> {
  return expectValue(
    await new CreateItemDraftHandler({ items, ...shared() } satisfies ItemAuthoringDependencies).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: itemContent(overrides) },
      as(author),
    ),
  );
}

async function publishedSolutionFor(item: Item, deps: LifecycleDependencies, correctOptionId = 'b'): Promise<void> {
  const solution = expectValue(
    await new CreateSolutionDraftHandler(
      { solutions, items, ...shared() } satisfies SolutionAuthoringDependencies,
    ).handle(
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
      asOps(),
    ),
  );
}

async function approved(item: Item, deps: LifecycleDependencies): Promise<Item> {
  expectValue(await new SubmitItemForReviewHandler(deps).handle({ itemId: item.itemId }, as(author)));
  return expectValue(
    await new RecordItemReviewDecisionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId, outcome: 'approve' },
      as(reviewer),
    ),
  );
}

function unmetCodes(error: ApplicationError): readonly string[] {
  return (error.detail as PublicationError['unmet']).map((failure) => failure.code);
}

describe('publication against the real RenderValidatorAdapter (closes D27)', () => {
  it('publishes a renderable item end to end, no test-supplied render fact involved', async () => {
    const deps = lifecycle();
    const item = await draftItem();
    await publishedSolutionFor(item, deps);
    await approved(item, deps);

    const published = expectValue(
      await new PublishItemVersionHandler(deps).handle(
        { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
        asOps(),
      ),
    );

    expect(published.lifecycleState).toBe('published');
  });

  it('refuses publication when the real renderer cannot render the stem on any surface (FR-QM-14 rule 2)', async () => {
    const deps = lifecycle();
    // A domain-valid MathBlock — non-blank latex, non-blank textAlternative,
    // so nothing about authoring it is refused — whose LaTeX the renderer
    // itself cannot draw. Unlike an unknown block kind (rejected at
    // construction, so it could never reach a real render), unrenderable
    // notation is exactly the class of failure D27's adapter exists to
    // catch: valid per the domain, unrenderable per the renderer.
    const item = await draftItem({
      stem: {
        schemaVersion: 1,
        blocks: [{ kind: 'MATH_BLOCK', latex: '\\wormhole', textAlternative: 'a wormhole' }],
      },
    });
    await publishedSolutionFor(item, deps);
    await approved(item, deps);

    const refused = await new PublishItemVersionHandler(deps).handle(
      { itemId: item.itemId, itemVersionId: item.versions[0]!.versionId },
      asOps(),
    );

    expect(unmetCodes(expectError(refused))).toContain('RENDER_FAILED');
  });
});
