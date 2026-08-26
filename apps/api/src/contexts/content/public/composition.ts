import type { Pool } from 'pg';
import type { DynamicModule } from '@nestjs/common';
import type { Handler } from '../application/handler-registry.js';
import {
  InMemoryEntitlements,
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
import { PostgresReviewAssignmentRepository } from '../infrastructure/review/review-assignment.repository.js';
import { PostgresReviewEscalationRepository } from '../infrastructure/review/review-escalation.repository.js';
import { PostgresFingerprintRepository } from '../infrastructure/review/fingerprint.repository.js';
import { PostgresTransactionRunner } from '../infrastructure/transaction-runner.js';
import { createReviewPolicy, type ReviewPolicy } from '../domain/review/review-policy.js';
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
import {
  ClaimNextForReviewHandler,
  ExtendLeaseHandler,
  ReassignReviewHandler,
  ReleaseAssignmentHandler,
} from '../application/review/handlers/assignment-handlers.js';
import { ApproveWithEditsHandler } from '../application/review/handlers/reviewer-edit-handlers.js';
import { SweepReviewAgeingHandler } from '../application/review/handlers/ageing-handlers.js';
import { RefreshFingerprintsHandler } from '../application/review/handlers/fingerprint-handlers.js';
import { GetDuplicateCandidatesHandler } from '../application/review/queries/duplicate-queries.js';
import { GetQueueHealthHandler, GetReviewerThroughputHandler } from '../application/review/queries/queue-queries.js';

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
 * **`ReviewProgress` is gone (M4-30, 2026-08-21), not replaced by another
 * double.** `WithdrawItemFromReviewHandler` now reads `content.review_assignment`
 * directly through `ReviewAssignmentRepository.hasLiveClaim`, already wired
 * below as `assignments` for M4-27 — there is nothing left for a port or an
 * in-memory double to stand in for. See ADR-0015's amendment.
 *
 * **`Entitlements` is still the in-memory double, wired as the production
 * choice, not a shortcut.** `InMemoryEntitlements` starts with nothing
 * granted — `allows` is `false` until an entitlement service exists, and
 * INV-08 is what makes that safe: the delivery solution query never asks
 * it about basic correctness, only about paid depth, so an absent
 * entitlement service cannot withhold the correct answer.
 */
export interface ContentCompositionDeps {
  readonly pool: Pool;
  readonly mediaStore: MediaStore;
  readonly idempotency: IdempotencyStore;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly principals: PrincipalResolver;
  /**
   * The raw numbers, not a constructed `ReviewPolicy` (M4-26). `createReviewPolicy`
   * lives in `domain/review/review-policy.ts`; `platform/composition/` may
   * import only `contexts/*\/public/composition.js` (F1's extension, DEC-M0-5
   * condition 2), so it cannot call that constructor itself — it can only
   * hand this file the numbers `config.ts` already validated, and this file,
   * which owns the domain type, is what turns them into one.
   */
  readonly reviewPolicy: {
    readonly warnAfterHours: number;
    readonly escalateAfterHours: number;
    readonly leaseHours: number;
    readonly sampleRate: number;
  };
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
  'reviewPolicy',
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
  const reviewAssignments = new PostgresReviewAssignmentRepository(deps.pool);
  const reviewEscalations = new PostgresReviewEscalationRepository(deps.pool);
  const fingerprints = new PostgresFingerprintRepository(deps.pool);
  const transactions = new PostgresTransactionRunner(deps.pool);
  const entitlements = new InMemoryEntitlements();
  const renderer = new RenderValidatorAdapter();

  // config.ts already validated every field individually and the
  // escalate-after-warn ordering; a failure here is a wiring bug, not user
  // input, so it throws the same way REQUIRED_DEPS_KEYS's own check does.
  const reviewPolicyResult = createReviewPolicy(deps.reviewPolicy);
  if (!reviewPolicyResult.ok) {
    throw new Error(`content composition built an invalid ReviewPolicy: ${reviewPolicyResult.error.message}`);
  }
  const reviewPolicy: ReviewPolicy = reviewPolicyResult.value;

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
    entitlements,
    clock: deps.clock,
    identifiers: deps.identifiers,
    audit: deps.audit,
    idempotency: deps.idempotency,
    assignments: reviewAssignments,
    escalations: reviewEscalations,
    fingerprints,
    reviewPolicy,
    transactions,
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
    // Review assignment
    new ClaimNextForReviewHandler(bag),
    new ReleaseAssignmentHandler(bag),
    new ReassignReviewHandler(bag),
    new ExtendLeaseHandler(bag),
    new ApproveWithEditsHandler(bag),
    new SweepReviewAgeingHandler(bag),
    new RefreshFingerprintsHandler(bag),
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
    // Review queries (M4-32, M4-33)
    new GetDuplicateCandidatesHandler(bag),
    new GetQueueHealthHandler(bag),
    new GetReviewerThroughputHandler(bag),
  ] as unknown as readonly Handler<never, unknown>[];

  return ContentModule.register({ handlers, principals: deps.principals });
}
