import type { Pool, PoolClient } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import { LedgerAbort, type ConceptTracking, type EvidenceCorrectionOutcome, type LearningLedger, type LedgerTransaction, type NewEvidenceRow, type StoredAttemptEvidence } from '../application/ports.js';
import type { ConceptEvidence, ConceptState, MasteryState } from '../domain/concept-state.js';
import type { MasteryTransition } from '../domain/mastery-transition.js';
import type { DifficultyEstimate, EvidenceOutcome } from '../domain/mastery-evidence.js';
import { err, ok, type Result } from '../domain/result.js';
import type { ErrorEntry } from '../domain/error-entry.js';
import type { ReviewSchedule } from '../domain/review-schedule.js';
import type { StudySession } from '../domain/study-session.js';

/**
 * The learner's ledger in Postgres (M7-14). One transaction per learner, taken under an advisory lock on the learner so two deliveries for the same
 * learner are serialised and the second sees the first's sittings; nothing here can reach another learner's rows, because every statement is scoped by the
 * learner the transaction was opened for.
 *
 * Everything a delivery writes — evidence, the sittings it was placed in, the states it produced — commits together or not at all.
 */
export class PostgresLearningLedger implements LearningLedger {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async inTransaction<T>(learnerRef: string, work: (tx: LedgerTransaction) => Promise<T>): Promise<Result<T, ApplicationError>> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch {
      return unavailable();
    }
    let outcome: Result<T, ApplicationError>;
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [`learning:${learnerRef}`]);
      const value = await work(new PostgresLedgerTransaction(client, learnerRef));
      await client.query('COMMIT');
      outcome = ok(value);
    } catch (error) {
      await client.query('ROLLBACK');
      // A handler that chose to abort says why; anything else is the ledger failing, and never the statement or the driver's message (§8): a caller can
      // act on "could not be written" and on nothing more.
      outcome = error instanceof LedgerAbort ? err(error.failure) : unavailable();
    }
    client.release();
    return outcome;
  }
}

const unavailable = () => err(applicationError('Unavailable', 'LEDGER_UNAVAILABLE', "the learner's ledger could not be read or written"));

const iso = (value: Date): string => value.toISOString();

class PostgresLedgerTransaction implements LedgerTransaction {
  constructor(
    private readonly client: PoolClient,
    private readonly learnerRef: string,
  ) {}

  async insertEvidence(rows: readonly NewEvidenceRow[]): Promise<readonly NewEvidenceRow[]> {
    const stored: NewEvidenceRow[] = [];
    for (const row of rows) {
      const e = row.evidence;
      const { rowCount } = await this.client.query(
        `INSERT INTO learning.mastery_evidence
           (evidence_id, learner_ref, attempt_ref, slot_ref, item_version_ref, concept_identity_id, taxonomy_version_id, outcome,
            difficulty_estimate, occurred_at, scored_at, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (attempt_ref, slot_ref) DO NOTHING`,
        [row.evidenceId, this.learnerRef, e.attemptRef, e.slotRef, e.itemVersionRef, e.conceptIdentityId, e.taxonomyVersionId, e.outcome, e.difficultyEstimate, e.occurredAt, e.scoredAt, row.recordedAt],
      );
      if (rowCount === 1) stored.push(row);
    }
    return Object.freeze(stored);
  }

  async attemptEvidence(attemptRef: string): Promise<readonly StoredAttemptEvidence[]> {
    const { rows } = await this.client.query<{ evidence_id: string; slot_ref: string; concept_identity_id: string; taxonomy_version_id: string; outcome: EvidenceCorrectionOutcome }>(
      `SELECT e.evidence_id, e.slot_ref, e.concept_identity_id, e.taxonomy_version_id, COALESCE(c.outcome, e.outcome) AS outcome
         FROM learning.mastery_evidence e
         LEFT JOIN LATERAL (SELECT outcome FROM learning.evidence_correction WHERE evidence_id = e.evidence_id ORDER BY correction_seq DESC LIMIT 1) c ON true
        WHERE e.learner_ref = $1 AND e.attempt_ref = $2
        ORDER BY e.slot_ref`,
      [this.learnerRef, attemptRef],
    );
    return Object.freeze(rows.map((r) => Object.freeze({ evidenceId: r.evidence_id, slotRef: r.slot_ref, conceptIdentityId: r.concept_identity_id, taxonomyVersionId: r.taxonomy_version_id, outcome: r.outcome })));
  }

  async correctEvidence(corrections: readonly { readonly evidenceId: string; readonly outcome: EvidenceCorrectionOutcome }[], recordedAt: Date): Promise<void> {
    for (const correction of corrections) {
      await this.client.query('INSERT INTO learning.evidence_correction (evidence_id, outcome, recorded_at) VALUES ($1, $2, $3)', [correction.evidenceId, correction.outcome, recordedAt]);
    }
  }

  async activeTransitions(taxonomyVersionId: string, conceptIdentityId: string): Promise<readonly MasteryTransition[]> {
    const { rows } = await this.client.query<{
      transition_id: string;
      from_state: MasteryState;
      to_state: MasteryState;
      occurred_at: Date;
      verified_at: Date | null;
      is_regression: boolean;
      rule_set_id: string;
      rule_set_hash: string;
    }>(
      `SELECT transition_id, from_state, to_state, occurred_at, verified_at, is_regression, rule_set_id, rule_set_hash
         FROM learning.mastery_transition t
        WHERE learner_ref = $1 AND taxonomy_version_id = $2 AND concept_identity_id = $3
          AND NOT EXISTS (SELECT 1 FROM learning.transition_revocation r WHERE r.transition_id = t.transition_id)
        ORDER BY transition_seq`,
      [this.learnerRef, taxonomyVersionId, conceptIdentityId],
    );
    const links = rows.length === 0
      ? { rows: [] as { transition_id: string; evidence_id: string; role: 'qualifying' | 'verifying' }[] }
      : await this.client.query<{ transition_id: string; evidence_id: string; role: 'qualifying' | 'verifying' }>(
          'SELECT transition_id, evidence_id, role FROM learning.mastery_transition_evidence WHERE transition_id = ANY($1::uuid[]) ORDER BY evidence_id',
          [rows.map((r) => r.transition_id)],
        );
    const behind = (id: string, role: 'qualifying' | 'verifying') => Object.freeze(links.rows.filter((l) => l.transition_id === id && l.role === role).map((l) => l.evidence_id));
    return Object.freeze(
      rows.map((r) =>
        Object.freeze({
          transitionId: r.transition_id,
          conceptIdentityId,
          from: r.from_state,
          to: r.to_state,
          qualifyingEvidence: behind(r.transition_id, 'qualifying'),
          verifyingEvidence: behind(r.transition_id, 'verifying'),
          occurredAt: iso(r.occurred_at),
          verifiedAt: r.verified_at === null ? null : iso(r.verified_at),
          isRegression: r.is_regression,
          ruleSetId: r.rule_set_id,
          ruleSetHash: r.rule_set_hash,
        }),
      ),
    );
  }

  async revokeTransitions(transitionIds: readonly string[], revokedAt: Date): Promise<void> {
    for (const transitionId of transitionIds) {
      await this.client.query('INSERT INTO learning.transition_revocation (transition_id, revoked_at) VALUES ($1, $2)', [transitionId, revokedAt]);
    }
  }

  async sessions(): Promise<readonly StudySession[]> {
    const { rows } = await this.client.query<{ session_id: string; started_at: Date; ended_at: Date }>(
      'SELECT session_id, started_at, ended_at FROM learning.study_session WHERE learner_ref = $1 ORDER BY started_at, session_id',
      [this.learnerRef],
    );
    return Object.freeze(rows.map((r) => Object.freeze({ sessionId: r.session_id, startedAt: iso(r.started_at), endedAt: iso(r.ended_at) })));
  }

  async placeEvidence(evidenceId: string, session: StudySession, absorbed: readonly string[]): Promise<void> {
    await this.client.query(
      `INSERT INTO learning.study_session (session_id, learner_ref, started_at, ended_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id) DO UPDATE SET started_at = EXCLUDED.started_at, ended_at = EXCLUDED.ended_at`,
      [session.sessionId, this.learnerRef, session.startedAt, session.endedAt],
    );
    // the response itself, and every response that was in a sitting this one bridged
    await this.client.query(
      `UPDATE learning.mastery_evidence SET study_session_id = $1
        WHERE learner_ref = $2 AND (evidence_id = $3 OR study_session_id = ANY($4::uuid[]))`,
      [session.sessionId, this.learnerRef, evidenceId, absorbed],
    );
    if (absorbed.length > 0) {
      await this.client.query('DELETE FROM learning.study_session WHERE learner_ref = $1 AND session_id = ANY($2::uuid[])', [this.learnerRef, absorbed]);
    }
  }

  async conceptEvidence(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<ReadonlyMap<string, readonly ConceptEvidence[]>> {
    const { rows } = await this.client.query<{
      evidence_id: string;
      concept_identity_id: string;
      item_version_ref: string;
      outcome: EvidenceOutcome;
      difficulty_estimate: DifficultyEstimate;
      occurred_at: Date;
      study_session_id: string;
    }>(
      `SELECT e.evidence_id, e.concept_identity_id, e.item_version_ref, COALESCE(c.outcome, e.outcome) AS outcome, e.difficulty_estimate, e.occurred_at, e.study_session_id
         FROM learning.mastery_evidence e
         LEFT JOIN LATERAL (SELECT outcome FROM learning.evidence_correction WHERE evidence_id = e.evidence_id ORDER BY correction_seq DESC LIMIT 1) c ON true
        WHERE e.learner_ref = $1 AND e.taxonomy_version_id = $2 AND e.concept_identity_id = ANY($3::uuid[])
          AND COALESCE(c.outcome, e.outcome) <> 'withdrawn'
        ORDER BY e.occurred_at, e.evidence_id`,
      [this.learnerRef, taxonomyVersionId, conceptIdentityIds],
    );
    const byConcept = new Map<string, ConceptEvidence[]>();
    for (const r of rows) {
      const list = byConcept.get(r.concept_identity_id) ?? [];
      list.push(
        Object.freeze({
          evidenceId: r.evidence_id,
          itemVersionRef: r.item_version_ref,
          outcome: r.outcome,
          difficultyEstimate: r.difficulty_estimate,
          occurredAt: iso(r.occurred_at),
          sessionId: r.study_session_id,
        }),
      );
      byConcept.set(r.concept_identity_id, list);
    }
    return byConcept;
  }

  async saveConceptStates(taxonomyVersionId: string, states: readonly ConceptState[], ruleSetId: string, floors: ReadonlyMap<string, MasteryState | null>): Promise<void> {
    for (const s of states) {
      await this.client.query(
        `INSERT INTO learning.concept_state
           (learner_ref, taxonomy_version_id, concept_identity_id, state, raw_state, confidence, base_confidence, low_confidence, evidence_count,
            distinct_item_count, distinct_session_count, last_evidence_at, difficulty_band_demonstrated, decay_applied_at, rule_set_id, weakest_since_strong)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)
         ON CONFLICT (learner_ref, taxonomy_version_id, concept_identity_id) DO UPDATE SET
           state = EXCLUDED.state, raw_state = EXCLUDED.raw_state, confidence = EXCLUDED.confidence, base_confidence = EXCLUDED.base_confidence,
           low_confidence = EXCLUDED.low_confidence, evidence_count = EXCLUDED.evidence_count, distinct_item_count = EXCLUDED.distinct_item_count,
           distinct_session_count = EXCLUDED.distinct_session_count, last_evidence_at = EXCLUDED.last_evidence_at,
           difficulty_band_demonstrated = EXCLUDED.difficulty_band_demonstrated, decay_applied_at = EXCLUDED.decay_applied_at, rule_set_id = EXCLUDED.rule_set_id,
           weakest_since_strong = EXCLUDED.weakest_since_strong`,
        [
          this.learnerRef, taxonomyVersionId, s.conceptIdentityId, s.state, s.rawState, s.confidence, s.baseConfidence, s.lowConfidence, s.evidenceCount,
          s.distinctItemCount, s.distinctSessionCount, s.lastEvidenceAt, s.difficultyBandDemonstrated, s.decayAppliedAt, ruleSetId, floors.get(s.conceptIdentityId) ?? null,
        ],
      );
    }
  }

  async saveReviewSchedules(taxonomyVersionId: string, schedules: readonly ReviewSchedule[], ruleSetId: string): Promise<void> {
    for (const s of schedules) {
      await this.client.query(
        `INSERT INTO learning.review_schedule
           (learner_ref, taxonomy_version_id, concept_identity_id, due_at, interval_days, consecutive_successes, lapse_count, last_observed_at, rule_set_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (learner_ref, taxonomy_version_id, concept_identity_id) DO UPDATE SET
           due_at = EXCLUDED.due_at, interval_days = EXCLUDED.interval_days, consecutive_successes = EXCLUDED.consecutive_successes,
           lapse_count = EXCLUDED.lapse_count, last_observed_at = EXCLUDED.last_observed_at, rule_set_id = EXCLUDED.rule_set_id`,
        [this.learnerRef, taxonomyVersionId, s.conceptIdentityId, s.dueAt, s.intervalDays, s.consecutiveSuccesses, s.lapseCount, s.lastObservedAt, ruleSetId],
      );
    }
  }

  async escalate(taxonomyVersionId: string, escalations: readonly { readonly conceptIdentityId: string; readonly lapseCount: number }[], ruleSetId: string, escalatedAt: Date): Promise<readonly string[]> {
    const fresh: string[] = [];
    for (const e of escalations) {
      // one open escalation at a time (DEC-M7-27): a concept whose escalation stands is not escalated again, and one whose escalation was resolved can be
      const { rowCount } = await this.client.query(
        `INSERT INTO learning.review_escalation (learner_ref, taxonomy_version_id, concept_identity_id, escalated_at, lapse_count, rule_set_id)
         SELECT $1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::integer, $6::uuid
          WHERE NOT EXISTS (SELECT 1 FROM learning.open_review_escalation o WHERE o.learner_ref = $1::uuid AND o.taxonomy_version_id = $2::uuid AND o.concept_identity_id = $3::uuid)
         ON CONFLICT DO NOTHING`,
        [this.learnerRef, taxonomyVersionId, e.conceptIdentityId, escalatedAt, e.lapseCount, ruleSetId],
      );
      if (rowCount === 1) fresh.push(e.conceptIdentityId);
    }
    return fresh;
  }

  async resolveEscalations(taxonomyVersionId: string, resolutions: readonly { readonly conceptIdentityId: string; readonly reason: 'recovered' | 'lapses_corrected' }[], ruleSetId: string, resolvedAt: Date) {
    const resolved: { conceptIdentityId: string; reason: 'recovered' | 'lapses_corrected' }[] = [];
    for (const r of resolutions) {
      const { rowCount } = await this.client.query(
        `INSERT INTO learning.review_escalation_resolution (learner_ref, taxonomy_version_id, concept_identity_id, escalated_at, resolved_at, reason, rule_set_id)
         SELECT o.learner_ref, o.taxonomy_version_id, o.concept_identity_id, o.escalated_at, $4, $5, $6
           FROM learning.open_review_escalation o
          WHERE o.learner_ref = $1 AND o.taxonomy_version_id = $2 AND o.concept_identity_id = $3`,
        [this.learnerRef, taxonomyVersionId, r.conceptIdentityId, resolvedAt, r.reason, ruleSetId],
      );
      if (rowCount === 1) resolved.push({ conceptIdentityId: r.conceptIdentityId, reason: r.reason });
    }
    return resolved;
  }

  async dropReviewSchedules(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<void> {
    await this.client.query('DELETE FROM learning.review_schedule WHERE learner_ref = $1 AND taxonomy_version_id = $2 AND concept_identity_id = ANY($3::uuid[])', [this.learnerRef, taxonomyVersionId, conceptIdentityIds]);
  }

  async dropConceptStates(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<void> {
    await this.client.query('DELETE FROM learning.concept_state WHERE learner_ref = $1 AND taxonomy_version_id = $2 AND concept_identity_id = ANY($3::uuid[])', [this.learnerRef, taxonomyVersionId, conceptIdentityIds]);
  }

  async conceptTracking(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<ReadonlyMap<string, ConceptTracking>> {
    const floors = await this.client.query<{ concept_identity_id: string; weakest_since_strong: MasteryState | null }>(
      `SELECT concept_identity_id, weakest_since_strong FROM learning.concept_state
        WHERE learner_ref = $1 AND taxonomy_version_id = $2 AND concept_identity_id = ANY($3::uuid[])`,
      [this.learnerRef, taxonomyVersionId, conceptIdentityIds],
    );
    const last = await this.client.query<{
      transition_id: string;
      concept_identity_id: string;
      to_state: MasteryState;
      is_regression: boolean;
      occurred_at: Date;
      verified_at: Date | null;
      rule_set_id: string;
      rule_set_hash: string;
    }>(
      `SELECT DISTINCT ON (concept_identity_id) transition_id, concept_identity_id, to_state, is_regression, occurred_at, verified_at, rule_set_id, rule_set_hash
         FROM learning.mastery_transition t
        WHERE learner_ref = $1 AND taxonomy_version_id = $2 AND concept_identity_id = ANY($3::uuid[])
          AND NOT EXISTS (SELECT 1 FROM learning.transition_revocation r WHERE r.transition_id = t.transition_id)
        ORDER BY concept_identity_id, transition_seq DESC`,
      [this.learnerRef, taxonomyVersionId, conceptIdentityIds],
    );
    const links = last.rows.length === 0
      ? { rows: [] as { transition_id: string; evidence_id: string }[] }
      : await this.client.query<{ transition_id: string; evidence_id: string }>(
          `SELECT transition_id, evidence_id FROM learning.mastery_transition_evidence WHERE role = 'qualifying' AND transition_id = ANY($1::uuid[]) ORDER BY evidence_id`,
          [last.rows.map((r) => r.transition_id)],
        );
    const floorOf = new Map(floors.rows.map((r) => [r.concept_identity_id, r.weakest_since_strong]));
    const tracking = new Map<string, ConceptTracking>();
    for (const concept of conceptIdentityIds) {
      const row = last.rows.find((r) => r.concept_identity_id === concept);
      const held = row !== undefined && row.to_state === 'strong' && !row.is_regression;
      tracking.set(
        concept,
        Object.freeze({
          held,
          floor: floorOf.get(concept) ?? null,
          open:
            held && row.verified_at === null
              ? Object.freeze({
                  transitionId: row.transition_id,
                  occurredAt: iso(row.occurred_at),
                  qualifyingEvidence: Object.freeze(links.rows.filter((l) => l.transition_id === row.transition_id).map((l) => l.evidence_id)),
                  ruleSetId: row.rule_set_id,
                  ruleSetHash: row.rule_set_hash,
                })
              : null,
        }),
      );
    }
    return tracking;
  }

  async saveTransitions(taxonomyVersionId: string, transitions: readonly MasteryTransition[], recordedAt: Date): Promise<void> {
    for (const t of transitions) {
      await this.client.query(
        `INSERT INTO learning.mastery_transition
           (transition_id, learner_ref, taxonomy_version_id, concept_identity_id, from_state, to_state, occurred_at, verified_at, is_regression, rule_set_id, rule_set_hash, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [t.transitionId, this.learnerRef, taxonomyVersionId, t.conceptIdentityId, t.from, t.to, t.occurredAt, t.verifiedAt, t.isRegression, t.ruleSetId, t.ruleSetHash, recordedAt],
      );
      for (const [role, ids] of [['qualifying', t.qualifyingEvidence], ['verifying', t.verifyingEvidence]] as const) {
        for (const evidenceId of ids) {
          await this.client.query('INSERT INTO learning.mastery_transition_evidence (transition_id, evidence_id, role) VALUES ($1, $2, $3)', [t.transitionId, evidenceId, role]);
        }
      }
    }
  }

  async verifyTransition(transitionId: string, verifiedAt: string, verifyingEvidence: readonly string[]): Promise<void> {
    await this.client.query('UPDATE learning.mastery_transition SET verified_at = $2 WHERE transition_id = $1', [transitionId, verifiedAt]);
    for (const evidenceId of verifyingEvidence) {
      await this.client.query(`INSERT INTO learning.mastery_transition_evidence (transition_id, evidence_id, role) VALUES ($1, $2, 'verifying')`, [transitionId, evidenceId]);
    }
  }

  async insertErrorEntries(entries: readonly ErrorEntry[], recordedAt: Date): Promise<void> {
    for (const e of entries) {
      await this.client.query(
        `INSERT INTO learning.error_entry
           (error_entry_id, learner_ref, attempt_ref, slot_ref, item_version_ref, concept_identity_id, taxonomy_version_id, kind, error_cause, occurred_at, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (attempt_ref, slot_ref) DO NOTHING`,
        [e.errorEntryId, this.learnerRef, e.attemptRef, e.slotRef, e.itemVersionRef, e.conceptIdentityId, e.taxonomyVersionId, e.kind, e.errorCause, e.occurredAt, recordedAt],
      );
    }
  }

  async resolveErrorEntries(transitionId: string): Promise<number> {
    // The table's guard decides whether this transition may clear what is selected, and aborts the transaction if it may not.
    const { rowCount } = await this.client.query(
      `UPDATE learning.error_entry e
          SET resolved_by_transition_id = t.transition_id
         FROM learning.mastery_transition t
        WHERE t.transition_id = $1
          AND e.learner_ref = $2
          AND e.taxonomy_version_id = t.taxonomy_version_id
          AND e.concept_identity_id = t.concept_identity_id
          AND e.resolved_by_transition_id IS NULL
          AND e.occurred_at <= t.occurred_at`,
      [transitionId, this.learnerRef],
    );
    return Number(rowCount);
  }
}
