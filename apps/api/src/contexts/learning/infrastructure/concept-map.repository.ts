import type { Pool } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { ConceptMapStore, ConceptResponse } from '../application/ports.js';
import type { ConceptMap } from '../domain/concept-map.js';
import type { ConceptState, MasteryState } from '../domain/concept-state.js';
import type { DifficultyEstimate, EvidenceOutcome } from '../domain/mastery-evidence.js';
import { err, ok, type Result } from '../domain/result.js';

const iso = (value: Date): string => value.toISOString();
const unavailable = (): ApplicationError => applicationError('Unavailable', 'LEARNING_STORE_UNAVAILABLE', "the learner's concept map could not be read");

interface StateRow {
  readonly concept_identity_id: string;
  readonly state: MasteryState;
  readonly raw_state: MasteryState;
  readonly confidence: number;
  readonly base_confidence: number;
  readonly low_confidence: boolean;
  readonly evidence_count: number;
  readonly distinct_item_count: number;
  readonly distinct_session_count: number;
  readonly last_evidence_at: Date | null;
  readonly difficulty_band_demonstrated: DifficultyEstimate | null;
  readonly decay_applied_at: Date;
  readonly evidence_ids: readonly string[];
}

/**
 * The learner's concept map as it is stored, read for the learner and nobody else (M8-28): every statement is scoped by the learner it is asked for. A state is read as it was stored, with its
 * responses named by the rows that produce them (a response a re-score withdrew is not one); decay is computed by the caller against the instant of the read, and this read applies none.
 */
export class PostgresConceptMapStore implements ConceptMapStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async states(learnerRef: string, taxonomyVersionId: string): Promise<Result<ConceptMap, ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<StateRow>(
        `SELECT s.concept_identity_id, s.state, s.raw_state, s.confidence, s.base_confidence, s.low_confidence, s.evidence_count, s.distinct_item_count,
                s.distinct_session_count, s.last_evidence_at, s.difficulty_band_demonstrated, s.decay_applied_at,
                COALESCE((SELECT array_agg(e.evidence_id ORDER BY e.occurred_at, e.evidence_id)
                            FROM learning.mastery_evidence e
                            LEFT JOIN LATERAL (SELECT outcome FROM learning.evidence_correction WHERE evidence_id = e.evidence_id ORDER BY correction_seq DESC LIMIT 1) c ON true
                           WHERE e.learner_ref = s.learner_ref AND e.taxonomy_version_id = s.taxonomy_version_id AND e.concept_identity_id = s.concept_identity_id
                             AND COALESCE(c.outcome, e.outcome) <> 'withdrawn'), '{}') AS evidence_ids
           FROM learning.concept_state s
          WHERE s.learner_ref = $1 AND s.taxonomy_version_id = $2
          ORDER BY s.concept_identity_id`,
        [learnerRef, taxonomyVersionId],
      );
      const states: ConceptState[] = rows.map((r) =>
        Object.freeze({
          conceptIdentityId: r.concept_identity_id,
          state: r.state,
          rawState: r.raw_state,
          confidence: r.confidence,
          baseConfidence: r.base_confidence,
          lowConfidence: r.low_confidence,
          evidenceCount: r.evidence_count,
          distinctItemCount: r.distinct_item_count,
          distinctSessionCount: r.distinct_session_count,
          lastEvidenceAt: r.last_evidence_at === null ? null : iso(r.last_evidence_at),
          difficultyBandDemonstrated: r.difficulty_band_demonstrated,
          decayAppliedAt: iso(r.decay_applied_at),
          evidenceIds: Object.freeze([...r.evidence_ids]),
        }),
      );
      const lastRecomputedAt = rows.reduce((latest, r) => (r.decay_applied_at > latest ? r.decay_applied_at : latest), new Date(0));
      return ok(Object.freeze({ learnerRef, taxonomyVersionId, conceptStates: Object.freeze(states), lastRecomputedAt: iso(lastRecomputedAt) }));
    } catch {
      return err(unavailable());
    }
  }

  async responses(
    learnerRef: string,
    taxonomyVersionId: string,
    conceptIdentityId: string,
    page: { readonly limit: number; readonly offset: number },
  ): Promise<Result<{ readonly total: number; readonly responses: readonly ConceptResponse[] }, ApplicationError>> {
    try {
      const { rows } = await this.#pool.query<{ evidence_id: string; attempt_ref: string; occurred_at: Date; outcome: EvidenceOutcome; difficulty_estimate: DifficultyEstimate; total: string }>(
        `SELECT e.evidence_id, e.attempt_ref, e.occurred_at, COALESCE(c.outcome, e.outcome) AS outcome, e.difficulty_estimate, count(*) OVER () AS total
           FROM learning.mastery_evidence e
           LEFT JOIN LATERAL (SELECT outcome FROM learning.evidence_correction WHERE evidence_id = e.evidence_id ORDER BY correction_seq DESC LIMIT 1) c ON true
          WHERE e.learner_ref = $1 AND e.taxonomy_version_id = $2 AND e.concept_identity_id = $3 AND COALESCE(c.outcome, e.outcome) <> 'withdrawn'
          ORDER BY e.occurred_at DESC, e.evidence_id DESC
          LIMIT $4 OFFSET $5`,
        [learnerRef, taxonomyVersionId, conceptIdentityId, page.limit, page.offset],
      );
      const first = rows[0];
      let total = first === undefined ? 0 : Number(first.total);
      if (first === undefined && page.offset > 0) {
        // a page past the end has no row to carry the count: ask for it, so "no more" is told apart from "there was never any"
        const counted = await this.#pool.query<{ total: string }>(
          `SELECT count(*) AS total FROM learning.mastery_evidence e
             LEFT JOIN LATERAL (SELECT outcome FROM learning.evidence_correction WHERE evidence_id = e.evidence_id ORDER BY correction_seq DESC LIMIT 1) c ON true
            WHERE e.learner_ref = $1 AND e.taxonomy_version_id = $2 AND e.concept_identity_id = $3 AND COALESCE(c.outcome, e.outcome) <> 'withdrawn'`,
          [learnerRef, taxonomyVersionId, conceptIdentityId],
        );
        total = Number(counted.rows[0]?.total ?? 0);
      }
      return ok(
        Object.freeze({
          total,
          responses: Object.freeze(
            rows.map((r) => Object.freeze({ evidenceId: r.evidence_id, attemptRef: r.attempt_ref, occurredAt: iso(r.occurred_at), outcome: r.outcome, difficultyEstimate: r.difficulty_estimate })),
          ),
        }),
      );
    } catch {
      return err(unavailable());
    }
  }
}
