import { conflictError, notFoundError, validationError } from '../domain/generation-error.js';
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

/**
 * A unique violation means another write got to the same row first, which is a
 * `CONFLICT` the caller can retry from fresh state; anything else the store
 * refused is `PERSISTENCE_REJECTED`, naming the constraint when there was one.
 */
export function fromDatabaseError(error: unknown): RepositoryError {
  const { code, constraint, message } = error as DatabaseError;
  // The F31 trigger on `generation_run` raises with a message of our own that names the version, and says nothing of SQL.
  if (typeof message === 'string' && message.startsWith('version_not_evaluated:')) return persistenceRejected(message, 'versionId');
  if (code === UNIQUE_VIOLATION) {
    return conflict(`a concurrent write got there first (${constraint ?? 'unique key'})`, constraint ?? 'unique key');
  }
  return persistenceRejected(
    constraint === undefined ? `the store rejected the write${code === undefined ? '' : ` (${code})`}` : `the store rejected the write: ${constraint}`,
    constraint,
  );
}
