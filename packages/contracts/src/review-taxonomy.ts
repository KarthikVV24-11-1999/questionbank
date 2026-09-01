/**
 * The rejection taxonomy (DEC-M4-11), mirrored for the frontend.
 *
 * **A hand-kept mirror, not a generation output.** The authoritative
 * declaration is `apps/api/src/contexts/content/domain/review/rejection-taxonomy.ts`
 * — a plain literal array with a `key` field the OpenAPI/Zod pipeline
 * (`scripts/generate-zod.mjs`) has no shape for (it walks `components.schemas`
 * only, and this list has never been an HTTP request or response body in its
 * own right). `apps/api` cannot depend on `packages/contracts` for its own
 * domain vocabulary — the dependency points the other way — so this copy is
 * the one place M4-39's "read from the shared constant rather than
 * duplicated" is honoured on the Studio side: **shared with the domain
 * declaration**, not a second description invented independently of it.
 *
 * **Kept from drifting by `content-contract.spec.ts`'s own parity test**
 * (`apps/api/src/contracts/content-contract.spec.ts`), which imports both
 * this file and the domain module and asserts them deep-equal — the same
 * discipline ENGINEERING-HANDBOOK §5 requires wherever two implementations
 * of one rule must exist (this project has been bitten three times).
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

export function reasonFor(code: string): RejectionReason | undefined {
  return REJECTION_REASONS.find((reason) => reason.code === code);
}

/** Every reason eligible for a given outcome, in the table's own order — what a decision bar keys by. */
export function reasonsFor(outcome: OutcomeTakingAReason): readonly RejectionReason[] {
  return REJECTION_REASONS.filter((reason) => (reason.eligibleOutcomes as readonly string[]).includes(outcome));
}
