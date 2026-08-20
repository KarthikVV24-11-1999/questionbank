import { err, ok, type Result } from '../result.js';
import { validationError, type ContentError } from '../content-error.js';

/**
 * The rejection taxonomy (DEC-M4-11) — "chosen by key, never typed", closed
 * and shared between the reviewer's keyboard and the aggregation the reason
 * feeds. Ten entries, exactly DEC-M4-11's table.
 *
 * **`DUPLICATE` is `reject`-only and requires a `duplicateOfItemId`.** A
 * duplicate finding names the item it duplicates or it is not a finding —
 * `assertReasonPermitted` and `assertDuplicateHasTarget` both live here so
 * the rule cannot be satisfied by one check and skipped by the other.
 *
 * The free-text justification M3 already requires on every non-approving
 * outcome (`review-decision.ts`) is unaffected — the taxonomy is for
 * aggregation, the justification is for the author, and neither substitutes
 * for the other.
 */

export const REVIEW_OUTCOMES_TAKING_A_REASON = ['reject', 'request_changes'] as const;
export type OutcomeTakingAReason = (typeof REVIEW_OUTCOMES_TAKING_A_REASON)[number];

export interface RejectionReason {
  readonly code: string;
  readonly key: string;
  readonly eligibleOutcomes: readonly OutcomeTakingAReason[];
}

export const REJECTION_REASONS = [
  { code: 'FACTUALLY_INCORRECT', key: 'f', eligibleOutcomes: ['reject', 'request_changes'] },
  { code: 'KEY_WRONG', key: 'k', eligibleOutcomes: ['reject', 'request_changes'] },
  { code: 'AMBIGUOUS_STEM', key: 'a', eligibleOutcomes: ['request_changes'] },
  { code: 'DUPLICATE', key: 'd', eligibleOutcomes: ['reject'] },
  { code: 'OUT_OF_SYLLABUS', key: 's', eligibleOutcomes: ['reject'] },
  { code: 'NOTATION_BROKEN', key: 'n', eligibleOutcomes: ['request_changes'] },
  { code: 'SOLUTION_INADEQUATE', key: 'x', eligibleOutcomes: ['request_changes'] },
  { code: 'DIFFICULTY_MISCALIBRATED', key: 'c', eligibleOutcomes: ['request_changes'] },
  { code: 'LICENSING_UNRESOLVED', key: 'l', eligibleOutcomes: ['request_changes'] },
  { code: 'ACCESSIBILITY_DEFECT', key: 'y', eligibleOutcomes: ['request_changes'] },
] as const satisfies readonly RejectionReason[];

export type RejectionReasonCode = (typeof REJECTION_REASONS)[number]['code'];

/** The one reason the domain treats specially: a duplicate finding names its target. */
export const DUPLICATE_REASON_CODE: RejectionReasonCode = 'DUPLICATE';

export type RejectionTaxonomyErrorCode =
  | 'REASON_CODE_UNKNOWN'
  | 'REASON_NOT_ELIGIBLE_FOR_OUTCOME'
  | 'DUPLICATE_REQUIRES_A_TARGET';

export type RejectionTaxonomyError = ContentError<RejectionTaxonomyErrorCode>;

function invalid(code: RejectionTaxonomyErrorCode, message: string, location: string): RejectionTaxonomyError {
  return validationError(code, message, location);
}

function reasonFor(code: string): RejectionReason | undefined {
  return REJECTION_REASONS.find((reason) => reason.code === code);
}

/**
 * Refuses a reason whose `eligibleOutcomes` excludes the outcome, and an
 * unknown code outright — never coerced to a nearest match.
 */
export function assertReasonPermitted(
  code: string,
  outcome: OutcomeTakingAReason,
  location = 'reasonCode',
): Result<RejectionReason, RejectionTaxonomyError> {
  const reason = reasonFor(code);
  if (reason === undefined) {
    return err(invalid('REASON_CODE_UNKNOWN', `unknown rejection reason code "${code}"`, location));
  }
  if (!(reason.eligibleOutcomes as readonly string[]).includes(outcome)) {
    return err(
      invalid(
        'REASON_NOT_ELIGIBLE_FOR_OUTCOME',
        `reason "${code}" is not eligible for outcome "${outcome}"`,
        location,
      ),
    );
  }
  return ok(reason);
}

/** `DUPLICATE` requires a `duplicateOfItemId`; every other reason ignores it. */
export function assertDuplicateHasTarget(
  code: string,
  duplicateOfItemId: string | undefined,
  location = 'duplicateOfItemId',
): Result<true, RejectionTaxonomyError> {
  if (code !== DUPLICATE_REASON_CODE) return ok(true);
  if (duplicateOfItemId === undefined || duplicateOfItemId.trim().length === 0) {
    return err(
      invalid(
        'DUPLICATE_REQUIRES_A_TARGET',
        'a DUPLICATE rejection names the item it duplicates',
        location,
      ),
    );
  }
  return ok(true);
}
