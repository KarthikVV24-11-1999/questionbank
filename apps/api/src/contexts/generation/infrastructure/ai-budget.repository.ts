import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { createAIBudget, type AIBudget } from '../domain/ai-budget.js';
import type { AIBudgetRepository, RepositoryError } from '../domain/repository-ports.js';
import { fromDatabaseError, persistenceRejected } from './repository-errors.js';

interface BudgetRow {
  readonly feature: string;
  readonly period: string;
  readonly ceiling_tokens: string;
}

/**
 * A period's ceiling, written once. The table refuses an UPDATE from every role,
 * so "raise the ceiling" is not a thing this repository can do — a second
 * declaration is the `CONFLICT` the unique key reports (D48).
 */
export class PostgresAIBudgetRepository implements AIBudgetRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async declare(
    budget: AIBudget,
    declaredBy: { readonly kind: string; readonly id: string },
    declaredAt: string,
  ): Promise<Result<AIBudget, RepositoryError>> {
    try {
      await this.#pool.query(
        `INSERT INTO ai.ai_budget (feature, period, ceiling_tokens, declared_by_kind, declared_by_id, declared_at)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [budget.feature, budget.period, budget.ceilingTokens, declaredBy.kind, declaredBy.id, declaredAt],
      );
      return ok(budget);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async find(feature: string, period: string): Promise<Result<AIBudget | undefined, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<BudgetRow>(
        'SELECT feature, period, ceiling_tokens FROM ai.ai_budget WHERE feature = $1 AND period = $2',
        [feature, period],
      );
      const row = rows[0];
      if (row === undefined) return ok(undefined);
      const budget = createAIBudget({ feature: row.feature, period: row.period, ceilingTokens: Number(row.ceiling_tokens) });
      return budget.ok
        ? ok(budget.value)
        : err(persistenceRejected(`stored budget ${feature} ${period} no longer satisfies the domain: ${budget.error.code}`, budget.error.location));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
