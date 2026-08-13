/**
 * The content context's only public surface. Commands, queries and events —
 * no aggregate, repository or infrastructure type (ENGINEERING-HANDBOOK §1,
 * §9 rule 1).
 *
 * ## The one export that carries key material
 *
 * **`AnswerKeyData` is server-side only and is never a client payload type.**
 * M6 assembles attempts and has to pin the key that will score them, so the
 * shape has to cross a barrel somewhere. It crosses here, named, with this
 * note attached — rather than by M6 reaching into `content/domain` for it,
 * which is the version of the same coupling nobody would notice.
 *
 * Everything else exported here is safe on any payload. The **delivery** views
 * carry no key, no correct-option marker and no numeric expected value
 * (ADR-0009 at M3-33); the **authoring** views deliberately do, and are
 * reachable only under an authoring policy — M3-44 asserts by import graph
 * that no delivery controller can reach them.
 */

// ── Commands ────────────────────────────────────────────────────────────────
export type {
  AuthoredItemContent,
  CreateItemDraft,
  DeleteItemDraft,
  DeriveDraftFromVersion,
  UpdateItemDraft,
} from '../application/commands/authoring-commands.js';

export type {
  AttachStimulusToItem,
  CreateStimulusDraft,
  UpdateStimulusDraft,
} from '../application/commands/stimulus-commands.js';

export type {
  AuthoredSolutionContent,
  CreateSolutionDraft,
  UpdateSolutionDraft,
} from '../application/commands/solution-commands.js';

export type {
  AddMediaAssetVersion,
  AuthoredMediaVersion,
  RegisterMediaAsset,
  RetireMediaAsset,
} from '../application/commands/media-commands.js';

export type {
  PublishItemVersion,
  PublishSolutionVersion,
  PublishStimulusVersion,
  RecordItemReviewDecision,
  RecordSolutionReviewDecision,
  RecordStimulusReviewDecision,
  RetireItem,
  RetireStimulus,
  SubmitItemForReview,
  SubmitSolutionForReview,
  SubmitStimulusForReview,
  SuspendItem,
  WithdrawItemFromReview,
} from '../application/commands/lifecycle-commands.js';

export type { ImportItemBatch } from '../application/handlers/import-handlers.js';

// ── Queries ─────────────────────────────────────────────────────────────────
export type {
  AuthoringItemVersionView,
  AuthoringItemView,
  AuthoringMediaAssetView,
  GetItemDraft,
  GetItemVersionForAuthoring,
  GetValidationFindings,
  ListMediaAssets,
  ListMyDrafts,
} from '../application/queries/authoring-queries.js';

export type {
  DeliveryAlternateApproachView,
  DeliveryItemView,
  DeliveryMatchingMemberView,
  DeliveryNumericInputView,
  DeliveryOptionView,
  DeliverySolutionStepView,
  DeliverySolutionView,
  DeliveryStimulusView,
  GetPublishedItem,
  GetPublishedSolution,
  GetPublishedStimulus,
} from '../application/queries/delivery-queries.js';

// ── Events ──────────────────────────────────────────────────────────────────
export type {
  ContentEvent,
  ContentEventType,
  ItemPublished,
  ItemPublishedPayload,
  ItemRetired,
  ItemRetiredPayload,
  ItemSuspended,
  ItemSuspendedPayload,
  MediaAssetPublished,
  MediaAssetPublishedPayload,
  SolutionPublished,
  SolutionPublishedPayload,
  StimulusPublished,
  StimulusPublishedPayload,
} from '../domain/events/content-events.js';

export { CONTENT_EVENT_TYPES } from '../domain/events/content-events.js';

// ── The content document, as data ───────────────────────────────────────────
//
// M6 renders a pinned version and `packages/content-renderer/` types against
// one, so the node vocabulary crosses as read-only shapes. The **constructor**
// crosses too: a consumer that hand-built a `ContentBody` would build one the
// renderer has never been asked to render (DEC-2).

export type {
  Block,
  BlockKind,
  ContentBody,
  Inline,
  InlineKind,
  MediaSizeHint,
  TextMark,
} from '../domain/content-body.js';

export {
  BLOCK_KINDS,
  CONTENT_BODY_SCHEMA_VERSION,
  INLINE_KINDS,
  MEDIA_SIZE_HINTS,
  TEXT_MARKS,
  createContentBody,
} from '../domain/content-body.js';

/** Reading order, the symbolic search field, and the media usage graph's edges. */
export { projectContentBody } from '../domain/content-body-projections.js';
export type { ContentBodyProjections } from '../domain/content-body-projections.js';

// ── Vocabularies a consumer has to agree with ───────────────────────────────
//
// Closed sets, exported so a consumer branches on the same list Content does
// rather than on a copy that drifts.

export { ITEM_TYPES } from '../domain/response-specification.js';
export type { ItemType } from '../domain/response-specification.js';

export { LIFECYCLE_STATES, LIFECYCLE_TRANSITIONS } from '../domain/item-lifecycle.js';
export type { LifecycleState, LifecycleTransition } from '../domain/item-lifecycle.js';

export { DIFFICULTY_BANDS } from '../domain/item-version.js';
export type { DifficultyBand } from '../domain/item-version.js';

export { STIMULUS_TYPES } from '../domain/stimulus.js';
export type { StimulusType } from '../domain/stimulus.js';

export { ASSET_TYPES } from '../domain/media-asset.js';
export type { AssetType } from '../domain/media-asset.js';

export { REVIEW_OUTCOMES } from '../domain/review-decision.js';
export type { ReviewOutcome, ReviewedOwnerType } from '../domain/review-decision.js';

// ── Validation, as a consumer reads it ──────────────────────────────────────
export type {
  BlockingCode,
  DuplicateCheckState,
  Finding,
  FindingCode,
  FindingSeverity,
  ValidationReport,
  WarningCode,
} from '../domain/pre-submission-validation.js';

export { BLOCKING_CODES, WARNING_CODES, describeDuplicateCheck } from '../domain/pre-submission-validation.js';

/** The publication precondition codes the Studio validation panel groups by. */
export { PRECONDITION_CODES } from '../domain/publication-preconditions.js';
export type { UnmetPrecondition } from '../domain/publication-preconditions.js';

// ── The import contract ─────────────────────────────────────────────────────
export type {
  ImportBatchHeader,
  ImportedRecord,
  ImportItemRecord,
  ImportReport,
  RejectedRecord,
} from '../application/import/import-batch.js';

// ── The answer key, for M6 alone ────────────────────────────────────────────
//
// See the header. Server-side only; never a client payload type.
export type { AnswerKeyData } from '../../scoring/public/index.js';
export { projectValidatedAnswerKey, toAnswerKeyData } from '../application/answer-key-projection.js';

// ── Errors, as a consumer branches on them ──────────────────────────────────
export type { ApplicationError, ApplicationErrorKind } from '../application/authorization.js';
export type { ContentError, ContentErrorKind } from '../domain/content-error.js';
export { CONTENT_ERROR_KINDS } from '../domain/content-error.js';
