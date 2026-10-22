import { conflictError, notFoundError, unavailableError, validationError } from '../domain/assessment-error.js';
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
 * The store could not be reached, or refused the connection: the process is gone, the connection dropped, the server
 * is shutting down or out of connections. Network error codes from the driver, and SQLSTATE class 08 (connection
 * exception), 57P (operator intervention) and 53300 (too many connections). **Not the caller's fault**: answered as
 * `Unavailable`, which is retryable, so a device holds its events and sends them again — never as a rejection of
 * the events themselves.
 */
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EHOSTUNREACH', '53300', '57P01', '57P02', '57P03']);

function isUnreachable(code: string | undefined): boolean {
  return code !== undefined && (UNREACHABLE_CODES.has(code) || code.startsWith('08'));
}
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
  if (isUnreachable(code)) return unavailableError('STORE_UNAVAILABLE', 'the store could not be reached; try again', 'store');
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
