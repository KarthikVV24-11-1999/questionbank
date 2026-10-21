import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ATTEMPT_STATES, canMove, type AttemptState } from '../contexts/assessment/domain/attempt-state.js';
import { insertEvent, refusal, seedAttempt, seedForm, startAttemptRow, submitAttemptRow } from './assessment-db.js';
import { TAG, id } from './assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from './database.js';

/**
 * M6-12 — the append-only and immutability rules, proven the only way that
 * counts: by attempting the write and being refused, as the owner (the trigger
 * is the control) and as the application role (the grant is the control).
 * Reading the grant table would prove what was written down, not what holds.
 *
 * Each trigger is also shown to be the thing doing the refusing: dropped
 * inside a transaction that is rolled back, the same write goes through. A
 * refusal nobody has seen go the other way might be refusing for another
 * reason entirely.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

beforeEach(async () => {
  await database.pool.query(
    'TRUNCATE assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE',
  );
});

/** Runs `work` as the application role, on its own connection, and always puts the role back. */
async function asApp<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query('SET ROLE questionbank_app');
    return await work(client);
  } finally {
    await client.query('RESET ROLE');
    client.release();
  }
}

/** Runs `work` in a transaction that is rolled back, so a plant never outlives the test. */
async function rolledBack<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await database.pool.connect();
  try {
    await client.query('BEGIN');
    return await work(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}

async function liveAttempt(): Promise<string> {
  const formId = await seedForm(database.pool);
  const attemptId = await seedAttempt(database.pool, { formId });
  await startAttemptRow(database.pool, attemptId);
  return attemptId;
}

describe('the response log is append-only, at the database', () => {
  it('refuses UPDATE and DELETE from the owner, by trigger', async () => {
    const attemptId = await liveAttempt();
    await insertEvent(database.pool, attemptId, 1);
    expect(await refusal(() => database.pool.query(`UPDATE assessment.response_event SET answer = '"B"'`))).toContain('is append-only and rejects update');
    expect(await refusal(() => database.pool.query(`DELETE FROM assessment.response_event`))).toContain('is append-only and rejects delete');
  });

  it('refuses UPDATE, DELETE and TRUNCATE from the application role, by grant', async () => {
    const attemptId = await liveAttempt();
    await insertEvent(database.pool, attemptId, 1);
    await asApp(async (client) => {
      expect(await refusal(() => client.query(`UPDATE assessment.response_event SET answer = '"B"'`))).toContain('permission denied');
      expect(await refusal(() => client.query(`DELETE FROM assessment.response_event`))).toContain('permission denied');
      expect(await refusal(() => client.query(`TRUNCATE assessment.response_event`))).toContain('permission denied');
    });
    const { rows } = await database.pool.query(`SELECT answer FROM assessment.response_event`);
    expect(rows).toEqual([{ answer: 'A' }]);
  });

  it('still lets the application role append and read', async () => {
    const attemptId = await liveAttempt();
    await asApp(async (client) => {
      await client.query(
        `INSERT INTO assessment.response_event (event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms, server_received_at, device_ref)
         VALUES ($1, $2, $3, $4, 1, 'select', '"A"', 10, now(), 'phone')`,
        [id(TAG.event, 1), attemptId, id(TAG.slot, 1), id(TAG.itemVersion, 1)],
      );
      expect((await client.query(`SELECT count(*)::int AS n FROM assessment.response_event`)).rows[0]).toEqual({ n: 1 });
    });
  });

  it('is the trigger that refuses: with it dropped, the same UPDATE goes through', async () => {
    const attemptId = await liveAttempt();
    await insertEvent(database.pool, attemptId, 1);
    const changed = await rolledBack(async (client) => {
      await client.query('DROP TRIGGER response_event_append_only ON assessment.response_event');
      return (await client.query(`UPDATE assessment.response_event SET answer = '"B"'`)).rowCount;
    });
    expect(changed).toBe(1);
    expect((await database.pool.query(`SELECT answer FROM assessment.response_event`)).rows).toEqual([{ answer: 'A' }]);
  });

  it('keeps every change of answer as its own row: nothing collapses them', async () => {
    const attemptId = await liveAttempt();
    await insertEvent(database.pool, attemptId, 1, { kind: 'select', answer: '"A"' });
    await insertEvent(database.pool, attemptId, 2, { kind: 'change', answer: '"B"' });
    await insertEvent(database.pool, attemptId, 3, { kind: 'change', answer: '"C"' });
    const { rows } = await database.pool.query(`SELECT kind, answer FROM assessment.response_event ORDER BY sequence`);
    expect(rows).toEqual([
      { kind: 'select', answer: 'A' },
      { kind: 'change', answer: 'B' },
      { kind: 'change', answer: 'C' },
    ]);
  });
});

describe('pinned slots are append-only', () => {
  it('refuses UPDATE and DELETE from the owner and the application role, and TRUNCATE from the latter', async () => {
    const attemptId = await liveAttempt();
    expect(await refusal(() => database.pool.query(`UPDATE assessment.attempt_slot SET item_version_id = $1`, [id(TAG.itemVersion, 99)]))).toContain('append-only');
    expect(await refusal(() => database.pool.query(`DELETE FROM assessment.attempt_slot`))).toContain('append-only');
    await asApp(async (client) => {
      expect(await refusal(() => client.query(`UPDATE assessment.attempt_slot SET ordinal = 9`))).toContain('permission denied');
      expect(await refusal(() => client.query(`DELETE FROM assessment.attempt_slot`))).toContain('permission denied');
      expect(await refusal(() => client.query(`TRUNCATE assessment.attempt_slot`))).toContain('permission denied');
    });
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM assessment.attempt_slot WHERE attempt_id = $1`, [attemptId])).rows[0]).toEqual({ n: 6 });
  });

  it('can be written only while the attempt is created', async () => {
    const attemptId = await liveAttempt();
    const message = await refusal(() =>
      database.pool.query(
        `INSERT INTO assessment.attempt_slot (attempt_id, slot_id, ordinal, item_id, item_version_id) VALUES ($1, $2, 99, $3, $4)`,
        [attemptId, id(TAG.slot, 99), id(TAG.item, 99), id(TAG.itemVersion, 99)],
      ),
    );
    expect(message).toContain('assessment_slots_are_pinned_at_creation');
  });
});

describe('a published form is immutable (D-006)', () => {
  it('refuses every write to the form, its sections and its slots, with no attempt in sight', async () => {
    const formId = await seedForm(database.pool);
    const refused = (query: string, params: unknown[] = []) => refusal(() => database.pool.query(query, params));
    expect(await refused(`UPDATE assessment.form SET form_type = 'diagnostic' WHERE form_id = $1`, [formId])).toContain('assessment_published_form_is_immutable');
    expect(await refused(`DELETE FROM assessment.form WHERE form_id = $1`, [formId])).toContain('assessment_published_form_is_immutable');
    expect(await refused(`UPDATE assessment.form_section SET section_spec_ref = 'x' WHERE form_id = $1`, [formId])).toContain('assessment_published_form_is_immutable');
    expect(await refused(`DELETE FROM assessment.form_section WHERE form_id = $1`, [formId])).toContain('assessment_published_form_is_immutable');
    expect(await refused(`UPDATE assessment.form_slot SET item_version_id = $2 WHERE form_id = $1`, [formId, id(TAG.itemVersion, 99)])).toContain('assessment_published_form_is_immutable');
    expect(await refused(`DELETE FROM assessment.form_slot WHERE form_id = $1`, [formId])).toContain('assessment_published_form_is_immutable');
    expect(
      await refused(
        `INSERT INTO assessment.form_slot (slot_id, form_id, section_ordinal, ordinal, item_id, item_version_id, marks_available, is_anchor) VALUES ($1, $2, 1, 99, $3, $4, 4, false)`,
        [id(TAG.slot, 99), formId, id(TAG.item, 99), id(TAG.itemVersion, 99)],
      ),
    ).toContain('assessment_published_form_is_immutable');
    expect(await refused(`INSERT INTO assessment.form_section (form_id, ordinal, section_spec_ref) VALUES ($1, 9, 'x')`, [formId])).toContain('assessment_published_form_is_immutable');
  });

  it('refuses the same writes from the application role, which does hold UPDATE and DELETE on forms', async () => {
    const formId = await seedForm(database.pool);
    await asApp(async (client) => {
      expect(await refusal(() => client.query(`UPDATE assessment.form_slot SET item_version_id = $2 WHERE form_id = $1`, [formId, id(TAG.itemVersion, 99)]))).toContain('assessment_published_form_is_immutable');
      expect(await refusal(() => client.query(`DELETE FROM assessment.form_slot WHERE form_id = $1`, [formId]))).toContain('assessment_published_form_is_immutable');
      expect(await refusal(() => client.query(`TRUNCATE assessment.form_slot`))).toContain('permission denied');
    });
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM assessment.form_slot`)).rows[0]).toEqual({ n: 6 });
  });

  it('lets a draft be edited and deleted, including by the application role, and then published', async () => {
    const formId = await seedForm(database.pool, { publish: false });
    await asApp(async (client) => {
      await client.query(`UPDATE assessment.form_slot SET item_version_id = $2 WHERE slot_id = $1`, [id(TAG.slot, 1), id(TAG.itemVersion, 41)]);
      await client.query(`DELETE FROM assessment.form_slot WHERE slot_id = $1`, [id(TAG.slot, 6)]);
      await client.query(`UPDATE assessment.form SET state = 'published', published_at = now() WHERE form_id = $1`, [formId]);
    });
    const { rows } = await database.pool.query(`SELECT count(*)::int AS n FROM assessment.form_slot WHERE form_id = $1`, [formId]);
    expect(rows[0]).toEqual({ n: 5 });
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form_slot SET marks_available = 9 WHERE form_id = $1`, [formId]))).toContain('immutable');
  });

  it('is the triggers that refuse: with them dropped, the same edit goes through', async () => {
    const formId = await seedForm(database.pool);
    const changed = await rolledBack(async (client) => {
      await client.query('DROP TRIGGER form_slot_frozen_with_its_form ON assessment.form_slot');
      return (await client.query(`UPDATE assessment.form_slot SET marks_available = 9 WHERE form_id = $1`, [formId])).rowCount;
    });
    expect(changed).toBe(6);
  });

  it('refuses an attempt against a form that is still a draft', async () => {
    const formId = await seedForm(database.pool, { publish: false });
    expect(await refusal(() => seedAttempt(database.pool, { formId }))).toContain('assessment_attempt_requires_published_form');
  });
});

describe('an attempt moves only along the state machine, and keeps its pin', () => {
  it('refuses to change what the attempt is', async () => {
    const attemptId = await liveAttempt();
    for (const set of [
      `student_id = '${id(TAG.student, 9)}'`,
      `marking_rule_set_hash = '${'c'.repeat(64)}'`,
      `shift_id = 'other'`,
      `session_id = '${id(TAG.session, 9)}'`,
      `duration_ms = 1`,
      `window_closes_at = now()`,
      `delivery_policy = '{}'`,
    ]) {
      expect(await refusal(() => database.pool.query(`UPDATE assessment.attempt SET ${set} WHERE attempt_id = $1`, [attemptId])), set).toContain('assessment_attempt_pin_is_immutable');
    }
  });

  it('refuses to move the deadline once it is anchored', async () => {
    const attemptId = await liveAttempt();
    const message = await refusal(() =>
      database.pool.query(
        `UPDATE assessment.attempt SET state = 'submitted', submitted_at = now(), submission_reason = 'manual', idempotency_key = 'k',
                deadline_at = deadline_at + interval '1 hour' WHERE attempt_id = $1`,
        [attemptId],
      ),
    );
    expect(message).toContain('assessment_attempt_deadline_is_anchored');
  });

  it('is never deleted, by the owner or the application role', async () => {
    const attemptId = await liveAttempt();
    expect(await refusal(() => database.pool.query(`DELETE FROM assessment.attempt WHERE attempt_id = $1`, [attemptId]))).toContain('is append-only and rejects delete');
    await asApp(async (client) => {
      expect(await refusal(() => client.query(`DELETE FROM assessment.attempt`))).toContain('permission denied');
      expect(await refusal(() => client.query(`TRUNCATE assessment.attempt`))).toContain('permission denied');
    });
  });

  // Two implementations of one rule: the domain's table and this trigger are
  // held to the same answer over every pair of states.
  describe('agrees with the domain over every pair of states (rule 5)', () => {
    /** Row values that satisfy the state-shape check, so only the trigger can refuse the move. */
    const SHAPE: Record<AttemptState, string> = {
      created: `state = 'created', started_at = NULL, deadline_at = NULL`,
      in_progress: `state = 'in_progress', started_at = '2026-10-21T09:00:00Z', deadline_at = '2026-10-21T12:00:00Z'`,
      submitted: `state = 'submitted', started_at = '2026-10-21T09:00:00Z', deadline_at = '2026-10-21T12:00:00Z', submitted_at = now(), submission_reason = 'manual', idempotency_key = 'k'`,
      abandoned: `state = 'abandoned', abandoned_at = now()`,
    };

    /** Puts a fresh attempt into `state` by seeding it there, bypassing the guard inside a rolled-back transaction. */
    async function inState(client: PoolClient, state: AttemptState): Promise<string> {
      const attemptId = id(TAG.attempt, 50);
      await client.query(
        `INSERT INTO assessment.attempt
           (attempt_id, student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash, taxonomy_version_id,
            delivery_policy, session_id, shift_id, duration_ms, window_closes_at, created_at)
         VALUES ($1, $2, 'mock', $3, $4, $5, $6, '{}', $7, 'shift-1', 1000, now(), now())`,
        [attemptId, id(TAG.student, 50), id(TAG.form), id(TAG.profile), 'a'.repeat(64), id(TAG.taxonomy), id(TAG.session)],
      );
      if (state !== 'created') {
        await client.query('ALTER TABLE assessment.attempt DISABLE TRIGGER attempt_guarded_update');
        await client.query(`UPDATE assessment.attempt SET ${SHAPE[state]} WHERE attempt_id = $1`, [attemptId]);
        await client.query('ALTER TABLE assessment.attempt ENABLE TRIGGER attempt_guarded_update');
      }
      return attemptId;
    }

    const PAIRS = ATTEMPT_STATES.flatMap((from) => ATTEMPT_STATES.map((to) => [from, to] as const));

    it('covers all 16 pairs', () => {
      expect(PAIRS).toHaveLength(16);
    });

    it.each(PAIRS)('%s → %s', async (from, to) => {
      await seedForm(database.pool);
      const outcome = await rolledBack(async (client) => {
        const attemptId = await inState(client, from);
        try {
          await client.query('SAVEPOINT move');
          // the target's own columns, on top of whatever the source state already had
          await client.query(`UPDATE assessment.attempt SET ${SHAPE[to]} WHERE attempt_id = $1`, [attemptId]);
          return 'allowed';
        } catch (error) {
          return (error as Error).message.includes('assessment_attempt_transition_prohibited') ? 'refused' : (error as Error).message;
        }
      });
      expect(outcome).toBe(canMove(from, to) ? 'allowed' : 'refused');
    });
  });
});

describe('a response is classified by the attempt\'s state, in the database', () => {
  const stored = async (): Promise<boolean[]> =>
    (await database.pool.query<{ after_submission: boolean }>(`SELECT after_submission FROM assessment.response_event ORDER BY sequence`)).rows.map((row) => row.after_submission);

  it('counts an event for an in-progress attempt', async () => {
    const attemptId = await liveAttempt();
    await insertEvent(database.pool, attemptId, 1);
    expect(await stored()).toEqual([false]);
  });

  it('records an event after submission, flagged so scoring leaves it out', async () => {
    const attemptId = await liveAttempt();
    await insertEvent(database.pool, attemptId, 1);
    await submitAttemptRow(database.pool, attemptId);
    await insertEvent(database.pool, attemptId, 2);
    expect(await stored()).toEqual([false, true]);
  });

  it('does not trust the caller: an event claiming to be after submission while in progress is stored as in time, and the reverse', async () => {
    const attemptId = await liveAttempt();
    const raw = (n: number, claim: boolean) =>
      database.pool.query(
        `INSERT INTO assessment.response_event (event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms, server_received_at, device_ref, after_submission)
         VALUES ($1, $2, $3, $4, $5, 'select', '"A"', 10, now(), 'phone', $6)`,
        [id(TAG.event, n), attemptId, id(TAG.slot, 1), id(TAG.itemVersion, 1), n, claim],
      );
    await raw(1, true);
    await submitAttemptRow(database.pool, attemptId);
    await raw(2, false);
    expect(await stored()).toEqual([false, true]);
  });

  it('refuses an event for a created attempt and for an abandoned one', async () => {
    const formId = await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool, { formId });
    expect(await refusal(() => insertEvent(database.pool, attemptId, 1))).toContain('assessment_attempt_not_accepting_responses');
    await database.pool.query(`UPDATE assessment.attempt SET state = 'abandoned', abandoned_at = now() WHERE attempt_id = $1`, [attemptId]);
    expect(await refusal(() => insertEvent(database.pool, attemptId, 1))).toContain('assessment_attempt_not_accepting_responses');
  });

  it('is the trigger that classifies: with it dropped, the caller\'s claim is stored as given', async () => {
    const attemptId = await liveAttempt();
    const claimed = await rolledBack(async (client) => {
      await client.query('DROP TRIGGER response_event_classified ON assessment.response_event');
      await client.query(
        `INSERT INTO assessment.response_event (event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms, server_received_at, device_ref, after_submission)
         VALUES ($1, $2, $3, $4, 1, 'select', '"A"', 10, now(), 'phone', true)`,
        [id(TAG.event, 1), attemptId, id(TAG.slot, 1), id(TAG.itemVersion, 1)],
      );
      return (await client.query(`SELECT after_submission FROM assessment.response_event`)).rows[0];
    });
    expect(claimed).toEqual({ after_submission: true });
  });

  it('cannot be raced by a submission: the event is classified against the state it is stored under', async () => {
    const attemptId = await liveAttempt();
    const inserting = await database.pool.connect();
    const submitting = await database.pool.connect();
    try {
      await inserting.query('BEGIN');
      await inserting.query(
        `INSERT INTO assessment.response_event (event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms, server_received_at, device_ref)
         VALUES ($1, $2, $3, $4, 1, 'select', '"A"', 10, now(), 'phone')`,
        [id(TAG.event, 1), attemptId, id(TAG.slot, 1), id(TAG.itemVersion, 1)],
      );
      const submission = submitting.query(
        `UPDATE assessment.attempt SET state = 'submitted', submitted_at = now(), submission_reason = 'manual', idempotency_key = 'k' WHERE attempt_id = $1`,
        [attemptId],
      );
      // Wait for the condition, never a duration: the submission is blocked on the share lock.
      for (;;) {
        const { rows } = await database.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE assessment.attempt%'`);
        if (rows.length > 0) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      await inserting.query('COMMIT');
      await submission;
    } finally {
      inserting.release();
      submitting.release();
    }
    expect(await stored()).toEqual([false]);
  });
});
