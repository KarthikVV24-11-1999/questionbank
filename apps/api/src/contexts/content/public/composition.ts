import type { Pool } from 'pg';
import type { DynamicModule } from '@nestjs/common';
import type { Handler } from '../application/handler-registry.js';
import {
  InMemoryEntitlements,
  InMemoryReviewProgress,
  type AuditRecorder,
  type Clock,
  type IdentifierFactory,
  type IdempotencyStore,
  type MediaStore,
} from '../application/ports.js';
import type { PrincipalResolver } from '../api/http-runner.js';
import { ContentModule } from '../api/content.module.js';
import { RenderValidatorAdapter } from '../infrastructure/render-validator.adapter.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import { PostgresStimulusRepository } from '../infrastructure/stimulus.repository.js';
import { PostgresSolutionRepository } from '../infrastructure/solution.repository.js';
import { PostgresMediaAssetRepository } from '../infrastructure/media-asset.repository.js';
import { PostgresReviewDecisionRepository } from '../infrastructure/review-decision.repository.js';
import {
  CreateItemDraftHandler,
  DeleteItemDraftHandler,
  DeriveDraftFromVersionHandler,
  UpdateItemDraftHandler,
} from '../application/handlers/authoring-handlers.js';
import {
  AttachStimulusToItemHandler,
  CreateStimulusDraftHandler,
  UpdateStimulusDraftHandler,
} from '../application/handlers/stimulus-handlers.js';
import { CreateSolutionDraftHandler, UpdateSolutionDraftHandler } from '../application/handlers/solution-handlers.js';
import {
  AddMediaAssetVersionHandler,
  RegisterMediaAssetHandler,
  RetireMediaAssetHandler,
} from '../application/handlers/media-handlers.js';
import { ImportItemBatchHandler } from '../application/handlers/import-handlers.js';
import {
  PublishItemVersionHandler,
  PublishMediaAssetVersionHandler,
  PublishSolutionVersionHandler,
  PublishStimulusVersionHandler,
  RecordItemReviewDecisionHandler,
  RecordMediaAssetReviewDecisionHandler,
  RecordSolutionReviewDecisionHandler,
  RecordStimulusReviewDecisionHandler,
  RetireItemHandler,
  RetireStimulusHandler,
  SubmitItemForReviewHandler,
  SubmitMediaAssetForReviewHandler,
  SubmitSolutionForReviewHandler,
  SubmitStimulusForReviewHandler,
  SuspendItemHandler,
  WithdrawItemFromReviewHandler,
} from '../application/handlers/lifecycle-handlers.js';
import {
  GetItemDraftHandler,
  GetItemVersionForAuthoringHandler,
  GetValidationFindingsHandler,
  ListMediaAssetsHandler,
  ListMyDraftsHandler,
  ListSubmittedForReviewHandler,
} from '../application/queries/authoring-queries.js';
import {
  GetPublishedItemHandler,
  GetPublishedSolutionHandler,
  GetPublishedStimulusHandler,
} from '../application/queries/delivery-queries.js';

/**
 * The composition seam (DEC-M0-5, ADR-0015). `register` composes content's
 * **own** handlers, repositories and adapters and returns the same
 * `DynamicModule` `ContentModule.register` already produces — nothing here
 * decides anything the handlers themselves do not; this file wires.
 *
 * `deps` names exactly the *platform-level* ports this context needs:
 * `MediaStore`, `IdempotencyStore`, plus the three ports every context needs
 * (`Clock`, `IdentifierFactory`, `AuditRecorder`) and a `pool` to build its
 * five repositories from. Adding a repository or a handler is a change to
 * this file's body, never to its signature or to `platform/composition/`.
 *
 * **`RenderValidator` is not in `deps`, deliberately.** Its one production
 * implementation, `RenderValidatorAdapter`, lives in
 * `contexts/content/infrastructure/` — inside this context, not under
 * `platform/` — and needs no platform port of its own to construct. Naming
 * it in `deps` would force `platform/composition/` to import it directly,
 * which is exactly the deep cross-context import F1's extension (M0-12)
 * exists to refuse. Constructing it here, one line below, keeps that import
 * inside the context that owns it.
 *
 * **`ReviewProgress` and `Entitlements` are the in-memory doubles, wired as
 * the production choice, not a shortcut.** `InMemoryReviewProgress` starts
 * with nothing claimed — `hasBegun` is `false` until M4 supplies an adapter
 * that can be true, which is exactly the behaviour W4 already documents:
 * nothing claims a version, so withdrawal while `in_review` is always
 * permitted. `InMemoryEntitlements` starts with nothing granted — `allows`
 * is `false` until an entitlement service exists, and INV-08 is what makes
 * that safe: the delivery solution query never asks it about basic
 * correctness, only about paid depth, so an absent entitlement service
 * cannot withhold the correct answer.
 */
export interface ContentCompositionDeps {
  readonly pool: Pool;
  readonly mediaStore: MediaStore;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly principals: PrincipalResolver;
}

/**
 * Every key `ContentCompositionDeps` names. Checked at runtime, not only in
 * the type — a caller that reached this function via a cast (a config
 * object assembled by hand, say) must still be refused eagerly, the same
 * instant `HandlerRegistry` refuses a policy-less handler, rather than
 * failing later and confusingly at the first request that happens to touch
 * the missing port.
 */
const REQUIRED_DEPS_KEYS = [
  'pool',
  'mediaStore',
  'idempotency',
  'clock',
  'identifiers',
  'audit',
  'principals',
] as const satisfies readonly (keyof ContentCompositionDeps)[];

export function register(deps: ContentCompositionDeps): DynamicModule {
  for (const key of REQUIRED_DEPS_KEYS) {
    if (deps[key] === undefined) {
      throw new Error(`content composition is missing required dependency: ${key}`);
    }
  }

  const items = new PostgresItemRepository(deps.pool);
  const stimuli = new PostgresStimulusRepository(deps.pool);
  const solutions = new PostgresSolutionRepository(deps.pool);
  const assets = new PostgresMediaAssetRepository(deps.pool);
  const reviews = new PostgresReviewDecisionRepository(deps.pool);
  const reviewProgress = new InMemoryReviewProgress();
  const entitlements = new InMemoryEntitlements();
  const renderer = new RenderValidatorAdapter();

  // Every field every handler's own Dependencies interface names, in one
  // bag — structurally assignable to each narrower interface, so a handler
  // never learns about a field it does not use.
  const bag = {
    items,
    stimuli,
    solutions,
    assets,
    reviews,
    store: deps.mediaStore,
    renderer,
    reviewProgress,
    entitlements,
    clock: deps.clock,
    identifiers: deps.identifiers,
    audit: deps.audit,
    idempotency: deps.idempotency,
  };

  const handlers = [
    // Authoring
    new CreateItemDraftHandler(bag),
    new UpdateItemDraftHandler(bag),
    new DeriveDraftFromVersionHandler(bag),
    new DeleteItemDraftHandler(bag),
    new CreateStimulusDraftHandler(bag),
    new UpdateStimulusDraftHandler(bag),
    new AttachStimulusToItemHandler(bag),
    new CreateSolutionDraftHandler(bag),
    new UpdateSolutionDraftHandler(bag),
    new RegisterMediaAssetHandler(bag),
    new AddMediaAssetVersionHandler(bag),
    new RetireMediaAssetHandler(bag),
    new ImportItemBatchHandler(bag),
    // Lifecycle
    new SubmitItemForReviewHandler(bag),
    new WithdrawItemFromReviewHandler(bag),
    new RecordItemReviewDecisionHandler(bag),
    new PublishItemVersionHandler(bag),
    new SuspendItemHandler(bag),
    new RetireItemHandler(bag),
    new SubmitStimulusForReviewHandler(bag),
    new RecordStimulusReviewDecisionHandler(bag),
    new PublishStimulusVersionHandler(bag),
    new RetireStimulusHandler(bag),
    new SubmitSolutionForReviewHandler(bag),
    new RecordSolutionReviewDecisionHandler(bag),
    new PublishSolutionVersionHandler(bag),
    new SubmitMediaAssetForReviewHandler(bag),
    new RecordMediaAssetReviewDecisionHandler(bag),
    new PublishMediaAssetVersionHandler(bag),
    // Authoring queries
    new GetItemDraftHandler(bag),
    new ListMyDraftsHandler(bag),
    new GetItemVersionForAuthoringHandler(bag),
    new GetValidationFindingsHandler(bag),
    new ListMediaAssetsHandler(bag),
    new ListSubmittedForReviewHandler(bag),
    // Delivery queries
    new GetPublishedItemHandler(bag),
    new GetPublishedStimulusHandler(bag),
    new GetPublishedSolutionHandler(bag),
  ] as unknown as readonly Handler<never, unknown>[];

  return ContentModule.register({ handlers, principals: deps.principals });
}
