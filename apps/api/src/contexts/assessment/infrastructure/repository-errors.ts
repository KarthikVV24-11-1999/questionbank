import { conflictError, notFoundError, validationError } from '../domain/assessment-error.js';
import type { RepositoryError } from '../domain/repository-ports.js';

/**
 * How the repositories report what went wrong (§8): a code a caller can branch
 * on and a message a person can read — never SQL, never a stack trace.
 */

export function notFound(what: string, id: string): RepositoryError {
  return notFoundError('NOT_FOUND', `no ${what} ${id}`, what);
}

export function conflict(message: string, location: string): RepositoryError {
  return conflictError('CONFLICT', message, location);
}

export function persistenceRejected(message: string, location?: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, location);
}

/** Postgres reports the SQLSTATE and, for a constraint, its name; both are safe to say, the statement is not. */
interface DatabaseError {
  readonly code?: string;
  readonly constraint?: string;
  readonly message?: string;
}

const UNIQUE_VIOLATION = '23505';
const RESTRICT_VIOLATION = '23001';

/**
 * A unique violation means another write got to the same row first — for an
 * attempt, the one-active-mock index — which is a `CONFLICT` the caller can
 * answer from fresh state. The assessment triggers raise `restrict_violation`
 * with a message of their own (`assessment_...: ...`) that names what was
 * refused and says nothing of SQL, so it is passed on. Anything else the store
 * refused is `PERSISTENCE_REJECTED`, naming the constraint when there was one.
 */
export function fromDatabaseError(error: unknown): RepositoryError {
  const { code, constraint, message } = error as DatabaseError;
  if (code === UNIQUE_VIOLATION) {
    return conflict(`a concurrent write got there first (${constraint ?? 'unique key'})`, constraint ?? 'unique key');
  }
  if (code === RESTRICT_VIOLATION && typeof message === 'string' && message.startsWith('assessment_')) {
    return persistenceRejected(message, message.slice(0, message.indexOf(':')));
  }
  return persistenceRejected(
    constraint === undefined ? `the store rejected the write${code === undefined ? '' : ` (${code})`}` : `the store rejected the write: ${constraint}`,
    constraint,
  );
}
