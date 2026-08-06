import type { ProblemDetails } from '@questionbank/contracts';
import type { ApplicationError } from '../application/authorization.js';

/**
 * The one place a domain or application failure becomes an HTTP response
 * (ENGINEERING-HANDBOOK §8). Stack traces, SQL and internal identifiers never
 * appear; the `code` is what clients branch on.
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

export function statusForKind(kind: string): number {
  return STATUS_BY_KIND[kind] ?? 500;
}

export function toProblemDetails(
  error: ApplicationError,
  correlationId: string,
  instance?: string,
): ProblemDetails {
  const kind = error.kind;
  return {
    type: `${PROBLEM_TYPE_BASE}${kind.toLowerCase()}`,
    title: TITLE_BY_KIND[kind] ?? 'Unexpected error',
    status: statusForKind(kind),
    detail: error.message,
    code: kind as ProblemDetails['code'],
    retryable: RETRYABLE_KINDS.has(kind),
    correlationId,
    ...(instance !== undefined ? { instance } : {}),
  };
}

export interface FieldIssue {
  readonly field: string;
  readonly message: string;
}

export function validationProblem(
  issues: readonly FieldIssue[],
  correlationId: string,
  instance?: string,
): ProblemDetails {
  return {
    type: `${PROBLEM_TYPE_BASE}validation`,
    title: TITLE_BY_KIND['Validation'] as string,
    status: 400,
    detail: 'One or more fields are invalid.',
    code: 'Validation',
    retryable: false,
    correlationId,
    errors: [...issues],
    ...(instance !== undefined ? { instance } : {}),
  };
}
