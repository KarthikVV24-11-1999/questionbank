import type { ReviewOutcome } from '../../domain/review-decision.js';

/**
 * FR-QM-01 rule 2 — every transition is explicit, permission-gated and
 * audited. There is no implicit transition and no generic "set state to X":
 * one command per act, so a permission gate exists per act and a reviewer
 * cannot publish by writing a state name.
 *
 * Publication takes only the version to publish. Every fact M3-11 needs —
 * the signature, the solution, the render verdict, the licence's instant — is
 * resolved by the handler, because a caller that could supply them could
 * supply them wrong.
 */

export interface SubmitItemForReview {
  readonly itemId: string;
}

export interface WithdrawItemFromReview {
  readonly itemId: string;
}

export interface RecordItemReviewDecision {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly outcome: ReviewOutcome;
  /** Required on anything that sends work back (FR-QM-03). */
  readonly justification?: string;
}

export interface PublishItemVersion {
  readonly itemId: string;
  readonly itemVersionId: string;
}

export interface SuspendItem {
  readonly itemId: string;
  readonly justification: string;
}

export interface RetireItem {
  readonly itemId: string;
  readonly retirementReason: string;
  readonly replacedByItemId?: string;
}

export interface SubmitStimulusForReview {
  readonly stimulusId: string;
}

export interface RecordStimulusReviewDecision {
  readonly stimulusId: string;
  readonly stimulusVersionId: string;
  readonly outcome: ReviewOutcome;
  readonly justification?: string;
}

export interface PublishStimulusVersion {
  readonly stimulusId: string;
  readonly stimulusVersionId: string;
}

export interface RetireStimulus {
  readonly stimulusId: string;
  readonly retirementReason: string;
}

export interface SubmitSolutionForReview {
  readonly solutionId: string;
}

export interface RecordSolutionReviewDecision {
  readonly solutionId: string;
  readonly solutionVersionId: string;
  readonly outcome: ReviewOutcome;
  readonly justification?: string;
}

export interface PublishSolutionVersion {
  readonly solutionId: string;
  readonly solutionVersionId: string;
}

export interface SubmitMediaAssetForReview {
  readonly assetId: string;
}

export interface RecordMediaAssetReviewDecision {
  readonly assetId: string;
  readonly assetVersionId: string;
  readonly outcome: ReviewOutcome;
  readonly justification?: string;
}

/**
 * Publication re-verifies the stored object's checksum (M3-27), so an asset
 * replaced behind its key after review cannot reach a student.
 */
export interface PublishMediaAssetVersion {
  readonly assetId: string;
  readonly assetVersionId: string;
}
