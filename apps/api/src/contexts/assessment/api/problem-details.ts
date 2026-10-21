import type { ApplicationError } from '../application/authorization.js';

/**
 * The one place an assessment failure becomes an HTTP response (§8). Stack traces,
 * SQL and internal identifiers never appear.
 *
 * **Two extension members beyond the platform shape**, both permitted by RFC 9457:
 * `reason`, the specific refusal (`code` stays the platform's kind), and
 * `constraint`, the hard constraint an assembly could not meet. They are what let
 * an impossible blueprint and an exhausted search be told apart by a machine as
 * well as by a person: the first is a `422` that asking again will not change, the
 * second a retryable `503`.
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
  readonly reason?: string;
  readonly constraint?: string;
}

export function statusForKind(kind: string): number {
  return STATUS_BY_KIND[kind] ?? 500;
}

function constraintOf(detail: unknown): string | undefined {
  const named = (detail as { constraint?: unknown } | undefined)?.constraint;
  return typeof named === 'string' ? named : undefined;
}

export function toProblemDetails(error: ApplicationError, correlationId: string): ProblemDetails {
  const constraint = constraintOf(error.detail);
  return {
    type: `${PROBLEM_TYPE_BASE}${error.kind.toLowerCase()}`,
    title: TITLE_BY_KIND[error.kind] ?? 'Unexpected error',
    status: statusForKind(error.kind),
    detail: error.message,
    code: error.kind,
    // Explicit on every error. A client must never infer it (§8).
    retryable: RETRYABLE_KINDS.has(error.kind),
    correlationId,
    reason: error.code,
    ...(constraint === undefined ? {} : { constraint }),
  };
}

export function validationProblem(detail: string, correlationId: string): ProblemDetails {
  return toProblemDetails({ kind: 'Validation', code: 'Validation', message: detail }, correlationId);
}
