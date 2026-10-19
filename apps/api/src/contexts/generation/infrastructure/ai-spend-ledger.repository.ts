import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { createSpendEntry, type SpendEntry } from '../domain/ai-spend.js';
import type { AISpendLedger, RepositoryError } from '../domain/repository-ports.js';
import { inPeriod } from './period-sql.js';
import { fromDatabaseError, persistenceRejected } from './repository-errors.js';

/**
 * The ledger's one writer and its readers. There is no update and no delete: the
 * table refuses both from every role, so "correct an entry" is not an operation
 * this repository could offer. What a run has consumed is a `SUM` over these rows
 * and nowhere else — a counter kept beside the ledger is a second answer to the
 * same question.
 */
export class PostgresAISpendLedger implements AISpendLedger {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async append(entry: SpendEntry): Promise<Result<SpendEntry, RepositoryError>> {
    const valid = createSpendEntry(entry);
    if (!valid.ok) return err(persistenceRejected(valid.error.message, valid.error.location));
    try {
      await this.#pool.query(
        `INSERT INTO ai.ai_spend_ledger
           (ledger_id, feature, run_id, model_version_id, prompt_version_id, call_kind, input_tokens, output_tokens, occurred_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.ledgerId,
          entry.feature,
          entry.runId,
          entry.modelVersionId,
          entry.promptVersionId,
          entry.kind,
          entry.usage.inputTokens,
          entry.usage.outputTokens,
          entry.occurredAt,
        ],
      );
      return ok(valid.value);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async spentByRun(runId: string): Promise<Result<number, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<{ spent: string }>(
        'SELECT COALESCE(SUM(total_tokens), 0)::text AS spent FROM ai.ai_spend_ledger WHERE run_id = $1',
        [runId],
      );
      return ok(Number(rows[0]!.spent));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async spentInPeriod(feature: string, period: string): Promise<Result<number, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<{ spent: string }>(
        `SELECT COALESCE(SUM(total_tokens), 0)::text AS spent FROM ai.ai_spend_ledger
          WHERE feature = $1 AND ${inPeriod('occurred_at', 2)}`,
        [feature, period],
      );
      return ok(Number(rows[0]!.spent));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
