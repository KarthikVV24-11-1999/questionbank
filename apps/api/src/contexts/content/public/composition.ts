import type { Pool } from 'pg';
import { ROLES } from '../../../platform/auth/roles.js';
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
import { GetDuplicateCandidatesForProposalHandler, GetDuplicateCandidatesHandler } from '../application/review/queries/duplicate-queries.js';
import { GetPublishedItemVersionHandler, GetPublishedStimulusVersionHandler } from '../application/queries/delivery-queries.js';
import { GetAnswerKeysForScoringHandler } from '../application/queries/scoring-key-queries.js';
import { PostgresPublishedVersions } from '../infrastructure/published-versions.reader.js';
import { ListPublishedCatalogueHandler, MAX_CATALOGUE_PAGE } from '../application/queries/catalogue-queries.js';
import { GetVersionTaxonomyHandler } from '../application/queries/version-taxonomy-queries.js';
import { PostgresVersionTaxonomy } from '../infrastructure/version-taxonomy.reader.js';
import { GetItemStandingHandler } from '../application/queries/item-standing-queries.js';
import { PostgresItemStanding } from '../infrastructure/item-standing.reader.js';
import { PostgresPublishedCatalogue } from '../infrastructure/published-catalogue.reader.js';
import { GetQueueHealthHandler, GetReviewerThroughputHandler } from '../application/review/queries/queue-queries.js';
import { validateProposedContent } from '../application/proposal-validation.js';

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

function assemble(deps: ContentCompositionDeps) {
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
  const catalogue = new PostgresPublishedCatalogue(deps.pool);
  const versions = new PostgresPublishedVersions(deps.pool);
  const taxonomy = new PostgresVersionTaxonomy(deps.pool);
  const standing = new PostgresItemStanding(deps.pool);
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
    catalogue,
    versions,
    taxonomy,
    standing,
    reviewPolicy,
    transactions,
  };

  return bag;
}

/** The identity the scheduler's jobs act under: the system's. */
const SCHEDULER_PRINCIPAL_ID = '00000000-0000-4000-8000-0000000000f2';

/**
 * What the scheduler runs for content (M6-42, D36): the review ageing sweep — release expired leases, escalate what is overdue. An
 * ordinary idempotent command taking its moment as a parameter; the scheduler decides only when to ask.
 */
export interface ContentJobLike {
  readonly name: string;
  readonly everyMs: number;
  run(now: Date): Promise<void>;
}

export function contentJobs(deps: ContentCompositionDeps): readonly ContentJobLike[] {
  const sweep = new SweepReviewAgeingHandler(assemble(deps));
  return [
    {
      name: 'content.review-ageing',
      everyMs: 3_600_000,
      run: async (now) => {
        const done = await sweep.handle(
          { now: now.toISOString() },
          { principal: { kind: 'system', id: SCHEDULER_PRINCIPAL_ID, roleContext: [ROLES.system] }, correlationId: 'scheduler:content.review-ageing' },
        );
        if (!done.ok) throw new Error(`SweepReviewAgeing: ${done.error.code}: ${done.error.message}`);
      },
    },
  ];
}

export function register(deps: ContentCompositionDeps): DynamicModule {
  const bag = assemble(deps);

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
    new ListPublishedCatalogueHandler(bag),
    new GetPublishedItemVersionHandler(bag),
    new GetPublishedStimulusVersionHandler(bag),
    // Review queries (M4-32, M4-33)
    new GetDuplicateCandidatesHandler(bag),
    new GetDuplicateCandidatesForProposalHandler(bag),
    new GetQueueHealthHandler(bag),
    new GetReviewerThroughputHandler(bag),
  ] as unknown as readonly Handler<never, unknown>[];

  return ContentModule.register({ handlers, principals: deps.principals });
}

/**
 * What generation consumes from content, and nothing more: the two commands that
 * turn an accepted candidate into a draft awaiting review, the query that finds
 * duplicates of a proposal not yet stored, and the pure validator (M5-37).
 *
 * **This is the whole of what the composition root can hand generation.** Content
 * exposes its handlers to no other context; `register` builds them inside a module
 * the root never sees. Rather than let the root reach into that module, content
 * names the three handlers generation is allowed to call and builds them from the
 * same assembly `register` uses — the same repositories, the same audit recorder,
 * the same idempotency store — so a draft generation creates is indistinguishable
 * from one an author does. Generation holds no capability to write a content
 * aggregate (SEC-20, F27); it holds these handlers, and content's policies
 * authorize the human who accepted the candidate exactly as they would for any draft.
 *
 * Adding a fourth handler here is a deliberate change to what generation may do to
 * content, and is reviewed as one.
 */
export interface ContentForGeneration {
  readonly createDraft: CreateItemDraftHandler;
  readonly submitForReview: SubmitItemForReviewHandler;
  readonly duplicatesForProposal: GetDuplicateCandidatesForProposalHandler;
  readonly validateProposal: typeof validateProposedContent;
}

export function contentForGeneration(deps: ContentCompositionDeps): ContentForGeneration {
  const bag = assemble(deps);
  return {
    createDraft: new CreateItemDraftHandler(bag),
    submitForReview: new SubmitItemForReviewHandler(bag),
    duplicatesForProposal: new GetDuplicateCandidatesForProposalHandler(bag),
    validateProposal: validateProposedContent,
  };
}

/**
 * What the assessment context consumes from content, and nothing more: the
 * published catalogue, so form assembly has a corpus it can enumerate; the
 * duplicate-candidates query, so "no near-duplicates within one form" uses
 * content's own detection rather than a second implementation of it (a rule
 * implemented twice drifts).
 *
 * The same assembly `register` uses, so what assessment reads is what a student
 * is served. Adding a third handler here is a deliberate change to what
 * assessment may ask of content, and is reviewed as one.
 */
export interface ContentForAssessment {
  readonly listCatalogue: ListPublishedCatalogueHandler;
  readonly duplicates: GetDuplicateCandidatesHandler;
  /** A form pins versions; a package serves exactly those (M6-24), by version id and not by item. */
  readonly itemVersion: GetPublishedItemVersionHandler;
  readonly stimulusVersion: GetPublishedStimulusVersionHandler;
  /** The keys of the versions an attempt pinned, for scoring and for nothing else: the system's alone, with no route (M6-40). */
  readonly answerKeys: GetAnswerKeysForScoringHandler;
  /** A published solution by item version, for the assessment context's effort gate to serve once a slot is released (M7-37). */
  readonly solution: GetPublishedSolutionHandler;
}

export function contentForAssessment(deps: ContentCompositionDeps): ContentForAssessment {
  const bag = assemble(deps);
  return {
    listCatalogue: new ListPublishedCatalogueHandler(bag),
    duplicates: new GetDuplicateCandidatesHandler(bag),
    itemVersion: new GetPublishedItemVersionHandler(bag),
    stimulusVersion: new GetPublishedStimulusVersionHandler(bag),
    answerKeys: new GetAnswerKeysForScoringHandler(bag),
    solution: new GetPublishedSolutionHandler(bag),
  };
}

/**
 * What the learning context consumes from content (M7-03, DEC-M7-1): the primary concept, taxonomy version and authored
 * difficulty of a set of item versions, and nothing more. Content holds the tags and offers them to nobody else; Learning gets
 * no production import of this context, only this door. Adding a second handler here is a deliberate change to what Learning
 * may ask of content, and is reviewed as one.
 */
export interface ContentForLearning {
  /**
   * The most identifiers one call to either read below takes (D86, DEC-M7-28). Content states it here, once, and a caller pages at it: a number written in the
   * caller would be a second statement of content's bound, free to drift from it. It is a consequence of this seam's contract and no domain threshold.
   */
  readonly batchBound: number;
  readonly taxonomyForItemVersions: GetVersionTaxonomyHandler;
  /** Where a bookmarked item stands: published, suspended or retired, and the version to show (M7-38). */
  readonly itemStanding: GetItemStandingHandler;
}

export function contentForLearning(deps: ContentCompositionDeps): ContentForLearning {
  const bag = assemble(deps);
  return { batchBound: MAX_CATALOGUE_PAGE, taxonomyForItemVersions: new GetVersionTaxonomyHandler(bag), itemStanding: new GetItemStandingHandler(bag) };
}
