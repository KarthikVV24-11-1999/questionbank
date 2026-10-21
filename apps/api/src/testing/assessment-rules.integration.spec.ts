import type { PoolClient } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ATTEMPT_STATES, canMove, type AttemptState } from '../contexts/assessment/domain/attempt-state.js';
import { restoreAttempt, type AttemptSnapshot } from '../contexts/assessment/domain/attempt.js';
import { FORM_STATES, canMove as canMoveForm, type FormState } from '../contexts/assessment/domain/form-state.js';
import { insertEvent, refusal, seedAttempt, seedForm, startAttemptRow, submitAttemptRow } from './assessment-db.js';
import { TAG, attemptProps, id } from './assessment-fixtures.js';
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
    'TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE',
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
      // Publication as the database requires it: the edited anchor is in the pool and the ledger has every remaining slot.
      await client.query(`INSERT INTO assessment.anchor_pool_member (item_version_id, exposure_cap, added_at) VALUES ($1, 40, now())`, [id(TAG.itemVersion, 41)]);
      await client.query(
        `INSERT INTO assessment.exposure_ledger_entry (form_id, slot_id, item_id, item_version_id, session_ref, is_anchor, written_at)
         SELECT form_id, slot_id, item_id, item_version_id, '2026-01-27/shift-2', is_anchor, now() FROM assessment.form_slot WHERE form_id = $1`,
        [formId],
      );
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

  it('refuses an attempt against a form that is not active: a draft, a published one, a closed one', async () => {
    const draft = await seedForm(database.pool, { publish: false });
    expect(await refusal(() => seedAttempt(database.pool, { formId: draft }))).toContain('assessment_attempt_requires_active_form');
    const published = await seedForm(database.pool, { formId: id(TAG.form, 2), variant: 1, open: false });
    expect(await refusal(() => seedAttempt(database.pool, { formId: published, attemptId: id(TAG.attempt, 2) }))).toContain('assessment_attempt_requires_active_form');
    const closed = await seedForm(database.pool, { formId: id(TAG.form, 3), variant: 2 });
    await database.pool.query(`UPDATE assessment.form SET state = 'closed' WHERE form_id = $1`, [closed]);
    expect(await refusal(() => seedAttempt(database.pool, { formId: closed, attemptId: id(TAG.attempt, 3) }))).toContain('assessment_attempt_requires_active_form');
  });

  it('refuses an attempt whose window is not the form\'s, so no client-supplied window can stand', async () => {
    const formId = await seedForm(database.pool);
    const message = await refusal(() =>
      database.pool.query(
        `INSERT INTO assessment.attempt (student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash, taxonomy_version_id,
           delivery_policy, session_id, shift_id, duration_ms, window_closes_at, created_at)
         VALUES ($1, 'mock', $2, $3, $4, $5, '{}', $6, 's', 1000, '2099-01-01T00:00:00Z', now())`,
        [id(TAG.student), formId, id(TAG.profile), 'a'.repeat(64), id(TAG.taxonomy), id(TAG.session)],
      ),
    );
    expect(message).toContain('attempt_window_is_the_forms');
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
         VALUES ($1, $2, 'mock', $3, $4, $5, $6, '{}', $7, 'shift-1', 1000, '2026-10-21T12:00:00Z', now())`,
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

describe('a published form moves only along its lifecycle, and its window is fixed', () => {
  const WINDOW_SQL = `opens_at = '2026-10-21T08:00:00Z', closes_at = '2026-10-21T12:00:00Z'`;

  it('moves published → embargoed → active → closed, one step at a time, and no other way', async () => {
    const formId = await seedForm(database.pool, { open: false });
    const move = (set: string) => () => database.pool.query(`UPDATE assessment.form SET ${set} WHERE form_id = $1`, [formId]);
    expect(await refusal(move(`state = 'active', ${WINDOW_SQL}`))).toContain('assessment_form_transition_prohibited');
    await database.pool.query(`UPDATE assessment.form SET state = 'embargoed', ${WINDOW_SQL} WHERE form_id = $1`, [formId]);
    await database.pool.query(`UPDATE assessment.form SET state = 'active' WHERE form_id = $1`, [formId]);
    await database.pool.query(`UPDATE assessment.form SET state = 'closed' WHERE form_id = $1`, [formId]);
    expect(await refusal(move(`state = 'active'`))).toContain('assessment_form_transition_prohibited');
  });

  it('refuses to move a scheduled form\'s window', async () => {
    const formId = await seedForm(database.pool);
    const message = await refusal(() =>
      database.pool.query(`UPDATE assessment.form SET state = 'closed', closes_at = '2026-10-21T13:00:00Z' WHERE form_id = $1`, [formId]),
    );
    expect(message).toContain('assessment_form_window_is_fixed');
  });

  it('refuses a window that ends before it starts, and one on a form that is not scheduled', async () => {
    const formId = await seedForm(database.pool, { open: false });
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form SET state = 'embargoed', opens_at = '2026-10-21T12:00:00Z', closes_at = '2026-10-21T08:00:00Z' WHERE form_id = $1`, [formId]))).toContain('form_window_matches_state');
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form SET state = 'embargoed' WHERE form_id = $1`, [formId]))).toContain('form_window_matches_state');
  });

  it('still refuses to change the composition in any scheduled state', async () => {
    const formId = await seedForm(database.pool);
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form SET form_type = 'diagnostic' WHERE form_id = $1`, [formId]))).toContain('only its state and window move');
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form SET session_ref = 'x' WHERE form_id = $1`, [formId]))).toContain('only its state and window move');
    expect(await refusal(() => database.pool.query(`UPDATE assessment.form_slot SET marks_available = 9 WHERE form_id = $1`, [formId]))).toContain('assessment_published_form_is_immutable');
    expect(await refusal(() => database.pool.query(`DELETE FROM assessment.form WHERE form_id = $1`, [formId]))).toContain('never deleted');
  });

  // Two implementations of one rule (rule 5): the domain's table and this trigger are
  // held to the same answer over every pair of states.
  describe('agrees with the domain over every pair of states', () => {
    const SET: Record<FormState, string> = {
      draft: `state = 'draft', published_at = NULL, opens_at = NULL, closes_at = NULL`,
      published: `state = 'published', published_at = '2026-10-21T07:00:00Z', opens_at = NULL, closes_at = NULL`,
      embargoed: `state = 'embargoed', published_at = '2026-10-21T07:00:00Z', ${WINDOW_SQL}`,
      active: `state = 'active', published_at = '2026-10-21T07:00:00Z', ${WINDOW_SQL}`,
      closed: `state = 'closed', published_at = '2026-10-21T07:00:00Z', ${WINDOW_SQL}`,
    };

    const PAIRS = FORM_STATES.flatMap((from) => FORM_STATES.map((to) => [from, to] as const));

    it('covers all 25 pairs', () => {
      expect(PAIRS).toHaveLength(25);
    });

    it.each(PAIRS)('%s → %s', async (from, to) => {
      await seedForm(database.pool, { publish: false });
      const outcome = await rolledBack(async (client) => {
        // Put the form in `from` with every guard set aside, then put the guards back and attempt the move.
        await client.query('SET LOCAL session_replication_role = replica');
        await client.query(`UPDATE assessment.form SET ${SET[from]}`);
        await client.query('SET LOCAL session_replication_role = DEFAULT');
        // Publication's own preconditions are not what this asks about.
        await client.query('ALTER TABLE assessment.form DISABLE TRIGGER form_publication_guarded');
        try {
          await client.query(`UPDATE assessment.form SET ${SET[to]}`);
          return 'allowed';
        } catch (error) {
          const message = (error as Error).message;
          return message.includes('assessment_form_transition_prohibited') || message.includes('assessment_published_form_is_immutable') ? 'refused' : message;
        }
      });
      // draft → draft is not a move at all but an edit of a draft, which the database rightly allows.
      const expected = from === 'draft' && to === 'draft' ? 'allowed' : canMoveForm(from, to) ? 'allowed' : 'refused';
      expect(outcome).toBe(expected);
    });
  });
});

describe('the attempt state-shape rule: the database\'s check and the domain\'s restore agree (rule 5)', () => {
  // The rule lives twice — the table's CHECK and `restoreAttempt` — so both are asked the same
  // question over every combination: each of four states with each of six lifecycle columns
  // present or absent, 256 rows. Partial submissions (one or two of time, reason and key) have
  // no domain representation at all, so for those the database must refuse and the domain
  // cannot even be asked.
  const COLUMNS = ['started_at', 'deadline_at', 'submitted_at', 'submission_reason', 'idempotency_key', 'abandoned_at'] as const;
  const VALUE: Record<(typeof COLUMNS)[number], string> = {
    started_at: `'2026-10-21T09:00:00Z'`,
    deadline_at: `'2026-10-21T12:00:00Z'`,
    submitted_at: `'2026-10-21T10:00:00Z'`,
    submission_reason: `'manual'`,
    idempotency_key: `'k1'`,
    abandoned_at: `'2026-10-21T12:30:00Z'`,
  };

  const combos = ATTEMPT_STATES.flatMap((state) =>
    Array.from({ length: 64 }, (_, bits) => ({ state, present: COLUMNS.map((_, i) => (bits >> i) % 2 === 1) })),
  );

  function snapshotOf(state: AttemptState, present: readonly boolean[]): AttemptSnapshot | null {
    const [started, deadline, submittedAt, reason, key, abandoned] = present as [boolean, boolean, boolean, boolean, boolean, boolean];
    // all three of a submission, or none: a partial one is not a thing the domain can hold
    if (!(submittedAt === reason && reason === key)) return null;
    return {
      ...attemptProps(),
      state,
      startedAt: started ? '2026-10-21T09:00:00.000Z' : null,
      deadline: deadline ? '2026-10-21T12:00:00.000Z' : null,
      submission: submittedAt ? { reason: 'manual', idempotencyKey: 'k1', submittedAt: '2026-10-21T10:00:00.000Z' } : null,
      abandonedAt: abandoned ? '2026-10-21T12:30:00.000Z' : null,
    };
  }

  it('covers 256 combinations, a good share on each side of the line', () => {
    expect(combos).toHaveLength(256);
  });

  it('answers the same for every combination the domain can represent, and the database refuses every one it cannot', async () => {
    await seedForm(database.pool);
    const disagreements: string[] = [];
    let accepted = 0;
    let refused = 0;
    await rolledBack(async (client) => {
      for (const [index, { state, present }] of combos.entries()) {
        const sets = COLUMNS.map((column, i) => (present[i] ? VALUE[column] : 'NULL'));
        await client.query('SAVEPOINT combo');
        let databaseAccepts = true;
        try {
          await client.query(
            `INSERT INTO assessment.attempt
               (attempt_id, student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash, taxonomy_version_id,
                delivery_policy, session_id, shift_id, duration_ms, window_closes_at, created_at, state,
                started_at, deadline_at, submitted_at, submission_reason, idempotency_key, abandoned_at)
             VALUES ($1, $2, 'mock', $3, $4, $5, $6, '{}', $7, 's', 1000, '2026-10-21T12:00:00Z', now(), '${state}', ${sets.join(', ')})`,
            [id(TAG.attempt, 1000 + index), id(TAG.student, 1000 + index), id(TAG.form), id(TAG.profile), 'a'.repeat(64), id(TAG.taxonomy), id(TAG.session)],
          );
        } catch {
          databaseAccepts = false;
        }
        await client.query('ROLLBACK TO SAVEPOINT combo');
        if (databaseAccepts) accepted += 1;
        else refused += 1;

        const snapshot = snapshotOf(state, present);
        const label = `${state} ${present.map((p, i) => (p ? COLUMNS[i] : '')).filter(Boolean).join('+') || '(none)'}`;
        if (snapshot === null) {
          if (databaseAccepts) disagreements.push(`${label}: a partial submission was accepted by the database`);
        } else if (restoreAttempt(snapshot).ok !== databaseAccepts) {
          disagreements.push(`${label}: database ${databaseAccepts ? 'accepts' : 'refuses'}, domain ${databaseAccepts ? 'refuses' : 'accepts'}`);
        }
      }
    });
    expect(disagreements).toEqual([]);
    // not vacuous: both sides of the line are well populated
    expect(accepted).toBe(5); // created, in_progress, submitted, and abandoned with and without a start
    expect(refused).toBe(251);
  });

  it('the domain is shown able to disagree: a snapshot the database would refuse is refused by it too, and vice versa', () => {
    const submittedWithoutStart = snapshotOf('submitted', [false, false, true, true, true, false])!;
    expect(restoreAttempt(submittedWithoutStart).ok).toBe(false);
    const fine = snapshotOf('submitted', [true, true, true, true, true, false])!;
    expect(restoreAttempt(fine).ok).toBe(true);
  });
});
