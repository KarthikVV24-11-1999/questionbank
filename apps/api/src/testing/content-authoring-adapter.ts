import type { Pool } from 'pg';
import type { CreateItemDraft, SubmitItemForReview } from '../contexts/content/public/index.js';
import type { ContentAuthoring, ApplicationContext } from '../contexts/generation/application/ports.js';
import { err, ok } from '../contexts/generation/domain/result.js';
import type { ApplicationError as GenerationApplicationError } from '../contexts/generation/application/authorization.js';
import { CreateItemDraftHandler } from '../contexts/content/application/handlers/authoring-handlers.js';
import { SubmitItemForReviewHandler } from '../contexts/content/application/handlers/lifecycle-handlers.js';
import {
  InMemoryAuditRecorder,
  InMemoryIdempotencyStore,
  InMemoryMediaStore,
  type Clock,
  type IdentifierFactory,
  type RenderValidator,
} from '../contexts/content/application/ports.js';
import { PostgresItemRepository } from '../contexts/content/infrastructure/item.repository.js';
import { PostgresMediaAssetRepository } from '../contexts/content/infrastructure/media-asset.repository.js';
import { PostgresReviewAssignmentRepository } from '../contexts/content/infrastructure/review/review-assignment.repository.js';
import { PostgresReviewDecisionRepository } from '../contexts/content/infrastructure/review-decision.repository.js';
import { PostgresSolutionRepository } from '../contexts/content/infrastructure/solution.repository.js';
import { PostgresStimulusRepository } from '../contexts/content/infrastructure/stimulus.repository.js';
import { PostgresTransactionRunner } from '../contexts/content/infrastructure/transaction-runner.js';

/**
 * What the composition root does for generation's `ContentAuthoring` port: run
 * content's own handlers, over content's own repositories, under the caller's
 * own context. Written against real content so the anti-corruption layer is
 * proved against the invariants it is meant to satisfy, not against a stand-in
 * that agrees with whatever it was sent.
 *
 * This is test support. The production wiring is the composition seam's, which
 * is not built yet; it should do the same thing and nothing more.
 */
export function contentAuthoringOver(
  pool: Pool,
  ports: { readonly clock: Clock; readonly identifiers: IdentifierFactory; readonly renderer: RenderValidator },
): ContentAuthoring & { readonly items: PostgresItemRepository } {
  const items = new PostgresItemRepository(pool);
  const authoring = {
    items,
    clock: ports.clock,
    identifiers: ports.identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
  };
  const lifecycle = {
    items,
    assets: new PostgresMediaAssetRepository(pool),
    store: new InMemoryMediaStore(),
    stimuli: new PostgresStimulusRepository(pool),
    solutions: new PostgresSolutionRepository(pool),
    reviews: new PostgresReviewDecisionRepository(pool),
    renderer: ports.renderer,
    assignments: new PostgresReviewAssignmentRepository(pool),
    transactions: new PostgresTransactionRunner(pool),
    clock: ports.clock,
    identifiers: ports.identifiers,
    audit: new InMemoryAuditRecorder(),
  };

  return {
    items,
    async createDraft(command: CreateItemDraft, context: ApplicationContext) {
      const created = await new CreateItemDraftHandler(authoring).handle(command, context);
      return created.ok ? ok({ itemId: created.value.itemId }) : err(created.error as GenerationApplicationError);
    },
    async submitForReview(command: SubmitItemForReview, context: ApplicationContext) {
      const submitted = await new SubmitItemForReviewHandler(lifecycle).handle(command, context);
      return submitted.ok ? ok(true as const) : err(submitted.error as GenerationApplicationError);
    },
  };
}
