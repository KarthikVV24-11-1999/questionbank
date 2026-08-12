/**
 * The content context's failure surface (ENGINEERING-HANDBOOK §8).
 *
 * The taxonomy is a fixed, closed set of ten; adding a member is an API change.
 * Content produces five of them. The `satisfies` clause below makes that subset
 * relationship a compile error to violate, so a new content error cannot invent
 * an eleventh kind by typo.
 *
 * **Fail closed toward the learner.** §8 names scoring, authorization and
 * entitlement as the surfaces that fail closed. Content sits upstream of all
 * three: what it publishes is what gets scored, and what leaks from it is an
 * answer key. Every refusal here therefore leaves content *unpublished* rather
 * than published-with-a-gap — an item that cannot prove it satisfies INV-07
 * stays a draft, and a payload that cannot prove it carries no key is not
 * served.
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
 * The subset the content domain produces. Authentication, Authorization and
 * Entitlement belong to the application layer's policies; RateLimited and
 * Unavailable are infrastructure conditions, and infrastructure is the only
 * layer permitted to throw.
 */
export const CONTENT_ERROR_KINDS = [
  'Validation',
  'NotFound',
  'Conflict',
  'PreconditionFailed',
  'RuleViolation',
] as const satisfies readonly ErrorKind[];

export type ContentErrorKind = (typeof CONTENT_ERROR_KINDS)[number];

/**
 * `code` is what a client branches on, what a test asserts, and what the Studio
 * validation panel groups by — so it is stable and never assembled from a
 * message. `message` is for a human. Neither ever carries a stack trace, SQL,
 * an internal identifier, or answer-key material (§8, §9 rule 10).
 *
 * `location` is what separates a usable authoring error from "invalid item":
 * an author who cannot find the problem submits nothing (UX §10.1). It names
 * the place inside the aggregate — a block index, an option id, a step ordinal
 * — and it is deliberately a plain string so a value object never has to know
 * how the editor addresses it.
 */
export interface ContentError<Code extends string = string> {
  readonly kind: ContentErrorKind;
  readonly code: Code;
  readonly message: string;
  readonly location?: string;
}

function contentError<Code extends string>(
  kind: ContentErrorKind,
  code: Code,
  message: string,
  location?: string,
): ContentError<Code> {
  return Object.freeze(location === undefined ? { kind, code, message } : { kind, code, message, location });
}

/** The input is malformed or self-contradictory — a body with no blocks, an option naming no id. */
export function validationError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): ContentError<Code> {
  return contentError('Validation', code, message, location);
}

/** The referenced item, version, stimulus, solution or asset does not exist. */
export function notFoundError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): ContentError<Code> {
  return contentError('NotFound', code, message, location);
}

/** The operation collides with existing state — a second published version, a stale write. */
export function conflictError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): ContentError<Code> {
  return contentError('Conflict', code, message, location);
}

/** A publication precondition does not hold — unresolved licensing, no solution, no signature. */
export function preconditionFailedError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): ContentError<Code> {
  return contentError('PreconditionFailed', code, message, location);
}

/** The governance model itself refuses — an illegal transition, a self-review, an AI signature. */
export function ruleViolationError<Code extends string>(
  code: Code,
  message: string,
  location?: string,
): ContentError<Code> {
  return contentError('RuleViolation', code, message, location);
}

export function isContentErrorKind(kind: string): kind is ContentErrorKind {
  return (CONTENT_ERROR_KINDS as readonly string[]).includes(kind);
}
