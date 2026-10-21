import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, aDraftForm, aPublishedForm, anAttempt, attemptProps, formSlots, id } from '../../../testing/assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { abandonAttempt, createAttempt, startAttempt, submitAttempt } from '../domain/attempt.js';
import { createAttemptFromForm } from '../domain/form.js';
import { PostgresAttemptRepository } from './attempt.repository.js';
import { PostgresFormRepository } from './form.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let attempts: PostgresAttemptRepository;
let forms: PostgresFormRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  attempts = new PostgresAttemptRepository(database.pool);
  forms = new PostgresFormRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE');
  expectValue(await forms.save(aPublishedForm()));
});

describe('creating and finding an attempt', () => {
  // Field by field against literals, never `toEqual(saved)` (ADR-0017).
  it('reads back every field of a created attempt, and every pinned slot', async () => {
    expectValue(await attempts.create(anAttempt()));
    const found = expectValue(await attempts.findById(id(TAG.attempt)));

    expect(found.attemptId).toBe('000000a1-0000-4000-8000-000000000001');
    expect(found.studentId).toBe('000000a2-0000-4000-8000-000000000001');
    expect(found.mode).toBe('mock');
    expect(found.formId).toBe('000000a3-0000-4000-8000-000000000001');
    expect(found.examProfileVersionId).toBe('000000a4-0000-4000-8000-000000000001');
    expect(found.markingRuleSetHash).toBe('a'.repeat(64));
    expect(found.taxonomyVersionId).toBe('000000a5-0000-4000-8000-000000000001');
    expect(found.deliveryPolicy['timing']).toBe('strict');
    expect(found.deliveryPolicy['navigation']).toBe('free');
    expect(found.deliveryPolicy['pausable']).toBe(false);
    expect(found.sessionId).toBe('000000a6-0000-4000-8000-000000000001');
    expect(found.shiftId).toBe('2026-01-27/shift-2');
    expect(found.durationMs).toBe(10_800_000);
    expect(found.windowClosesAt).toBe('2026-10-21T12:00:00.000Z');
    expect(found.createdAt).toBe('2026-10-21T08:00:00.000Z');
    expect(found.state).toBe('created');
    expect([found.startedAt, found.deadline, found.submission, found.abandonedAt]).toEqual([null, null, null, null]);
    expect(Object.keys(found).sort()).toEqual([
      'abandonedAt', 'attemptId', 'createdAt', 'deadline', 'deliveryPolicy', 'durationMs', 'examProfileVersionId', 'formId',
      'markingRuleSetHash', 'mode', 'sessionId', 'shiftId', 'slots', 'startedAt', 'state', 'studentId', 'submission',
      'taxonomyVersionId', 'windowClosesAt',
    ]);

    expect(found.slots).toHaveLength(3);
    const first = found.slots[0]!;
    expect(first.slotId).toBe('000000b1-0000-4000-8000-000000000001');
    expect(first.ordinal).toBe(1);
    expect(first.itemId).toBe('000000b2-0000-4000-8000-000000000001');
    expect(first.itemVersionId).toBe('000000b3-0000-4000-8000-000000000001');
    expect(first.stimulusVersionId).toBe('000000b4-0000-4000-8000-000000000001');
    expect(found.slots[1]!.stimulusVersionId).toBeNull();
    expect(Object.keys(first).sort()).toEqual(['itemId', 'itemVersionId', 'ordinal', 'slotId', 'stimulusVersionId']);
    expect(Object.isFrozen(found)).toBe(true);
  });

  it('creates from a published form and keeps the version pins the form had', async () => {
    const form = aPublishedForm();
    const fromForm = expectValue(createAttemptFromForm(form, { ...attemptProps(), createdAt: '2026-10-21T08:00:00.000Z' }));
    expectValue(await attempts.create(fromForm));
    const found = expectValue(await attempts.findById(id(TAG.attempt)));
    expect(found.slots.map((s) => s.itemVersionId)).toEqual([1, 2, 3, 4, 5, 6].map((n) => id(TAG.itemVersion, n)));
  });

  it('is NotFound for an attempt that was never created', async () => {
    expect(expectError(await attempts.findById(id(TAG.attempt, 77))).kind).toBe('NotFound');
  });

  it('creates all or nothing: a pinned slot the database refuses rolls the attempt back too', async () => {
    const duplicate = expectValue(createAttempt(attemptProps()));
    expectValue(await attempts.create(duplicate));
    const otherStudent = anAttempt({ attemptId: id(TAG.attempt, 2), studentId: id(TAG.student, 2) });
    // same slot ids under a different attempt are fine; a repeated attempt id is not
    expect(expectError(await attempts.create(duplicate)).code).toBe('CONFLICT');
    expectValue(await attempts.create(otherStudent));
    const { rows } = await database.pool.query('SELECT count(*)::int AS n FROM assessment.attempt_slot');
    expect(rows[0]).toEqual({ n: 6 });
  });

  it('refuses an attempt against a form that does not exist, and writes nothing', async () => {
    const orphan = anAttempt({ attemptId: id(TAG.attempt, 3), formId: id(TAG.form, 99) });
    expect(expectError(await attempts.create(orphan)).code).toBe('PERSISTENCE_REJECTED');
    expect((await database.pool.query('SELECT count(*)::int AS n FROM assessment.attempt')).rows[0]).toEqual({ n: 0 });
  });

  it('refuses an attempt against a draft form', async () => {
    const slots = formSlots().map((slot, i) => ({ ...slot, slotId: id(TAG.slot, 200 + i), itemId: id(TAG.item, 200 + i) }));
    const draft = aDraftForm({ formId: id(TAG.form, 2), sections: [{ ordinal: 1, sectionSpecRef: 'a', slots }] });
    expectValue(await forms.save(draft));
    const failure = expectError(await attempts.create(anAttempt({ attemptId: id(TAG.attempt, 4), formId: id(TAG.form, 2) })));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('assessment_attempt_requires_published_form');
  });
});

describe('one active mock attempt per student, under a race', () => {
  it('lets exactly one of two simultaneous creations succeed and tells the other', async () => {
    const results = await Promise.all([
      attempts.create(anAttempt({ attemptId: id(TAG.attempt, 10) })),
      attempts.create(anAttempt({ attemptId: id(TAG.attempt, 11) })),
    ]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = expectError(results.find((r) => !r.ok)!);
    expect(loser.code).toBe('CONFLICT');
    expect(loser.location).toBe('attempt_one_active_mock_per_student');
    expect((await database.pool.query('SELECT count(*)::int AS n FROM assessment.attempt')).rows[0]).toEqual({ n: 1 });
  });

  it('finds the active mock, whatever live state it is in', async () => {
    expect(expectValue(await attempts.findActiveMock(id(TAG.student)))).toBeUndefined();
    const created = anAttempt();
    expectValue(await attempts.create(created));
    expect(expectValue(await attempts.findActiveMock(id(TAG.student)))?.state).toBe('created');
    const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
    expectValue(await attempts.save(started, 'created'));
    expect(expectValue(await attempts.findActiveMock(id(TAG.student)))?.state).toBe('in_progress');
  });

  it('stops finding it once it is abandoned, and then lets another be created', async () => {
    const created = anAttempt();
    expectValue(await attempts.create(created));
    expectValue(await attempts.save(expectValue(abandonAttempt(created, '2026-10-21T12:00:00.000Z', 0)), 'created'));
    expect(expectValue(await attempts.findActiveMock(id(TAG.student)))).toBeUndefined();
    expectValue(await attempts.create(anAttempt({ attemptId: id(TAG.attempt, 2) })));
  });

  it('does not count another student\'s attempt', async () => {
    expectValue(await attempts.create(anAttempt({ studentId: id(TAG.student, 2) })));
    expect(expectValue(await attempts.findActiveMock(id(TAG.student)))).toBeUndefined();
  });
});

describe('moving along the state machine', () => {
  it('records a start, with the deadline the server anchored', async () => {
    const created = anAttempt();
    expectValue(await attempts.create(created));
    expectValue(await attempts.save(expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z')), 'created'));
    const found = expectValue(await attempts.findById(id(TAG.attempt)));
    expect(found.state).toBe('in_progress');
    expect(found.startedAt).toBe('2026-10-21T09:00:00.000Z');
    expect(found.deadline).toBe('2026-10-21T12:00:00.000Z');
  });

  it('records a submission with its reason and key, and reads it back', async () => {
    const created = anAttempt();
    expectValue(await attempts.create(created));
    const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
    expectValue(await attempts.save(started, 'created'));
    const submitted = expectValue(submitAttempt(started, { reason: 'expiry', idempotencyKey: 'key-1' }, '2026-10-21T12:00:00.000Z'));
    expectValue(await attempts.save(submitted, 'in_progress'));
    const found = expectValue(await attempts.findById(id(TAG.attempt)));
    expect(found.state).toBe('submitted');
    expect(found.submission).toEqual({ reason: 'expiry', idempotencyKey: 'key-1', submittedAt: '2026-10-21T12:00:00.000Z' });
    expect(found.startedAt).toBe('2026-10-21T09:00:00.000Z');
    expect(found.abandonedAt).toBeNull();
  });

  it('records an abandonment from created and from in_progress', async () => {
    const created = anAttempt();
    expectValue(await attempts.create(created));
    const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
    expectValue(await attempts.save(started, 'created'));
    expectValue(await attempts.save(expectValue(abandonAttempt(started, '2026-10-21T12:00:00.000Z', 0)), 'in_progress'));
    const found = expectValue(await attempts.findById(id(TAG.attempt)));
    expect(found.state).toBe('abandoned');
    expect(found.abandonedAt).toBe('2026-10-21T12:00:00.000Z');
    expect(found.startedAt).toBe('2026-10-21T09:00:00.000Z');
  });

  it('reports a stale write as a conflict and changes nothing: the other writer\'s move stands', async () => {
    const created = anAttempt();
    expectValue(await attempts.create(created));
    const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
    const abandoned = expectValue(abandonAttempt(created, '2026-10-21T12:00:00.000Z', 0));
    expectValue(await attempts.save(abandoned, 'created'));
    const failure = expectError(await attempts.save(started, 'created'));
    expect(failure.code).toBe('CONFLICT');
    expect(expectValue(await attempts.findById(id(TAG.attempt))).state).toBe('abandoned');
  });

  it('is NotFound for an attempt that does not exist', async () => {
    const started = expectValue(startAttempt(anAttempt({ attemptId: id(TAG.attempt, 55) }), '2026-10-21T09:00:00.000Z'));
    expect(expectError(await attempts.save(started, 'created')).kind).toBe('NotFound');
  });

  it('lets the database refuse a move the domain would not have made', async () => {
    const created = anAttempt();
    expectValue(await attempts.create(created));
    const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
    const submitted = expectValue(submitAttempt(started, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z'));
    // created → submitted is not an edge
    const failure = expectError(await attempts.save(submitted, 'created'));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('assessment_attempt_transition_prohibited');
  });
});

describe('what the store refuses', () => {
  it('reports a connection failure as a value', async () => {
    const { Pool } = await import('pg');
    const pool = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    pool.on('error', () => undefined);
    const broken = new PostgresAttemptRepository(pool);
    expect(expectError(await broken.create(anAttempt())).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await broken.save(anAttempt(), 'created')).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await broken.findById(id(TAG.attempt))).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await broken.findActiveMock(id(TAG.student))).code).toBe('PERSISTENCE_REJECTED');
    await pool.end().catch(() => undefined);
  });

  it('refuses to load a stored attempt that no longer satisfies the domain', async () => {
    expectValue(await attempts.create(anAttempt()));
    // The database would never let this row exist, so its guards are lifted for one statement and put back.
    await database.pool.query('ALTER TABLE assessment.attempt DISABLE TRIGGER attempt_guarded_update');
    await database.pool.query('ALTER TABLE assessment.attempt DROP CONSTRAINT attempt_state_shape');
    let failure;
    try {
      await database.pool.query(`UPDATE assessment.attempt SET state = 'submitted'`);
      failure = expectError(await attempts.findById(id(TAG.attempt)));
      await database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress'`);
      const active = expectError(await attempts.findActiveMock(id(TAG.student)));
      expect(active.code).toBe('PERSISTENCE_REJECTED');
    } finally {
      await database.pool.query(`UPDATE assessment.attempt SET state = 'created'`);
      await database.pool.query(SHAPE_CHECK);
      await database.pool.query('ALTER TABLE assessment.attempt ENABLE TRIGGER attempt_guarded_update');
    }
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('ATTEMPT_STORED_STATE_INVALID');
  });
});

const SHAPE_CHECK = `ALTER TABLE assessment.attempt ADD CONSTRAINT attempt_state_shape CHECK (
  (started_at IS NULL) = (deadline_at IS NULL) AND CASE state
    WHEN 'created' THEN started_at IS NULL AND submitted_at IS NULL AND submission_reason IS NULL AND idempotency_key IS NULL AND abandoned_at IS NULL
    WHEN 'in_progress' THEN started_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL AND idempotency_key IS NULL AND abandoned_at IS NULL
    WHEN 'submitted' THEN started_at IS NOT NULL AND submitted_at IS NOT NULL AND submission_reason IS NOT NULL AND idempotency_key IS NOT NULL AND abandoned_at IS NULL
    ELSE abandoned_at IS NOT NULL AND submitted_at IS NULL AND submission_reason IS NULL AND idempotency_key IS NULL END)`;
