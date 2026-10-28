import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { conflictError, notFoundError } from '../domain/scoring-error.js';
import type { RepositoryError, RescoringOperationRepository } from '../domain/repository-ports.js';
import type { RescoringOperation, RescoringState } from '../domain/rescoring-operation.js';
import type { AttemptsRescored, AttemptScoreSuperseded } from '../domain/events/scoring-events.js';
import type { ScoreRecord } from '../domain/score-record.js';
import { PostgresScoreRecordRepository } from './score-record.repository.js';
import { ScoringOutboxEmitter } from './outbox-emitter.js';
import type { DryRunResult } from '../domain/rescoring-dry-run.js';

/** The casing boundary (§2). snake_case in, camelCase out, here and nowhere else. */

interface OperationRow {
  readonly rescoring_operation_id: string;
  readonly trigger: RescoringOperation['trigger'];
  readonly scope: RescoringOperation['scope'];
  readonly scope_ref: string;
  readonly reason: string;
  readonly state: RescoringState;
  readonly dry_run_result: DryRunResult | null;
  readonly authorized_by_id: string | null;
  readonly executed_at: Date | null;
  readonly aggregate_version: number;
}

function toOperation(row: OperationRow): RescoringOperation {
  return Object.freeze({
    operationId: row.rescoring_operation_id,
    trigger: row.trigger,
    scope: row.scope,
    scopeRef: row.scope_ref,
    reason: row.reason,
    state: row.state,
    ...(row.dry_run_result !== null ? { dryRunResult: row.dry_run_result } : {}),
    ...(row.authorized_by_id !== null ? { authorizedBy: row.authorized_by_id } : {}),
    ...(row.executed_at !== null ? { executedAt: row.executed_at.toISOString() } : {}),
    expectedVersion: row.aggregate_version,
  });
}

export class PostgresRescoringOperationRepository implements RescoringOperationRepository {
  readonly #outbox = new ScoringOutboxEmitter();

  constructor(private readonly pool: Pool) {}

  /**
   * Upsert on the identifier, guarded by `aggregate_version` (P8). A second
   * writer working from a stale read is refused rather than silently
   * overwriting an approval it never saw.
   */
  async save(operation: RescoringOperation, event?: AttemptsRescored): Promise<Result<RescoringOperation, RepositoryError>> {
    return this.inTransaction(operation, async (client) => {
      // The same client, so the event commits with the state change it reports or neither does (DEC-M7-6).
      if (event !== undefined) await this.#outbox.emit(client, event);
    });
  }

  async completeWithSuccessors(
    operation: RescoringOperation,
    supersessions: readonly { readonly predecessorId: string; readonly successor: ScoreRecord }[],
    events: readonly (AttemptsRescored | AttemptScoreSuperseded)[],
  ): Promise<Result<RescoringOperation, RepositoryError>> {
    return this.inTransaction(operation, async (client) => {
      for (const { predecessorId, successor } of supersessions) {
        await PostgresScoreRecordRepository.supersedeOn(client, predecessorId, successor, operation.operationId);
      }
      for (const event of events) await this.#outbox.emit(client, event);
    });
  }

  /**
   * The version-guarded write of the operation, then `rest` on the same connection, then commit. A lost race writes nothing and `rest` does not run; a
   * failure anywhere rolls back everything that went before it, the operation's own state included.
   */
  private async inTransaction(
    operation: RescoringOperation,
    rest: (client: PoolClient) => Promise<void>,
  ): Promise<Result<RescoringOperation, RepositoryError>> {
    let client: PoolClient;
    try {
      client = await this.pool.connect();
    } catch (error) {
      return err(conflictError('PERSISTENCE_REJECTED', String(error)));
    }
    let outcome: Result<RescoringOperation, RepositoryError>;
    try {
      await client.query('BEGIN');
      const written = await client.query(
        `INSERT INTO scoring.rescoring_operation
           (rescoring_operation_id, trigger, scope, scope_ref, reason, state, dry_run_result,
            authorized_by_kind, authorized_by_id, executed_at, aggregate_version)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,1)
         ON CONFLICT (rescoring_operation_id) DO UPDATE
            SET state = EXCLUDED.state,
                dry_run_result = EXCLUDED.dry_run_result,
                authorized_by_kind = EXCLUDED.authorized_by_kind,
                authorized_by_id = EXCLUDED.authorized_by_id,
                executed_at = EXCLUDED.executed_at,
                aggregate_version = scoring.rescoring_operation.aggregate_version + 1
          WHERE scoring.rescoring_operation.aggregate_version = $11`,
        [
          operation.operationId,
          operation.trigger,
          operation.scope,
          operation.scopeRef,
          operation.reason,
          operation.state,
          operation.dryRunResult === undefined ? null : JSON.stringify(operation.dryRunResult),
          operation.authorizedBy === undefined ? null : 'human',
          operation.authorizedBy ?? null,
          operation.executedAt ?? null,
          operation.expectedVersion ?? 1,
        ],
      );

      if (written.rowCount === 0) {
        // Lost the race: nothing was written, so no event is either.
        await client.query('ROLLBACK');
        client.release();
        return err(conflictError('CONFLICT', `re-score ${operation.operationId} was changed by someone else`));
      }
      await rest(client);
      await client.query('COMMIT');
      outcome = ok(operation);
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(conflictError('PERSISTENCE_REJECTED', String(error)));
    }
    client.release();
    return outcome;
  }

  async findById(operationId: string): Promise<Result<RescoringOperation, RepositoryError>> {
    const found = await this.pool.query<OperationRow>(
      `SELECT * FROM scoring.rescoring_operation WHERE rescoring_operation_id = $1`,
      [operationId],
    );
    const row = found.rows[0];
    return row === undefined
      ? err(notFoundError('NOT_FOUND', `no re-score ${operationId}`))
      : ok(toOperation(row));
  }

  async findByState(state: RescoringState): Promise<Result<readonly RescoringOperation[], RepositoryError>> {
    const found = await this.pool.query<OperationRow>(
      `SELECT * FROM scoring.rescoring_operation WHERE state = $1 ORDER BY created_at`,
      [state],
    );
    return ok(Object.freeze(found.rows.map(toOperation)));
  }
}
