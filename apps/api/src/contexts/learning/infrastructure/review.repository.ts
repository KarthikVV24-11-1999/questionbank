import type { Pool } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { EscalatedConcept, ReviewStore, ScheduledConcept } from '../application/ports.js';
import { err, ok, type Result } from '../domain/result.js';

interface Row {
  readonly taxonomy_version_id: string;
  readonly concept_identity_id: string;
  readonly due_at: Date;
  readonly interval_days: number;
  readonly consecutive_successes: number;
  readonly lapse_count: number;
  readonly last_observed_at: Date;
}

/**
 * The learner's review schedule, read for the learner and nobody else: every statement is scoped by the learner it is asked for. An escalation stands until the fold that made it resolves it, by the concept recovering
 * or by a re-score taking its lapses away (D85); what is due and what is escalated read only those that stand.
 */
export class PostgresReviewStore implements ReviewStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async due(learnerRef: string, asOf: Date): Promise<Result<readonly ScheduledConcept[], ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<Row>(
        `SELECT taxonomy_version_id, concept_identity_id, due_at, interval_days, consecutive_successes, lapse_count, last_observed_at
           FROM learning.review_schedule
          WHERE learner_ref = $1 AND due_at <= $2
            AND NOT EXISTS (SELECT 1 FROM learning.open_review_escalation e
                             WHERE e.learner_ref = review_schedule.learner_ref AND e.taxonomy_version_id = review_schedule.taxonomy_version_id
                               AND e.concept_identity_id = review_schedule.concept_identity_id)
          ORDER BY due_at, taxonomy_version_id, concept_identity_id`,
        [learnerRef, asOf],
      );
      return ok(
        Object.freeze(
          rows.map((r) =>
            Object.freeze({
              taxonomyVersionId: r.taxonomy_version_id,
              conceptIdentityId: r.concept_identity_id,
              dueAt: r.due_at.toISOString(),
              intervalDays: r.interval_days,
              consecutiveSuccesses: r.consecutive_successes,
              lapseCount: r.lapse_count,
              lastObservedAt: r.last_observed_at.toISOString(),
            }),
          ),
        ),
      );
    } catch {
      return err(applicationError('Unavailable', 'LEARNING_STORE_UNAVAILABLE', "the learner's review schedule could not be read"));
    }
  }

  async escalations(learnerRef: string): Promise<Result<readonly EscalatedConcept[], ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<{ taxonomy_version_id: string; concept_identity_id: string; lapse_count: number; escalated_at: Date }>(
        `SELECT taxonomy_version_id, concept_identity_id, lapse_count, escalated_at
           FROM learning.open_review_escalation
          WHERE learner_ref = $1
          ORDER BY escalated_at, taxonomy_version_id, concept_identity_id`,
        [learnerRef],
      );
      return ok(Object.freeze(rows.map((r) => Object.freeze({ taxonomyVersionId: r.taxonomy_version_id, conceptIdentityId: r.concept_identity_id, lapseCount: r.lapse_count, escalatedAt: r.escalated_at.toISOString() }))));
    } catch {
      return err(applicationError('Unavailable', 'LEARNING_STORE_UNAVAILABLE', "the learner's escalations could not be read"));
    }
  }
}
