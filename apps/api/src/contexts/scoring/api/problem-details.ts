import type { ApplicationError } from '../application/authorization.js';

/**
 * The one place a scoring failure becomes an HTTP response (§8). Stack traces,
 * SQL and internal identifiers never appear, and neither does anything about
 * what the correct answer was.
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
  readonly instance?: string;
}

export function statusForKind(kind: string): number {
  return STATUS_BY_KIND[kind] ?? 500;
}

export function toProblemDetails(
  error: ApplicationError,
  correlationId: string,
  instance?: string,
): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE}${error.kind.toLowerCase()}`,
    title: TITLE_BY_KIND[error.kind] ?? 'Unexpected error',
    status: statusForKind(error.kind),
    detail: error.message,
    code: error.kind,
    // Explicit on every error. A client must never infer it (§8).
    retryable: RETRYABLE_KINDS.has(error.kind),
    correlationId,
    ...(instance !== undefined ? { instance } : {}),
  };
}

export function validationProblem(detail: string, correlationId: string): ProblemDetails {
  return toProblemDetails({ kind: 'Validation', code: 'Validation', message: detail }, correlationId);
}
