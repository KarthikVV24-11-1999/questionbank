import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { createGenerationRun, type GenerationRun } from '../domain/generation-run.js';
import type { GenerationRunRepository, RepositoryError } from '../domain/repository-ports.js';
import { fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface RunRow {
  readonly run_id: string;
  readonly model_version_id: string;
  readonly prompt_version_id: string;
  readonly requested_at: Date;
  readonly request: Record<string, unknown>;
}

/**
 * A run is written once and never changes (the table refuses an UPDATE from
 * every role), so there is no read-modify-write here and no transaction: one
 * INSERT is atomic on its own, and a second INSERT of the same run is the
 * unique violation `fromDatabaseError` reports as a `CONFLICT`.
 */
export class PostgresGenerationRunRepository implements GenerationRunRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(run: GenerationRun): Promise<Result<GenerationRun, RepositoryError>> {
    try {
      await this.#pool.query(
        `INSERT INTO ai.generation_run (run_id, model_version_id, prompt_version_id, requested_at, request)
         VALUES ($1, $2, $3, $4, $5)`,
        [run.pin.runId, run.pin.modelVersionId, run.pin.promptVersionId, run.requestedAt, JSON.stringify(run.request)],
      );
      return ok(run);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findById(runId: string): Promise<Result<GenerationRun, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<RunRow>(
        `SELECT run_id, model_version_id, prompt_version_id, requested_at, request
           FROM ai.generation_run WHERE run_id = $1`,
        [runId],
      );
      const row = rows[0];
      if (row === undefined) return err(notFound('run', runId));

      const run = createGenerationRun({
        pin: { modelVersionId: row.model_version_id, promptVersionId: row.prompt_version_id, runId: row.run_id },
        requestedAt: row.requested_at.toISOString(),
        request: row.request,
      });
      return run.ok
        ? ok(run.value)
        : err(persistenceRejected(`stored run ${runId} no longer satisfies the domain: ${run.error.code}`, run.error.location));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
