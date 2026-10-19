import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { evaluate, type EvaluationRun, type SubjectKind } from '../domain/evaluation-run.js';
import type { EvaluationRunRepository, RepositoryError } from '../domain/repository-ports.js';
import { fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface Row {
  readonly evaluation_run_id: string;
  readonly model_version_id: string | null;
  readonly prompt_version_id: string | null;
  readonly corpus: string;
  readonly scores: Record<string, unknown>;
  readonly baseline_run_id: string | null;
  readonly regressions: string[];
  readonly outcome: string;
  readonly evaluated_at: Date;
}

/**
 * Evaluation runs over `ai.evaluation_run`, append-only. A stored run is read back
 * through `evaluate` against its own baseline, so what comes out is a value the
 * domain would have produced: a row whose stored outcome disagrees with what its
 * scores and baseline derive is `PERSISTENCE_REJECTED`, never believed.
 */
export class PostgresEvaluationRunRepository implements EvaluationRunRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(
    run: EvaluationRun,
    evaluatedBy: { readonly kind: string; readonly id: string },
  ): Promise<Result<EvaluationRun, RepositoryError>> {
    try {
      await this.#pool.query(
        `INSERT INTO ai.evaluation_run
           (evaluation_run_id, model_version_id, prompt_version_id, corpus, scores, baseline_run_id, regressions, outcome,
            evaluated_by_kind, evaluated_by_id, evaluated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          run.evaluationRunId,
          run.subject.kind === 'model' ? run.subject.versionId : null,
          run.subject.kind === 'prompt' ? run.subject.versionId : null,
          run.corpus,
          JSON.stringify(run.scores),
          run.baselineRunId ?? null,
          [...run.regressions],
          run.outcome,
          evaluatedBy.kind,
          evaluatedBy.id,
          run.evaluatedAt,
        ],
      );
      return ok(run);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findById(evaluationRunId: string): Promise<Result<EvaluationRun, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<Row>(
        `SELECT evaluation_run_id, model_version_id, prompt_version_id, corpus, scores, baseline_run_id, regressions, outcome, evaluated_at
           FROM ai.evaluation_run WHERE evaluation_run_id = $1`,
        [evaluationRunId],
      );
      const row = rows[0];
      if (row === undefined) return err(notFound('evaluation run', evaluationRunId));

      let baseline: EvaluationRun | undefined;
      if (row.baseline_run_id !== null) {
        const found = await this.findById(row.baseline_run_id);
        if (!found.ok) return found;
        baseline = found.value;
      }
      const derived = evaluate({
        evaluationRunId: row.evaluation_run_id,
        subject: row.model_version_id !== null ? { kind: 'model', versionId: row.model_version_id } : { kind: 'prompt', versionId: row.prompt_version_id as string },
        corpus: row.corpus,
        scores: row.scores,
        ...(baseline === undefined ? {} : { baseline }),
        evaluatedAt: row.evaluated_at.toISOString(),
      });
      if (!derived.ok) return err(persistenceRejected(`stored evaluation run ${evaluationRunId} no longer satisfies the domain: ${derived.error.code}`, derived.error.location));
      if (derived.value.outcome !== row.outcome) {
        return err(persistenceRejected(`stored evaluation run ${evaluationRunId} says ${row.outcome} but its scores derive ${derived.value.outcome}`, 'outcome'));
      }
      return ok(derived.value);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async hasPassing(kind: SubjectKind, versionId: string): Promise<Result<boolean, RepositoryError>> {
    try {
      const column = kind === 'model' ? 'model_version_id' : 'prompt_version_id';
      const { rows } = await this.#pool.query(`SELECT 1 FROM ai.evaluation_run WHERE ${column} = $1 AND outcome = 'pass' LIMIT 1`, [versionId]);
      return ok(rows.length > 0);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
