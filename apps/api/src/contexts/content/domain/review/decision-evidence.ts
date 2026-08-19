import { err, ok, type Result } from '../result.js';
import { validationError, type ContentError } from '../content-error.js';
import { isApproving, type ReviewOutcome } from '../review-decision.js';
import { assertAssignable, type SelfReviewableVersion } from './self-review.js';
import { assertDuplicateHasTarget, assertReasonPermitted, type OutcomeTakingAReason } from './rejection-taxonomy.js';
import type { PrincipalRef } from '@questionbank/domain-types';

/**
 * The governance rules `ReviewDecision` (M3, extended M4-07) carries but does
 * not itself enforce — self-review, the reason code, `DUPLICATE`'s target,
 * and the duplicate-check disclosure. `createReviewDecision` accepts these
 * fields as a plain passthrough so M3's own suite stays green unchanged; a
 * caller that intends to *persist* a decision runs
 * `assertDecisionEvidenceComplete` first, here, where all four checks compose
 * without touching M3's constructor.
 */

/**
 * Mirrors `pre-submission-validation.ts`'s `DuplicateCheckState` exactly —
 * the same three-way distinction, at the point a decision is recorded rather
 * than at submission. `absent` and `[]` must never collapse to the same
 * value: a report that says "no duplicates found" when the check never ran
 * is a lie a reviewer will act on (DEC-M4-2 condition 3).
 */
export const DUPLICATE_DISCLOSURE_STATES = ['not_evaluated', 'none_found', 'candidates_found'] as const;
export type DuplicateDisclosureState = (typeof DUPLICATE_DISCLOSURE_STATES)[number];

export function duplicateDisclosureState(candidatesShownIds: readonly string[] | undefined): DuplicateDisclosureState {
  if (candidatesShownIds === undefined) return 'not_evaluated';
  return candidatesShownIds.length === 0 ? 'none_found' : 'candidates_found';
}

export interface DecisionEvidenceInput {
  readonly outcome: ReviewOutcome;
  readonly reviewer: PrincipalRef;
  readonly reasonCode?: string;
  readonly duplicateOfItemId?: string;
  readonly candidatesShownIds?: readonly string[];
}

export type DecisionEvidenceErrorCode = 'REASON_CODE_REQUIRED' | 'CANDIDATES_SHOWN_REQUIRED';
export type DecisionEvidenceError = ContentError;

function invalid(code: DecisionEvidenceErrorCode, message: string, location: string): DecisionEvidenceError {
  return validationError(code, message, location);
}

/**
 * All four governance checks, composed: self-review (INV-12, via M4-04's one
 * shared function — the second of its three call sites), a reason code on
 * every non-approving outcome, `DUPLICATE` naming its target
 * (rejection-taxonomy.ts), and the duplicate check having actually run —
 * required on **every** outcome, approving included, because DEC-M4-2
 * condition 3 records what a decision was shown regardless of what it
 * decided.
 */
export function assertDecisionEvidenceComplete(
  input: DecisionEvidenceInput,
  reviewedVersion: SelfReviewableVersion,
  location = 'reviewDecision',
): Result<true, DecisionEvidenceError> {
  const selfReview = assertAssignable(reviewedVersion, input.reviewer, `${location}.reviewer`);
  if (!selfReview.ok) return selfReview;

  if (input.candidatesShownIds === undefined) {
    return err(
      invalid(
        'CANDIDATES_SHOWN_REQUIRED',
        'a decision records the duplicate candidates it was shown, even when none were found (DEC-M4-2)',
        `${location}.candidatesShownIds`,
      ),
    );
  }

  if (!isApproving(input.outcome)) {
    if (input.reasonCode === undefined || input.reasonCode.trim().length === 0) {
      return err(
        invalid(
          'REASON_CODE_REQUIRED',
          `a ${input.outcome} decision names a reason from the taxonomy (DEC-M4-11)`,
          `${location}.reasonCode`,
        ),
      );
    }

    const permitted = assertReasonPermitted(input.reasonCode, input.outcome as OutcomeTakingAReason, `${location}.reasonCode`);
    if (!permitted.ok) return permitted;

    const target = assertDuplicateHasTarget(input.reasonCode, input.duplicateOfItemId, `${location}.duplicateOfItemId`);
    if (!target.ok) return target;
  }

  return ok(true);
}
