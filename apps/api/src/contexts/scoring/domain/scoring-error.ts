/**
 * The scoring context's failure surface (ENGINEERING-HANDBOOK §8).
 *
 * The taxonomy is a fixed, closed set of ten; adding a member is an API change.
 * Scoring produces five of them. The `satisfies` clause below makes that subset
 * relationship a compile error to violate, so a new scoring error cannot invent
 * an eleventh kind by typo.
 *
 * **Fail closed.** §8 names scoring alongside authorization and entitlement as a
 * surface that fails closed: when scoring cannot justify a mark it declines to
 * award one. Declining means awarding 0 — never deducting. Deducting a mark for
 * a gap in the engine is an active penalty, not a closed failure
 * (ADR-0003). Every error constructed here leaves the candidate no worse off
 * than an unattempted slot.
 */

/** The platform-wide taxonomy (§8). Fixed and closed. */
export const ERROR_KINDS = [
  'Validation',
  'Authentication',
  'Authorization',
  'Entitlement',
  'NotFound',
  'Conflict',
  'PreconditionFailed',
  'RuleViolation',
  'RateLimited',
  'Unavailable',
] as const;

export type ErrorKind = (typeof ERROR_KINDS)[number];

/**
 * The subset the scoring domain produces. Authentication, Authorization and
 * Entitlement belong to the application layer's policies; RateLimited and
 * Unavailable are infrastructure conditions, and infrastructure is the only
 * layer permitted to throw.
 */
export const SCORING_ERROR_KINDS = [
  'Validation',
  'NotFound',
  'Conflict',
  'PreconditionFailed',
  'RuleViolation',
] as const satisfies readonly ErrorKind[];

export type ScoringErrorKind = (typeof SCORING_ERROR_KINDS)[number];

/**
 * `code` is what a client branches on and what a test asserts; `message` is for
 * a human reading a log or a problem-details body. Neither ever carries a
 * stack trace, SQL, an internal identifier or answer-key material (§8, §9
 * rule 10).
 */
export interface ScoringError<Code extends string = string> {
  readonly kind: ScoringErrorKind;
  readonly code: Code;
  readonly message: string;
}

function scoringError<Code extends string>(
  kind: ScoringErrorKind,
  code: Code,
  message: string,
): ScoringError<Code> {
  return Object.freeze({ kind, code, message });
}

/** The input is malformed or self-contradictory. */
export function validationError<Code extends string>(code: Code, message: string): ScoringError<Code> {
  return scoringError('Validation', code, message);
}

/** The referenced record does not exist. */
export function notFoundError<Code extends string>(code: Code, message: string): ScoringError<Code> {
  return scoringError('NotFound', code, message);
}

/** The operation collides with existing state — a second current score record, a stale write. */
export function conflictError<Code extends string>(code: Code, message: string): ScoringError<Code> {
  return scoringError('Conflict', code, message);
}

/** A required precondition does not hold — an unpinned rule set, an unregistered schema version. */
export function preconditionFailedError<Code extends string>(code: Code, message: string): ScoringError<Code> {
  return scoringError('PreconditionFailed', code, message);
}

/** The rule set itself cannot produce an answer — an unmatched slot, an unknown award kind. */
export function ruleViolationError<Code extends string>(code: Code, message: string): ScoringError<Code> {
  return scoringError('RuleViolation', code, message);
}

export function isScoringErrorKind(kind: string): kind is ScoringErrorKind {
  return (SCORING_ERROR_KINDS as readonly string[]).includes(kind);
}
