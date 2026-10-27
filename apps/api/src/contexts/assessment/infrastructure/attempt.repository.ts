import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { restoreAttempt, type Attempt, type AttemptSlot, type SubmissionReason } from '../domain/attempt.js';
import type { AttemptState } from '../domain/attempt-state.js';
import type { AttemptRepository, RepositoryError } from '../domain/repository-ports.js';
import type { AssessmentEvent } from '../domain/events/assessment-events.js';
import { AssessmentOutboxEmitter } from './outbox-emitter.js';
import { conflict, fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface AttemptRow {
  readonly attempt_id: string;
  readonly student_id: string;
  readonly mode: 'mock' | 'practice' | 'diagnostic';
  readonly form_id: string | null;
  readonly exam_profile_version_id: string;
  readonly marking_rule_set_hash: string;
  readonly taxonomy_version_id: string;
  readonly delivery_policy: Record<string, unknown>;
  readonly session_ref: string | null;
  readonly shift_id: string | null;
  readonly duration_ms: string | null;
  readonly interval_cap_ms: number;
  readonly window_closes_at: Date | null;
  readonly created_at: Date;
  readonly state: AttemptState;
  readonly started_at: Date | null;
  readonly deadline_at: Date | null;
  readonly submitted_at: Date | null;
  readonly submission_reason: SubmissionReason | null;
  readonly idempotency_key: string | null;
  readonly abandoned_at: Date | null;
}

interface SlotRow {
  readonly slot_id: string;
  readonly ordinal: number;
  readonly item_id: string;
  readonly item_version_id: string;
  readonly stimulus_version_id: string | null;
}

const SELECT_ATTEMPT = `SELECT attempt_id, student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash,
       taxonomy_version_id, delivery_policy, session_ref, shift_id, duration_ms, interval_cap_ms, window_closes_at, created_at,
       state, started_at, deadline_at, submitted_at, submission_reason, idempotency_key, abandoned_at
  FROM assessment.attempt`;

const iso = (value: Date | null): string | null => (value === null ? null : value.toISOString());

/**
 * An attempt is written once with its slots, then only moves along the state
 * machine. The unique index that holds "one active mock per student" does its
 * work here: two attempts created at once for one student cannot both succeed,
 * and the loser is told so as a `CONFLICT` rather than finding out later.
 */
export class PostgresAttemptRepository implements AttemptRepository {
  readonly #pool: Pool;
  readonly #outbox = new AssessmentOutboxEmitter();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async create(attempt: Attempt, creationKey?: string): Promise<Result<Attempt, RepositoryError>> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      return err(fromDatabaseError(error));
    }
    // `#insert` returns a value whatever happens (it catches), so the connection is released on every path.
    const outcome = await this.#insert(client, attempt, creationKey);
    client.release();
    return outcome;
  }

  async #insert(client: PoolClient, attempt: Attempt, creationKey: string | undefined): Promise<Result<Attempt, RepositoryError>> {
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO assessment.attempt
           (attempt_id, student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash, taxonomy_version_id,
            delivery_policy, session_ref, shift_id, is_timed, duration_ms, interval_cap_ms, window_closes_at, created_at, creation_key)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [
          attempt.attemptId,
          attempt.studentId,
          attempt.mode,
          attempt.formId,
          attempt.examProfileVersionId,
          attempt.markingRuleSetHash,
          attempt.taxonomyVersionId,
          JSON.stringify(attempt.deliveryPolicy),
          attempt.sessionRef,
          attempt.shiftId,
          attempt.isTimed,
          attempt.durationMs,
          attempt.intervalCapMs,
          attempt.windowClosesAt,
          attempt.createdAt,
          creationKey ?? null,
        ],
      );
      for (const slot of attempt.slots) {
        await client.query(
          `INSERT INTO assessment.attempt_slot (attempt_id, slot_id, ordinal, item_id, item_version_id, stimulus_version_id)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [attempt.attemptId, slot.slotId, slot.ordinal, slot.itemId, slot.itemVersionId, slot.stimulusVersionId],
        );
        if (attempt.formId === null) await this.#expose(client, attempt.attemptId, slot, attempt.createdAt);
      }
      await client.query('COMMIT');
      return ok(attempt);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  async appendSlot(attemptId: string, slot: AttemptSlot, writtenAt: string): Promise<Result<AttemptSlot, RepositoryError>> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      return err(fromDatabaseError(error));
    }
    // `#append` returns a value whatever happens (it catches), so the connection is released on every path.
    const outcome = await this.#append(client, attemptId, slot, writtenAt);
    client.release();
    return outcome;
  }

  async #append(client: PoolClient, attemptId: string, slot: AttemptSlot, writtenAt: string): Promise<Result<AttemptSlot, RepositoryError>> {
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO assessment.attempt_slot (attempt_id, slot_id, ordinal, item_id, item_version_id, stimulus_version_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [attemptId, slot.slotId, slot.ordinal, slot.itemId, slot.itemVersionId, slot.stimulusVersionId],
      );
      // Only an attempt with no form grows; its delivery is exposure, written in the transaction that pins the slot (M7-30).
      // For an attempt that has a form the database has already refused the slot above, so this line is not reached.
      await this.#expose(client, attemptId, slot, writtenAt);
      await client.query('COMMIT');
      return ok(slot);
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  /**
   * The exposure ledger's second writer (M7-30): a practice delivery, keyed by the attempt slot that made it. The first is publication, for a form's
   * slots, in `form.repository.ts`. A fitness spec names both files and nothing else; the database holds the other direction (a formless slot
   * with no row here fails at commit). The key and why it is not the form-and-session one: DEC-M7-14, ADR-0049.
   */
  async #expose(client: PoolClient, attemptId: string, slot: AttemptSlot, writtenAt: string): Promise<void> {
    await client.query(
      `INSERT INTO assessment.exposure_ledger_entry (attempt_id, slot_id, item_id, item_version_id, written_at)
       VALUES ($1, $2, $3, $4, $5)`,
      [attemptId, slot.slotId, slot.itemId, slot.itemVersionId, writtenAt],
    );
  }

  async itemsSeenBy(studentId: string): Promise<Result<ReadonlySet<string>, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<{ item_id: string }>(
        `SELECT DISTINCT s.item_id FROM assessment.attempt_slot s JOIN assessment.attempt a USING (attempt_id) WHERE a.student_id = $1`,
        [studentId],
      );
      return ok(new Set(rows.map((row) => row.item_id)));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async save(attempt: Attempt, expected: AttemptState, event?: AssessmentEvent): Promise<Result<Attempt, RepositoryError>> {
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch (error) {
      return err(fromDatabaseError(error));
    }
    // `#move` returns a value whatever happens (it catches), so the connection is released on every path.
    const outcome = await this.#move(client, attempt, expected, event);
    client.release();
    return outcome;
  }

  async #move(client: PoolClient, attempt: Attempt, expected: AttemptState, event: AssessmentEvent | undefined): Promise<Result<Attempt, RepositoryError>> {
    try {
      await client.query('BEGIN');
      const { rowCount } = await client.query(
        `UPDATE assessment.attempt
            SET state = $3, started_at = $4, deadline_at = $5, submitted_at = $6,
                submission_reason = $7, idempotency_key = $8, abandoned_at = $9
          WHERE attempt_id = $1 AND state = $2`,
        [
          attempt.attemptId,
          expected,
          attempt.state,
          attempt.startedAt,
          attempt.deadline,
          attempt.submission?.submittedAt ?? null,
          attempt.submission?.reason ?? null,
          attempt.submission?.idempotencyKey ?? null,
          attempt.abandonedAt,
        ],
      );
      if (rowCount === 1) {
        // Only a move that happened has an event: the winner of a race writes it, the loser rolls back with nothing.
        if (event !== undefined) await this.#outbox.emit(client, event);
        await client.query('COMMIT');
        return ok(attempt);
      }
      await client.query('ROLLBACK');
      const present = await this.#pool.query('SELECT state FROM assessment.attempt WHERE attempt_id = $1', [attempt.attemptId]);
      return present.rows.length === 0
        ? err(notFound('attempt', attempt.attemptId))
        : err(conflict(`the attempt is no longer ${expected}`, 'state'));
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      return err(fromDatabaseError(error));
    }
  }

  async findById(attemptId: string): Promise<Result<Attempt, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<AttemptRow>(`${SELECT_ATTEMPT} WHERE attempt_id = $1`, [attemptId]);
      const row = rows[0];
      return row === undefined ? err(notFound('attempt', attemptId)) : await this.#hydrate(row);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findByCreationKey(studentId: string, creationKey: string): Promise<Result<Attempt | undefined, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<AttemptRow>(`${SELECT_ATTEMPT} WHERE student_id = $1 AND creation_key = $2`, [studentId, creationKey]);
      const row = rows[0];
      return row === undefined ? ok(undefined) : await this.#hydrate(row);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findActiveMock(studentId: string): Promise<Result<Attempt | undefined, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<AttemptRow>(
        `${SELECT_ATTEMPT} WHERE student_id = $1 AND mode = 'mock' AND state IN ('created', 'in_progress')`,
        [studentId],
      );
      const row = rows[0];
      if (row === undefined) return ok(undefined);
      return await this.#hydrate(row);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findAbandonable(now: string, limit: number): Promise<Result<readonly Attempt[], RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<AttemptRow>(
        `${SELECT_ATTEMPT} WHERE state IN ('created', 'in_progress') AND window_closes_at <= $1 ORDER BY window_closes_at, attempt_id LIMIT $2`,
        [now, limit],
      );
      const attempts: Attempt[] = [];
      for (const row of rows) {
        const hydrated = await this.#hydrate(row);
        if (!hydrated.ok) return hydrated;
        attempts.push(hydrated.value);
      }
      return ok(Object.freeze(attempts));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async findExpired(now: string, limit: number): Promise<Result<readonly Attempt[], RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<AttemptRow>(
        `${SELECT_ATTEMPT} WHERE state = 'in_progress' AND deadline_at <= $1 ORDER BY deadline_at, attempt_id LIMIT $2`,
        [now, limit],
      );
      const attempts: Attempt[] = [];
      for (const row of rows) {
        const hydrated = await this.#hydrate(row);
        if (!hydrated.ok) return hydrated;
        attempts.push(hydrated.value);
      }
      return ok(Object.freeze(attempts));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async #hydrate(row: AttemptRow): Promise<Result<Attempt, RepositoryError>> {
    const slots = await this.#pool.query<SlotRow>(
      `SELECT slot_id, ordinal, item_id, item_version_id, stimulus_version_id
         FROM assessment.attempt_slot WHERE attempt_id = $1 ORDER BY ordinal`,
      [row.attempt_id],
    );
    const restored = restoreAttempt({
      attemptId: row.attempt_id,
      studentId: row.student_id,
      mode: row.mode,
      formId: row.form_id,
      examProfileVersionId: row.exam_profile_version_id,
      markingRuleSetHash: row.marking_rule_set_hash,
      taxonomyVersionId: row.taxonomy_version_id,
      deliveryPolicy: row.delivery_policy,
      sessionRef: row.session_ref,
      shiftId: row.shift_id,
      slots: slots.rows.map<AttemptSlot>((slot) => ({
        slotId: slot.slot_id,
        ordinal: slot.ordinal,
        itemId: slot.item_id,
        itemVersionId: slot.item_version_id,
        stimulusVersionId: slot.stimulus_version_id,
      })),
      durationMs: row.duration_ms === null ? null : Number(row.duration_ms),
      intervalCapMs: row.interval_cap_ms,
      windowClosesAt: iso(row.window_closes_at),
      createdAt: row.created_at.toISOString(),
      state: row.state,
      startedAt: iso(row.started_at),
      deadline: iso(row.deadline_at),
      submission:
        row.submitted_at === null
          ? null
          : {
              reason: row.submission_reason as SubmissionReason,
              idempotencyKey: row.idempotency_key as string,
              submittedAt: row.submitted_at.toISOString(),
            },
      abandonedAt: iso(row.abandoned_at),
    });
    return restored.ok
      ? ok(restored.value)
      : err(persistenceRejected(`stored attempt ${row.attempt_id} no longer satisfies the domain: ${restored.error.code}`, restored.error.location));
  }
}
