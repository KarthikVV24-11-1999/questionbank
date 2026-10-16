/**
 * The generation context's failure surface (ENGINEERING-HANDBOOK §8).
 *
 * The taxonomy is a fixed, closed set of ten; adding a member is an API change.
 * The generation domain produces three of them, and the `satisfies` clause
 * makes that subset relationship a compile error to violate.
 *
 * Authentication, Authorization and Entitlement belong to the application
 * layer's policies; RateLimited and Unavailable are infrastructure conditions,
 * and infrastructure is the only layer permitted to throw.
 *
 * Of the five kinds scoring and content keep, two do not survive here:
 *
 * - **NotFound** — nothing in this domain looks anything up. A candidate that
 *   does not exist is a repository's finding, and no repository exists until
 *   Track C.
 * - **Conflict** — a stale write or a second current record is detected by the
 *   persistence layer's constraints, not by pure construction.
 *
 * Both are one line to add the day a domain function actually produces them,
 * and adding them earlier would be a kind nothing can construct.
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

export const GENERATION_ERROR_KINDS = [
  /** Input that is malformed or self-contradictory — a blank pin member, a duplicated check. */
  'Validation',
  /** A state the candidate is not in yet — accepting one that was never fully pre-checked. */
  'PreconditionFailed',
  /** The lifecycle itself forbids it — accepting a candidate that is already rejected. */
  'RuleViolation',
] as const satisfies readonly ErrorKind[];

export type GenerationErrorKind = (typeof GENERATION_ERROR_KINDS)[number];

/**
 * `code` is what a caller branches on and what a test asserts; `message` is for
 * a human. `location` names the field or place inside the aggregate — an error
 * that cannot say where the problem is sends the reader hunting. Neither ever
 * carries a stack trace, SQL or an internal identifier (§8).
 */
export interface GenerationError<Code extends string = string> {
  readonly kind: GenerationErrorKind;
  readonly code: Code;
  readonly message: string;
  readonly location?: string;
}

function generationError<Code extends string>(
  kind: GenerationErrorKind,
  code: Code,
  message: string,
  location?: string,
): GenerationError<Code> {
  return Object.freeze(location === undefined ? { kind, code, message } : { kind, code, message, location });
}

export function validationError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): GenerationError<Code> {
  return generationError('Validation', code, message, location);
}

export function preconditionFailedError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): GenerationError<Code> {
  return generationError('PreconditionFailed', code, message, location);
}

export function ruleViolationError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): GenerationError<Code> {
  return generationError('RuleViolation', code, message, location);
}
