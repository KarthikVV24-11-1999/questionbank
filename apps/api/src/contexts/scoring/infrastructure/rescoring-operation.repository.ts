import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { conflictError, notFoundError } from '../domain/scoring-error.js';
import type { RepositoryError, RescoringOperationRepository } from '../domain/repository-ports.js';
import type { RescoringOperation, RescoringState } from '../domain/rescoring-operation.js';
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
  constructor(private readonly pool: Pool) {}

  /**
   * Upsert on the identifier, guarded by `aggregate_version` (P8). A second
   * writer working from a stale read is refused rather than silently
   * overwriting an approval it never saw.
   */
  async save(operation: RescoringOperation): Promise<Result<RescoringOperation, RepositoryError>> {
    try {
      const written = await this.pool.query(
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
        return err(conflictError('CONFLICT', `re-score ${operation.operationId} was changed by someone else`));
      }
      return ok(operation);
    } catch (error) {
      return err(conflictError('PERSISTENCE_REJECTED', String(error)));
    }
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
