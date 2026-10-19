import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { admitRun, budgetNotDeclared, periodOf } from '../domain/ai-budget.js';
import { createGenerationRun, type GenerationRun } from '../domain/generation-run.js';
import type { GenerationRunRepository, RepositoryError, RunAdmissionError } from '../domain/repository-ports.js';
import { inPeriod } from './period-sql.js';
import { fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface RunRow {
  readonly run_id: string;
  readonly model_version_id: string;
  readonly prompt_version_id: string;
  readonly requested_at: Date;
  readonly request: Record<string, unknown>;
  readonly budget_tokens: string;
}

const INSERT_RUN = `INSERT INTO ai.generation_run (run_id, model_version_id, prompt_version_id, requested_at, request, budget_tokens)
                    VALUES ($1, $2, $3, $4, $5, $6)`;

function insertParameters(run: GenerationRun): unknown[] {
  return [run.pin.runId, run.pin.modelVersionId, run.pin.promptVersionId, run.requestedAt, JSON.stringify(run.request), run.budgetTokens];
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
      await this.#pool.query(INSERT_RUN, insertParameters(run));
      return ok(run);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  /**
   * One transaction decides and writes. An advisory lock on the budget's scope
   * serializes concurrent enqueues for it — a row lock would need the UPDATE
   * privilege the application role deliberately lacks on this schema — so the
   * committed figure read below is still true when the insert lands.
   *
   * The period's bounds are computed here in SQL and its name in TypeScript
   * (`periodOf`); `generation-run.repository.integration.spec.ts` holds the two
   * to the same answer at the boundaries, because two implementations of one rule
   * drift.
   */
  async saveWithinBudget(run: GenerationRun, feature: string): Promise<Result<GenerationRun, RunAdmissionError>> {
    // `createGenerationRun` only builds a run whose timestamp is the UTC millisecond form, so a period always exists.
    const period = periodOf(run.requestedAt) as string;

    const client = await this.#pool.connect();
    // `#admit` returns a value whatever happens (it catches), so the connection is released on every path
    // without a `finally`, and a rejected store reaches the caller as a failure, never as an exception.
    const outcome = await this.#admit(client, run, feature, period);
    client.release();
    return outcome;
  }

  async #admit(client: PoolClient, run: GenerationRun, feature: string, period: string): Promise<Result<GenerationRun, RunAdmissionError>> {
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`ai_budget:${feature}:${period}`]);

      const budget = await client.query<{ ceiling_tokens: string }>(
        'SELECT ceiling_tokens FROM ai.ai_budget WHERE feature = $1 AND period = $2',
        [feature, period],
      );
      const declared = budget.rows[0];
      if (declared === undefined) {
        await client.query('ROLLBACK');
        return err(budgetNotDeclared(feature, period));
      }

      const committed = await client.query<{ committed: string }>(
        `SELECT COALESCE(SUM(budget_tokens), 0)::text AS committed
           FROM ai.generation_run
          WHERE ${inPeriod('requested_at', 1)}`,
        [period],
      );
      const admitted = admitRun({
        ceilingTokens: Number(declared.ceiling_tokens),
        committedTokens: Number(committed.rows[0]!.committed),
        requestedTokens: run.budgetTokens,
      });
      if (!admitted.ok) {
        await client.query('ROLLBACK');
        return err(admitted.error);
      }

      await client.query(INSERT_RUN, insertParameters(run));
      await client.query('COMMIT');
      return ok(run);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  async findById(runId: string): Promise<Result<GenerationRun, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<RunRow>(
        `SELECT run_id, model_version_id, prompt_version_id, requested_at, request, budget_tokens
           FROM ai.generation_run WHERE run_id = $1`,
        [runId],
      );
      const row = rows[0];
      if (row === undefined) return err(notFound('run', runId));

      const run = createGenerationRun({
        pin: { modelVersionId: row.model_version_id, promptVersionId: row.prompt_version_id, runId: row.run_id },
        requestedAt: row.requested_at.toISOString(),
        request: row.request,
        budgetTokens: Number(row.budget_tokens),
      });
      return run.ok
        ? ok(run.value)
        : err(persistenceRejected(`stored run ${runId} no longer satisfies the domain: ${run.error.code}`, run.error.location));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
