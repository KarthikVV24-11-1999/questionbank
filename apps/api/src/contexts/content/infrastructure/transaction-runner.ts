import type { Pool, PoolClient } from 'pg';
import { err, type Result } from '../domain/result.js';
import { validationError } from '../domain/content-error.js';
import type { RepositoryError, TransactionContext } from '../domain/repository-ports.js';
import type { TransactionRunner } from '../application/ports.js';

/**
 * `PostgresReviewAssignmentRepository.claimNext` (M4-18) deliberately keeps
 * its own hand-rolled `BEGIN`/`COMMIT` and must **not** be migrated to this
 * runner. It holds a row lock across a `SELECT … FOR UPDATE SKIP LOCKED` and
 * the `INSERT` that follows in the same connection, and that lock held
 * across two statements is what makes the claim atomic — `run`'s generic
 * callback shape adds nothing to that and would only make the one place
 * this codebase depends on statement-order-within-a-lock harder to read. A
 * later refactor that routes `claimNext` through here for consistency's
 * sake would not be a cleanup; say so here so it does not happen by
 * accident.
 */

/**
 * The concrete `TransactionContext` (M4-28) — a `PoolClient` wrapped so the
 * domain-side type stays opaque. `clientOf` is the one legitimate downcast,
 * and it lives here because this module is what constructs every instance;
 * nothing outside `infrastructure/` ever sees the `client` field's name.
 */
class PostgresTransactionContext implements TransactionContext {
  readonly kind = 'TransactionContext' as const;
  constructor(readonly client: PoolClient) {}
}

/**
 * Unwraps the `PoolClient` a repository needs to join the caller's
 * transaction. Refuses anything that is not this module's own
 * `PostgresTransactionContext` — a `TransactionContext` manufactured by
 * hand elsewhere (a test double, say) is a bug this call is what catches,
 * rather than a client silently reading `undefined` off the wrong shape.
 */
export function clientOf(tx: TransactionContext): PoolClient {
  if (!(tx instanceof PostgresTransactionContext)) {
    throw new TypeError('TransactionContext was not constructed by PostgresTransactionRunner');
  }
  return tx.client;
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'transaction');
}

export class PostgresTransactionRunner implements TransactionRunner {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async run<T>(
    fn: (tx: TransactionContext) => Promise<Result<T, RepositoryError>>,
  ): Promise<Result<T, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<T, RepositoryError>;

    try {
      await client.query('BEGIN');
      outcome = await fn(new PostgresTransactionContext(client));
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }
}
