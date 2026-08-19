import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../result.js';
import { ruleViolationError, type ContentError } from '../content-error.js';

/**
 * FR-QM-03 / INV-12 — self-review is prohibited, checked by **one function**
 * (DEC-M4-7, M4-04's acceptance criterion).
 *
 * **Three call sites, enumerated below, and no fourth.** A second
 * implementation anywhere fails the milestone (M4's own rules) — the risk a
 * single shared function exists to remove is two copies of "is this the same
 * person" drifting: one that compares `id`, one that compares `id` and
 * `roleContext`, and a reviewer who edited under a second role slipping
 * through whichever copy nobody updated.
 *
 * **A reviewer who edited a version is no more independent of it than its
 * author.** `editedBy` does not exist on `ItemVersion` until M4-15
 * (approve-with-edits); this module accepts any object shaped like
 * `{ authoredBy, editedBy? }` rather than importing `ItemVersion` itself, so
 * `isSelfReview` needs no change when `editedBy` lands — it already reads
 * the field.
 *
 * **Content Ops is not exempt.** Oversight is not independence, and there is
 * no branch here that treats a `content_ops` role differently — the same
 * check runs for every principal kind and every role.
 */

export interface SelfReviewableVersion {
  readonly authoredBy: PrincipalRef;
  readonly editedBy?: PrincipalRef;
}

export type SelfReviewErrorCode = 'SELF_REVIEW_PROHIBITED';
export type SelfReviewError = ContentError<SelfReviewErrorCode>;

export function isSelfReview(version: SelfReviewableVersion, principal: PrincipalRef): boolean {
  if (principal.id === version.authoredBy.id) return true;
  return version.editedBy !== undefined && principal.id === version.editedBy.id;
}

export function assertAssignable(
  candidate: SelfReviewableVersion,
  reviewer: PrincipalRef,
  location = 'reviewAssignment',
): Result<true, SelfReviewError> {
  if (isSelfReview(candidate, reviewer)) {
    return err(
      ruleViolationError(
        'SELF_REVIEW_PROHIBITED',
        'the reviewer is the author or editor of this version; self-review is prohibited (INV-12)',
        location,
      ),
    );
  }
  return ok(true);
}

/**
 * The three places INV-12 is checked. Removing an entry here without also
 * removing the check it names is a lie this list exists to prevent —
 * `self-review.spec.ts` asserts each named module both exists and calls
 * `assertAssignable` or `isSelfReview`.
 *
 * **Two of three call sites exist.** `decision-evidence.ts`'s
 * `assertDecisionEvidenceComplete` (M4-07) is the decision-time check;
 * `publication-preconditions.ts` is the publication-time check. The claim
 * predicate (`application/review/`, M4-18) is not built within
 * M4-01–M4-07's scope; M4-18 adds its entry here and to
 * `self-review.spec.ts`'s enumeration when it lands — the list grows to
 * three, it does not start there.
 */
export const SELF_REVIEW_CALL_SITES = [
  'src/contexts/content/domain/publication-preconditions.ts',
  'src/contexts/content/domain/review/decision-evidence.ts',
] as const;
