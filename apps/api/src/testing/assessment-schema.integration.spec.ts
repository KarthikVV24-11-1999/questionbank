import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ATTEMPT_MODES, SUBMISSION_REASONS } from '../contexts/assessment/domain/attempt.js';
import { ATTEMPT_STATES } from '../contexts/assessment/domain/attempt-state.js';
import { FORM_STATES, FORM_TYPES } from '../contexts/assessment/domain/form.js';
import { RESPONSE_EVENT_KINDS } from '../contexts/assessment/domain/response-event.js';
import { ASSESSMENT_TABLES, insertEvent, refusal, seedAttempt, seedForm, startAttemptRow } from './assessment-db.js';
import { SESSION_REF, TAG, id } from './assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from './database.js';

/**
 * M6-11 — the shape of the `assessment` schema, asserted against the catalogue
 * on a real database (ENGINEERING-HANDBOOK §5). These specs create and drop the
 * schema, so they run against a throwaway database. The refusals the paired
 * migration adds (immutability, append-only, grants) are `assessment-rules`'s.
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
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE');
});

async function rows<T>(query: string, params: readonly unknown[] = []): Promise<T[]> {
  return (await database.pool.query(query, [...params])).rows as T[];
}

describe('the assessment schema is its own', () => {
  it('exists as a schema, holding exactly the assessment tables', async () => {
    const tables = await rows<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'assessment' ORDER BY table_name`,
    );
    expect(tables.map((row) => row.table_name)).toEqual(ASSESSMENT_TABLES);
  });

  it('puts none of those tables anywhere else', async () => {
    const strays = await rows(
      `SELECT table_schema, table_name FROM information_schema.tables WHERE table_name = ANY($1) AND table_schema <> 'assessment'`,
      [ASSESSMENT_TABLES],
    );
    expect(strays).toEqual([]);
  });

  // §9 rule 3, over the constraint catalogue in both directions.
  it('has no foreign key crossing the schema boundary, and has exactly the ones inside it', async () => {
    const keys = await rows<{ from_schema: string; from_table: string; to_schema: string; to_table: string }>(
      `SELECT child_ns.nspname AS from_schema, child.relname AS from_table,
              parent_ns.nspname AS to_schema, parent.relname AS to_table
         FROM pg_constraint c
         JOIN pg_class child ON child.oid = c.conrelid
         JOIN pg_namespace child_ns ON child_ns.oid = child.relnamespace
         JOIN pg_class parent ON parent.oid = c.confrelid
         JOIN pg_namespace parent_ns ON parent_ns.oid = parent.relnamespace
        WHERE c.contype = 'f' AND (child_ns.nspname = 'assessment' OR parent_ns.nspname = 'assessment')
        ORDER BY child.relname, parent.relname`,
    );
    expect(keys.filter((key) => key.from_schema !== 'assessment' || key.to_schema !== 'assessment')).toEqual([]);
    expect(keys.map((key) => `${key.from_table}->${key.to_table}`)).toEqual([
      'attempt->form',
      'attempt->form',
      'attempt->form_session',
      'attempt_slot->attempt',
      'exposure_ledger_entry->attempt_slot',
      'exposure_ledger_entry->form_session',
      'exposure_ledger_entry->form_slot',
      'form_section->form',
      'form_session->form',
      'form_slot->form_section',
      'response_event->attempt_slot',
    ]);
  });
});

describe('JSONB columns each have a version sibling', () => {
  it('holds for all three, by name', async () => {
    const columns = await rows<{ table_name: string; column_name: string; data_type: string }>(
      `SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'assessment'`,
    );
    const jsonb = columns.filter((column) => column.data_type === 'jsonb').map((column) => `${column.table_name}.${column.column_name}`).sort();
    expect(jsonb).toEqual(['attempt.delivery_policy', 'form.blueprint_conformance', 'response_event.answer']);
    for (const column of jsonb) {
      const [table, name] = column.split('.') as [string, string];
      const sibling = columns.find((candidate) => candidate.table_name === table && candidate.column_name === `${name}_schema_version`);
      expect(sibling?.data_type, column).toBe('integer');
    }
  });
});

describe('§12 — what cannot be reconstructed later cannot be null', () => {
  it('declares each such column NOT NULL', async () => {
    const columns = await rows<{ c: string; is_nullable: string }>(
      `SELECT table_name || '.' || column_name AS c, is_nullable FROM information_schema.columns
        WHERE table_schema = 'assessment' AND table_name || '.' || column_name = ANY($1) ORDER BY 1`,
      [[
        'form_slot.is_anchor',
        'form_slot.item_version_id',
        'attempt_slot.item_version_id',
        'response_event.item_version_id',
        'response_event.client_monotonic_ms',
        'response_event.server_received_at',
        'response_event.device_ref',
      ]],
    );
    expect(columns).toHaveLength(7);
    expect(columns.filter((column) => column.is_nullable !== 'NO')).toEqual([]);
  });

  // The attempt's session and shift are §12 facts about a sitting of a *form*. A practice attempt has no form and so no sitting; the two
  // columns are nullable and tied to the form by a CHECK (M7-25), so a form-bearing attempt still cannot lack either.
  it('refuses a slot with no anchor flag, a form-bearing attempt with no shift or session, and an event with no timing', async () => {
    const formId = await seedForm(database.pool, { publish: false });
    expect(
      await refusal(() => database.pool.query(
        `INSERT INTO assessment.form_slot (slot_id, form_id, section_ordinal, ordinal, item_id, item_version_id, marks_available)
         VALUES ($1, $2, 1, 90, $3, $4, 4)`, [id(TAG.slot, 90), formId, id(TAG.item, 90), id(TAG.itemVersion, 90)])),
    ).toContain('is_anchor');

    // a published form to hang the attempts on: published the way the database requires, through its pool and ledger
    const publishedId = await seedForm(database.pool, { formId: id(TAG.form, 2), variant: 1 });
    const insert = (column: string, value: unknown) =>
      database.pool.query(
        `INSERT INTO assessment.attempt (student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash, taxonomy_version_id,
           delivery_policy, session_ref, shift_id, duration_ms, interval_cap_ms, window_closes_at, created_at)
         SELECT $1, 'mock', $2, $3, $4, $5, '{}', ${column === 'session_ref' ? '$6' : `'${SESSION_REF}'`},
                ${column === 'shift_id' ? '$6' : `'shift-1'`}, 1000, 1000, '2026-10-21T12:00:00Z', now()`,
        [id(TAG.student), publishedId, id(TAG.profile), 'a'.repeat(64), id(TAG.taxonomy), value],
      );
    expect(await refusal(() => insert('session_ref', null))).toContain('attempt_form_columns_travel_together');
    expect(await refusal(() => insert('shift_id', null))).toContain('attempt_form_columns_travel_together');
    expect(await refusal(() => insert('shift_id', '   '))).toContain('attempt_shift_id_check');
  });

  it('refuses an event with no timing, no device, and one that is not for a pinned slot', async () => {
    const formId = await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool, { formId });
    await startAttemptRow(database.pool, attemptId);
    await insertEvent(database.pool, attemptId, 1);
    const raw = (monotonic: unknown, device: unknown) =>
      database.pool.query(
        `INSERT INTO assessment.response_event (event_id, attempt_id, slot_id, item_version_id, sequence, kind, answer, client_monotonic_ms, server_received_at, device_ref)
         VALUES ($1, $2, $3, $4, 9, 'select', '"A"', $5, now(), $6)`,
        [id(TAG.event, 99), attemptId, id(TAG.slot, 1), id(TAG.itemVersion, 1), monotonic, device],
      );
    expect(await refusal(() => raw(null, 'phone'))).toContain('client_monotonic_ms');
    expect(await refusal(() => raw(-1, 'phone'))).toContain('response_event_client_monotonic_ms_check');
    expect(await refusal(() => raw(5, null))).toContain('device_ref');
    expect(await refusal(() => raw(5, ' '))).toContain('response_event_device_ref_check');
  });
});

describe('the item version is pinned per response, and agrees with the slot', () => {
  it('refuses a response naming a version the slot did not pin', async () => {
    const formId = await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool, { formId });
    await startAttemptRow(database.pool, attemptId);
    const message = await refusal(() => insertEvent(database.pool, attemptId, 1, { itemVersionId: id(TAG.itemVersion, 2) }));
    expect(message).toContain('response_event_pin_matches_slot');
  });

  it('refuses a response naming the item id in place of the version', async () => {
    const formId = await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool, { formId });
    await startAttemptRow(database.pool, attemptId);
    expect(await refusal(() => insertEvent(database.pool, attemptId, 1, { itemVersionId: id(TAG.item, 1) }))).toContain('response_event_pin_matches_slot');
  });

  it('refuses a response for a slot the attempt does not have', async () => {
    const formId = await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool, { formId });
    await startAttemptRow(database.pool, attemptId);
    expect(await refusal(() => insertEvent(database.pool, attemptId, 1, { slotId: id(TAG.slot, 77) }))).toContain('response_event_pin_matches_slot');
  });

  it('accepts a response whose version is the slot\'s, and keeps it queryable by version without a join', async () => {
    const formId = await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool, { formId });
    await startAttemptRow(database.pool, attemptId);
    await insertEvent(database.pool, attemptId, 1);
    const found = await rows(`SELECT event_id FROM assessment.response_event WHERE item_version_id = $1`, [id(TAG.itemVersion, 1)]);
    expect(found).toHaveLength(1);
  });
});

describe('one active mock attempt per student (ADR-0030)', () => {
  it('refuses a second mock while the first is created or in progress', async () => {
    const formId = await seedForm(database.pool);
    const first = await seedAttempt(database.pool, { formId });
    const second = id(TAG.attempt, 2);
    expect(await refusal(() => seedAttempt(database.pool, { formId, attemptId: second }))).toContain('attempt_one_active_mock_per_student');
    await startAttemptRow(database.pool, first);
    expect(await refusal(() => seedAttempt(database.pool, { formId, attemptId: second }))).toContain('attempt_one_active_mock_per_student');
  });

  it('is a function of the stored state alone: the index predicate names states and no time', async () => {
    const [index] = await rows<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname = 'assessment' AND indexname = 'attempt_one_active_mock_per_student'`,
    );
    expect(index?.indexdef).toContain("state = ANY (ARRAY['created'::text, 'in_progress'::text])");
    expect(index?.indexdef).not.toMatch(/now\(\)|window_closes_at|deadline_at/u);
  });

  it('lets the student begin another once the first is submitted or abandoned', async () => {
    const formId = await seedForm(database.pool);
    const first = await seedAttempt(database.pool, { formId });
    await database.pool.query(`UPDATE assessment.attempt SET state = 'abandoned', abandoned_at = now() WHERE attempt_id = $1`, [first]);
    await seedAttempt(database.pool, { formId, attemptId: id(TAG.attempt, 2) });
    const second = id(TAG.attempt, 2);
    await startAttemptRow(database.pool, second);
    await database.pool.query(
      `UPDATE assessment.attempt SET state = 'submitted', submitted_at = now(), submission_reason = 'manual', idempotency_key = 'k' WHERE attempt_id = $1`,
      [second],
    );
    await seedAttempt(database.pool, { formId, attemptId: id(TAG.attempt, 3) });
  });

  it('does not limit different students, or a student\'s diagnostics', async () => {
    const mockForm = await seedForm(database.pool);
    await seedAttempt(database.pool, { formId: mockForm });
    await seedAttempt(database.pool, { formId: mockForm, attemptId: id(TAG.attempt, 2), studentId: id(TAG.student, 2) });
    const diagnosticForm = await seedForm(database.pool, { formId: id(TAG.form, 2), mode: 'diagnostic', variant: 1 });
    await seedAttempt(database.pool, { formId: diagnosticForm, attemptId: id(TAG.attempt, 3), mode: 'diagnostic' });
    await seedAttempt(database.pool, { formId: diagnosticForm, attemptId: id(TAG.attempt, 4), mode: 'diagnostic' });
  });

  it('refuses a mock attempt built on a diagnostic form: the mode cannot disagree with the form', async () => {
    const diagnosticForm = await seedForm(database.pool, { mode: 'diagnostic' });
    expect(await refusal(() => seedAttempt(database.pool, { formId: diagnosticForm, mode: 'mock' }))).toContain('attempt_form_fkey');
  });
});

describe('an attempt row cannot claim a state it does not have the columns for', () => {
  it('refuses each shape violation', async () => {
    const formId = await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool, { formId });
    const update = (set: string) => () => database.pool.query(`UPDATE assessment.attempt SET ${set} WHERE attempt_id = $1`, [attemptId]);
    // in_progress without an anchored deadline
    expect(await refusal(update(`state = 'in_progress', started_at = now()`))).toContain('attempt_state_shape');
    // a deadline without a start
    expect(await refusal(update(`state = 'in_progress', deadline_at = now()`))).toContain('attempt_state_shape');
    // abandoned without saying when
    expect(await refusal(update(`state = 'abandoned'`))).toContain('attempt_state_shape');
    await startAttemptRow(database.pool, attemptId);
    // submitted without a key, without a reason, without a time
    expect(await refusal(update(`state = 'submitted', submitted_at = now(), submission_reason = 'manual'`))).toContain('attempt_state_shape');
    expect(await refusal(update(`state = 'submitted', submitted_at = now(), idempotency_key = 'k'`))).toContain('attempt_state_shape');
    expect(await refusal(update(`state = 'submitted', submission_reason = 'manual', idempotency_key = 'k'`))).toContain('attempt_state_shape');
  });
});

describe('the SQL vocabularies agree with the domain\'s', () => {
  // Two implementations of one rule drift: each CHECK's literals are read back
  // from the catalogue and compared with the TypeScript list.
  async function literals(table: string, column: string): Promise<string[]> {
    const checks = await rows<{ def: string }>(
      `SELECT pg_get_constraintdef(c.oid) AS def FROM pg_constraint c
         JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace
        WHERE n.nspname = 'assessment' AND t.relname = $1 AND c.contype = 'c'
          AND c.conname = $1 || '_' || $2 || '_check'`,
      [table, column],
    );
    expect(checks, `${table}.${column}`).toHaveLength(1);
    return [...checks[0]!.def.matchAll(/'([a-z_]+)'::text/gu)].map((match) => match[1]!).sort();
  }

  it.each([
    ['response_event', 'kind', RESPONSE_EVENT_KINDS],
    ['attempt', 'state', ATTEMPT_STATES],
    ['attempt', 'mode', ATTEMPT_MODES],
    ['attempt', 'submission_reason', SUBMISSION_REASONS],
    ['form', 'form_type', FORM_TYPES],
    ['form', 'state', FORM_STATES],
  ] as const)('%s.%s', async (table, column, domain) => {
    expect(await literals(table, column)).toEqual([...domain].sort());
  });
});
