import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { refusal, seedForm } from './assessment-db.js';
import { MARKING_HASH, SESSION_REF, TAG, id } from './assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from './database.js';

/**
 * M7-25 — the schema admits practice, by constraint, and every shape that is wrong is refused by the database
 * (DOMAIN-MODEL D2). Nothing here goes through a repository: a spec of the database's refusals must not depend on the
 * code that is supposed to stay inside them.
 *
 * Every refusal is a constraint that holds for every row. None reads `mode` to decide whether to apply.
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await clean();
  await database.revertMigrations();
  await database.close();
});

async function clean(): Promise<void> {
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form_session, assessment.form CASCADE');
}

beforeEach(async () => {
  await clean();
});

type Row = Record<string, unknown>;

/** A mock-shaped attempt on the fixture form, with anything overridden. A column set to `undefined` is left out of the insert. */
const mockRow = (formId: string, overrides: Row = {}): Row => ({
  attempt_id: id(TAG.attempt),
  student_id: id(TAG.student),
  mode: 'mock',
  form_id: formId,
  exam_profile_version_id: id(TAG.profile),
  marking_rule_set_hash: MARKING_HASH,
  taxonomy_version_id: id(TAG.taxonomy),
  delivery_policy: '{"timing": "strict"}',
  session_ref: SESSION_REF,
  shift_id: 'shift-1',
  is_timed: true,
  duration_ms: 10_800_000,
  interval_cap_ms: 120_000,
  window_closes_at: '2026-10-21T12:00:00Z',
  created_at: '2026-10-21T08:00:00Z',
  ...overrides,
});

/** A practice attempt: no form, and with it no session, shift or window; untimed unless said otherwise. */
const practiceRow = (overrides: Row = {}): Row =>
  mockRow('unused', {
    mode: 'practice',
    form_id: null,
    session_ref: null,
    shift_id: null,
    window_closes_at: null,
    is_timed: false,
    duration_ms: null,
    ...overrides,
  });

async function insert(row: Row): Promise<void> {
  const entries = Object.entries(row).filter(([, value]) => value !== undefined);
  await database.pool.query(
    `INSERT INTO assessment.attempt (${entries.map(([column]) => column).join(', ')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')})`,
    entries.map(([, value]) => value),
  );
}

const constraintOf = async (run: () => Promise<unknown>): Promise<string> => {
  const message = await refusal(run);
  const named = /constraint "([^"]+)"/u.exec(message);
  return named?.[1] ?? message;
};

describe('what the schema now stores', () => {
  it('stores an untimed practice attempt with no form, session, shift, window or duration, and lets it start with no deadline', async () => {
    await insert(practiceRow());
    await database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress', started_at = '2026-10-21T09:00:00Z' WHERE attempt_id = $1`, [id(TAG.attempt)]);
    const { rows } = await database.pool.query('SELECT mode, form_id, session_ref, duration_ms, deadline_at, state FROM assessment.attempt');
    expect(rows).toEqual([{ mode: 'practice', form_id: null, session_ref: null, duration_ms: null, deadline_at: null, state: 'in_progress' }]);
  });

  it('stores a timed practice attempt, whose deadline follows its timing and not its mode', async () => {
    await insert(practiceRow({ is_timed: true, duration_ms: 1_800_000 }));
    await database.pool.query(
      `UPDATE assessment.attempt SET state = 'in_progress', started_at = '2026-10-21T09:00:00Z', deadline_at = '2026-10-21T09:30:00Z' WHERE attempt_id = $1`,
      [id(TAG.attempt)],
    );
    expect((await database.pool.query('SELECT deadline_at FROM assessment.attempt')).rowCount).toBe(1);
  });

  it('still stores a mock and a diagnostic against their forms', async () => {
    const mock = await seedForm(database.pool);
    await insert(mockRow(mock));
    const diagnostic = await seedForm(database.pool, { formId: id(TAG.form, 2), mode: 'diagnostic', variant: 1 });
    await insert(mockRow(diagnostic, { attempt_id: id(TAG.attempt, 2), student_id: id(TAG.student, 2), mode: 'diagnostic' }));
    expect((await database.pool.query('SELECT mode FROM assessment.attempt ORDER BY mode')).rows).toEqual([{ mode: 'diagnostic' }, { mode: 'mock' }]);
  });
});

describe('every shape that is wrong is refused by the database', () => {
  it('refuses a mode that is not one of the three', async () => {
    const form = await seedForm(database.pool);
    expect(await constraintOf(() => insert(mockRow(form, { mode: 'quiz' })))).toBe('attempt_mode_check');
  });

  it('refuses a practice attempt that names a form', async () => {
    const form = await seedForm(database.pool);
    expect(await constraintOf(() => insert(mockRow(form, { mode: 'practice' })))).toBe('attempt_form_exactly_when_not_practice');
  });

  it.each(['mock', 'diagnostic'])('refuses a %s attempt with no form', async (mode) => {
    expect(await constraintOf(() => insert(practiceRow({ mode })))).toBe('attempt_form_exactly_when_not_practice');
  });

  it.each([
    ['session_ref', SESSION_REF],
    ['shift_id', 'shift-1'],
    ['window_closes_at', '2026-10-21T12:00:00Z'],
  ])('refuses a formless attempt that carries a %s of the form it does not have', async (column, value) => {
    expect(await constraintOf(() => insert(practiceRow({ [column]: value })))).toBe('attempt_form_columns_travel_together');
  });

  it.each(['session_ref', 'shift_id', 'window_closes_at'])('refuses an attempt on a form that is missing its %s', async (column) => {
    const form = await seedForm(database.pool);
    expect(await constraintOf(() => insert(mockRow(form, { [column]: null })))).toBe('attempt_form_columns_travel_together');
  });

  it('refuses a timed attempt with no duration, and an untimed one with a duration', async () => {
    expect(await constraintOf(() => insert(practiceRow({ is_timed: true })))).toBe('attempt_duration_follows_timing');
    expect(await constraintOf(() => insert(practiceRow({ is_timed: false, duration_ms: 60_000 })))).toBe('attempt_duration_follows_timing');
  });

  it('refuses a started untimed attempt that holds a deadline, and a started timed one that holds none', async () => {
    await insert(practiceRow());
    expect(
      await constraintOf(() =>
        database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress', started_at = '2026-10-21T09:00:00Z', deadline_at = '2026-10-21T10:00:00Z'`),
      ),
    ).toBe('attempt_state_shape');
    await clean();
    await insert(practiceRow({ is_timed: true, duration_ms: 60_000 }));
    expect(await constraintOf(() => database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress', started_at = '2026-10-21T09:00:00Z'`))).toBe(
      'attempt_state_shape',
    );
  });

  // The composite keys were not relaxed: each still fires whenever its columns are present.
  it('still refuses a session the form was not published for', async () => {
    const form = await seedForm(database.pool);
    expect(await constraintOf(() => insert(mockRow(form, { session_ref: 'another/session' })))).toBe('attempt_session_is_one_the_form_was_published_for');
  });

  it('still refuses a window that is not the form\'s', async () => {
    const form = await seedForm(database.pool);
    expect(await constraintOf(() => insert(mockRow(form, { window_closes_at: '2026-10-21T13:00:00Z' })))).toBe('attempt_window_is_the_forms');
  });

  it('still refuses a mode that is not the form\'s type', async () => {
    const form = await seedForm(database.pool);
    expect(await constraintOf(() => insert(mockRow(form, { mode: 'diagnostic' })))).toBe('attempt_form_fkey');
  });
});

describe('mode, delivery policy and timing are pinned', () => {
  beforeEach(async () => {
    await insert(practiceRow());
  });

  it.each([
    ['mode', `mode = 'diagnostic'`],
    ['delivery_policy', `delivery_policy = '{"timing": "free"}'`],
    ['is_timed', `is_timed = true, duration_ms = 60000`],
  ])('refuses a change to %s by trigger', async (_column, assignment) => {
    const message = await refusal(() => database.pool.query(`UPDATE assessment.attempt SET ${assignment}, state = 'in_progress', started_at = now()`));
    expect(message).toMatch(/assessment_attempt_pin_is_immutable|violates check constraint/u);
  });

  it('refuses the application role an UPDATE of any of them by grant, before a trigger is asked', async () => {
    const message = await refusal(async () => {
      const client = await database.pool.connect();
      try {
        await client.query('SET ROLE questionbank_app');
        await client.query(`UPDATE assessment.attempt SET mode = 'mock'`);
      } finally {
        await client.query('RESET ROLE');
        client.release();
      }
    });
    expect(message).toMatch(/permission denied/u);
  });

  it('grants the application role UPDATE on the seven lifecycle columns and nothing else', async () => {
    const { rows } = await database.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.column_privileges
        WHERE table_schema = 'assessment' AND table_name = 'attempt' AND grantee = 'questionbank_app' AND privilege_type = 'UPDATE'
        ORDER BY column_name`,
    );
    expect(rows.map((row) => row.column_name)).toEqual(['abandoned_at', 'deadline_at', 'idempotency_key', 'started_at', 'state', 'submission_reason', 'submitted_at']);
  });
});
