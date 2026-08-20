import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';
import type { ReviewerSignature } from './publication-preconditions.js';

/**
 * A recorded review decision — the evidence M3-11's `ReviewerSignature`
 * precondition is built from (FR-QM-03, INV-07).
 *
 * **M4 owns the review *workspace*; M3 owns the record.** The scope boundary
 * gives M4 assignment routing, ageing, the rejection taxonomy and the capture
 * screen. None of those can exist without something to write, and a
 * publication precondition that depends on another milestone's storage is not
 * a precondition — so the decision itself lands here.
 *
 * A decision is **append-only by construction**: there is no mutator, and a
 * reviewer changing their mind records a second decision. The history is what
 * FR-TCH-09 rule 1 needs when reviewer comments have to persist against the
 * version they addressed.
 */

export const REVIEW_OUTCOMES = ['approve', 'approve_with_edits', 'request_changes', 'reject'] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOMES)[number];

/** The outcomes that constitute a signature INV-07 accepts. */
export const APPROVING_OUTCOMES = ['approve', 'approve_with_edits'] as const;

export const REVIEWED_OWNER_TYPES = [
  'item_version',
  'stimulus_version',
  'solution_version',
  'media_asset_version',
] as const;
export type ReviewedOwnerType = (typeof REVIEWED_OWNER_TYPES)[number];

export interface ReviewDecision {
  readonly decisionId: string;
  readonly ownerType: ReviewedOwnerType;
  readonly ownerVersionId: string;
  readonly reviewer: PrincipalRef;
  readonly outcome: ReviewOutcome;
  /** Required on anything that sends work back — "rejected" is not feedback. */
  readonly justification?: string;
  readonly decidedAt: string;
  /**
   * The governance fields (M4-07, DEC-M4-11, DEC-M4-2). Accepted here as a
   * plain passthrough — this constructor's own validation is unchanged from
   * M3, so its existing suite stays green unchanged. The rules these fields
   * carry (a reason required on a non-approving outcome, self-review refused,
   * `DUPLICATE` naming its target, absent-vs-empty candidates distinguished)
   * are enforced by `domain/review/decision-evidence.ts`'s
   * `assertDecisionEvidenceComplete`, which a caller runs before constructing
   * a decision it intends to persist.
   */
  readonly reasonCode?: string;
  readonly duplicateOfItemId?: string;
  /** Absent means the duplicate check did not run; empty means it ran and found nothing — never the same value. */
  readonly candidatesShownIds?: readonly string[];
}

export type ReviewDecisionErrorCode =
  | 'DECISION_ID_REQUIRED'
  | 'OWNER_VERSION_REQUIRED'
  | 'OWNER_TYPE_UNKNOWN'
  | 'REVIEWER_REQUIRED'
  | 'OUTCOME_UNKNOWN'
  | 'JUSTIFICATION_REQUIRED'
  | 'DECIDED_AT_NOT_A_TIMESTAMP';

export type ReviewDecisionError = ContentError<ReviewDecisionErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: ReviewDecisionErrorCode, message: string, location: string): ReviewDecisionError {
  return validationError(code, message, location);
}

export function isApproving(outcome: ReviewOutcome): boolean {
  return (APPROVING_OUTCOMES as readonly string[]).includes(outcome);
}

export interface CreateReviewDecisionProps {
  readonly decisionId: string;
  readonly ownerType: ReviewedOwnerType;
  readonly ownerVersionId: string;
  readonly reviewer: PrincipalRef;
  readonly outcome: ReviewOutcome;
  readonly justification?: string;
  readonly decidedAt: string;
  readonly reasonCode?: string;
  readonly duplicateOfItemId?: string;
  readonly candidatesShownIds?: readonly string[];
}

export function createReviewDecision(
  props: CreateReviewDecisionProps,
  location = 'reviewDecision',
): Result<ReviewDecision, ReviewDecisionError> {
  if (isBlank(props.decisionId)) {
    return err(invalid('DECISION_ID_REQUIRED', 'a review decision requires a decisionId', location));
  }
  if (!(REVIEWED_OWNER_TYPES as readonly string[]).includes(props.ownerType)) {
    return err(invalid('OWNER_TYPE_UNKNOWN', `unknown reviewed owner type "${props.ownerType}"`, location));
  }
  if (isBlank(props.ownerVersionId)) {
    return err(
      invalid('OWNER_VERSION_REQUIRED', 'a review decision names the version it decided', `${location}.ownerVersionId`),
    );
  }
  if (isBlank(props.reviewer.id)) {
    return err(
      invalid('REVIEWER_REQUIRED', 'a review decision records who made it (INV-02)', `${location}.reviewer`),
    );
  }
  if (!(REVIEW_OUTCOMES as readonly string[]).includes(props.outcome)) {
    return err(invalid('OUTCOME_UNKNOWN', `unknown review outcome "${props.outcome}"`, `${location}.outcome`));
  }
  // An author told only "rejected" has nothing to act on, which is the same
  // failure "invalid item" is (UX §10.1) one layer up.
  if (!isApproving(props.outcome) && (props.justification === undefined || isBlank(props.justification))) {
    return err(
      invalid(
        'JUSTIFICATION_REQUIRED',
        `a ${props.outcome} decision states what has to change`,
        `${location}.justification`,
      ),
    );
  }
  if (!ISO_INSTANT.test(props.decidedAt)) {
    return err(
      invalid(
        'DECIDED_AT_NOT_A_TIMESTAMP',
        `decidedAt "${props.decidedAt}" is not an ISO-8601 instant`,
        `${location}.decidedAt`,
      ),
    );
  }

  return ok(
    Object.freeze({
      decisionId: props.decisionId,
      ownerType: props.ownerType,
      ownerVersionId: props.ownerVersionId,
      reviewer: Object.freeze({
        ...props.reviewer,
        roleContext: Object.freeze([...props.reviewer.roleContext]),
      }),
      outcome: props.outcome,
      ...(props.justification === undefined ? {} : { justification: props.justification }),
      decidedAt: props.decidedAt,
      ...(props.reasonCode === undefined ? {} : { reasonCode: props.reasonCode }),
      ...(props.duplicateOfItemId === undefined ? {} : { duplicateOfItemId: props.duplicateOfItemId }),
      ...(props.candidatesShownIds === undefined
        ? {}
        : { candidatesShownIds: Object.freeze([...props.candidatesShownIds]) }),
    }),
  );
}

/**
 * The publication fact, or nothing. A decision that sent work back is not a
 * signature, and returning one anyway would let a rejected version publish.
 */
export function toReviewerSignature(decision: ReviewDecision): ReviewerSignature | undefined {
  if (!isApproving(decision.outcome)) return undefined;
  return Object.freeze({
    reviewer: decision.reviewer,
    itemVersionId: decision.ownerVersionId,
    decision: decision.outcome as 'approve' | 'approve_with_edits',
    signedAt: decision.decidedAt,
  });
}
