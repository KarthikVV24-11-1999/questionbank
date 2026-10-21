import type { PrincipalRef } from '@questionbank/domain-types';
import type { Pool } from 'pg';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore, InMemoryMediaStore, type ApplicationContext, type RenderValidator } from '../contexts/content/application/ports.js';
import type { AuthoredItemContent } from '../contexts/content/application/commands/authoring-commands.js';
import { CreateItemDraftHandler } from '../contexts/content/application/handlers/authoring-handlers.js';
import { CreateSolutionDraftHandler } from '../contexts/content/application/handlers/solution-handlers.js';
import {
  PublishItemVersionHandler,
  PublishSolutionVersionHandler,
  RecordItemReviewDecisionHandler,
  RecordSolutionReviewDecisionHandler,
  SubmitItemForReviewHandler,
  SubmitSolutionForReviewHandler,
} from '../contexts/content/application/handlers/lifecycle-handlers.js';
import { RefreshFingerprintsHandler } from '../contexts/content/application/review/handlers/fingerprint-handlers.js';
import type { Item } from '../contexts/content/domain/item.js';
import type { ItemVersion } from '../contexts/content/domain/item-version.js';
import { PostgresItemRepository } from '../contexts/content/infrastructure/item.repository.js';
import { PostgresFingerprintRepository } from '../contexts/content/infrastructure/review/fingerprint.repository.js';
import { PostgresMediaAssetRepository } from '../contexts/content/infrastructure/media-asset.repository.js';
import { PostgresReviewDecisionRepository } from '../contexts/content/infrastructure/review-decision.repository.js';
import { PostgresReviewAssignmentRepository } from '../contexts/content/infrastructure/review/review-assignment.repository.js';
import { PostgresSolutionRepository } from '../contexts/content/infrastructure/solution.repository.js';
import { PostgresStimulusRepository } from '../contexts/content/infrastructure/stimulus.repository.js';
import { PostgresTransactionRunner } from '../contexts/content/infrastructure/transaction-runner.js';
import { originalProvenance, singleCorrectSpec, textBody } from './content-fixtures.js';
import { expectValue } from './expect-result.js';

/**
 * Publishes real items through content's own handlers — draft, solution, review,
 * fingerprint, publish — so a spec outside content has a real catalogue to read.
 * Nothing here writes a content table directly.
 */
export const uuid = (() => {
  let seed = 0;
  return () => {
    seed += 1;
    return `00000000-0000-4000-b200-${seed.toString(16).padStart(12, '0')}`;
  };
})();

export const author: PrincipalRef = { kind: 'human', id: uuid(), roleContext: ['author', 'subject:physics'] };
export const reviewer: PrincipalRef = { kind: 'human', id: uuid(), roleContext: ['reviewer'] };
export const ops: PrincipalRef = { kind: 'human', id: uuid(), roleContext: ['content_ops'] };
export const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c', ...(principal === ops ? { stepUpSatisfied: true } : {}) });

export const CONCEPT = uuid();
export const TAXONOMY = uuid();
export const PUBLISH_NOW = new Date('2026-10-21T09:00:00.000Z');
const clock = { now: () => PUBLISH_NOW };
const identifiers = { next: uuid };
const passing: RenderValidator = {
  async validate(version: ItemVersion) {
    return { itemVersionId: version.versionId, surfacesChecked: ['web'], failures: [] };
  },
};

export function itemContent(stem: string, difficulty: AuthoredItemContent['difficultyEstimate'] = 'moderate'): AuthoredItemContent {
  return {
    stem: textBody(stem),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [{ conceptIdentityId: CONCEPT, taxonomyVersionId: TAXONOMY, weight: 1, isPrimary: true }],
    difficultyEstimate: difficulty,
    provenance: originalProvenance(),
    licensing: { status: 'owned' },
  };
}

/** What the solution says, so a scan can look for it. */
export const SOLUTION_TEXT = 'Resolve the weight along the incline.';
export const MISCONCEPTION_TEXT = 'Forgot to resolve the weight.';

/** Drafts, reviews and publishes one single-answer item, fingerprinting it while it is in review, as content does. */
export async function publishItem(pool: Pool, content: AuthoredItemContent): Promise<Item> {
  const items = new PostgresItemRepository(pool);
  const shared = { clock, identifiers, audit: new InMemoryAuditRecorder(), idempotency: new InMemoryIdempotencyStore() };
  const draft = expectValue(await new CreateItemDraftHandler({ items, ...shared }).handle({ itemType: 'SINGLE_CORRECT_MCQ', content }, as(author)));
  const solutions = new PostgresSolutionRepository(pool);
  const deps = {
    items,
    assets: new PostgresMediaAssetRepository(pool),
    store: new InMemoryMediaStore(),
    stimuli: new PostgresStimulusRepository(pool),
    solutions,
    reviews: new PostgresReviewDecisionRepository(pool),
    renderer: passing,
    assignments: new PostgresReviewAssignmentRepository(pool),
    transactions: new PostgresTransactionRunner(pool),
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
          steps: [{ ordinal: 1, body: textBody(SOLUTION_TEXT), conceptRefs: [] }],
          distractorAnalyses: [{ optionId: 'a', misconception: textBody(MISCONCEPTION_TEXT) }],
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
    await new RefreshFingerprintsHandler({ items, fingerprints: new PostgresFingerprintRepository(pool) }).handle(
      { since: '2000-01-01T00:00:00.000Z', now: PUBLISH_NOW.toISOString() },
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
