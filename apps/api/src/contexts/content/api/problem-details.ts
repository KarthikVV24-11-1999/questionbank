import type { ApplicationError } from '../application/authorization.js';

/**
 * The one place a content failure becomes an HTTP response (§8).
 *
 * Stack traces, SQL and internal identifiers never appear — and neither does
 * anything about what the correct answer was. A refusal explains *why the
 * change was refused*, never *what the key is*.
 *
 * Declared here rather than imported from scoring: a context does not reach
 * into another's `api/` layer (§9 rule 1), and content's mapping already
 * diverges — it carries `location` and `detail`, which the Studio validation
 * panel needs to point at a block index or an option id (UX §10.1).
 */
const STATUS_BY_KIND: Record<string, number> = {
  Validation: 400,
  Authentication: 401,
  Authorization: 403,
  Entitlement: 402,
  NotFound: 404,
  Conflict: 409,
  PreconditionFailed: 412,
  RuleViolation: 422,
  RateLimited: 429,
  Unavailable: 503,
};

const TITLE_BY_KIND: Record<string, string> = {
  Validation: 'The request was malformed',
  Authentication: 'Authentication is required',
  Authorization: 'Not permitted',
  Entitlement: 'Upgrade required',
  NotFound: 'Not found',
  Conflict: 'Conflict',
  PreconditionFailed: 'Precondition failed',
  RuleViolation: 'The change was refused',
  RateLimited: 'Too many requests',
  Unavailable: 'Temporarily unavailable',
};

/** Only transient infrastructure failures are worth retrying. */
const RETRYABLE_KINDS = new Set(['Unavailable', 'RateLimited']);

export const PROBLEM_TYPE_BASE = 'https://questionbank.example/problems/';

export interface ProblemDetails {
  readonly type: string;
  readonly title: string;
  readonly status: number;
  readonly detail: string;
  readonly code: string;
  readonly retryable: boolean;
  readonly correlationId: string;
  /** Where inside the aggregate the problem is — the validation panel's anchor. */
  readonly location?: string;
  /** Structured detail a client branches on, such as the precondition list. */
  readonly errors?: unknown;
}

export function statusForKind(kind: string): number {
  return STATUS_BY_KIND[kind] ?? 500;
}

export function toProblemDetails(error: ApplicationError, correlationId: string): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE}${error.kind.toLowerCase()}`,
    title: TITLE_BY_KIND[error.kind] ?? 'Unexpected error',
    status: statusForKind(error.kind),
    detail: error.message,
    code: error.kind,
    // Explicit on every error. A client must never infer it (§8).
    retryable: RETRYABLE_KINDS.has(error.kind),
    correlationId,
    ...(error.location === undefined ? {} : { location: error.location }),
    ...(error.detail === undefined ? {} : { errors: error.detail }),
  };
}

export function validationProblem(detail: string, correlationId: string): ProblemDetails {
  return toProblemDetails({ kind: 'Validation', code: 'Validation', message: detail }, correlationId);
}
