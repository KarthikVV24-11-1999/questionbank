import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAttemptRepository } from '../contexts/assessment/infrastructure/attempt.repository.js';
import { expectError, expectValue } from './expect-result.js';
import { insertEvent, refusal, seedAttempt, seedForm, startAttemptRow } from './assessment-db.js';
import { TAG, anAttempt, id, slots } from './assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from './database.js';

/**
 * M7-27 — a slot list that grows, and a pin that only ever gains rows (DOMAIN-MODEL D2, INV-04).
 *
 * The hard direction is the one asserted: after the list has grown, no existing slot's item version can be changed or removed, and a response
 * recorded before the growth still resolves to the version it was given. The database is asked directly for the refusals; the repository is
 * asked only for the one thing it adds.
 */
let database: TestDatabase;
let attempts: PostgresAttemptRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  attempts = new PostgresAttemptRepository(database.pool);
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

const practice = (count = 2) =>
  anAttempt({ mode: 'practice', formId: null, sessionRef: null, shiftId: null, windowClosesAt: null, durationMs: null, slots: slots(count) });

const nextSlot = (n: number) => ({
  slotId: id(TAG.slot, n),
  ordinal: n,
  itemId: id(TAG.item, n),
  itemVersionId: id(TAG.itemVersion, n),
  stimulusVersionId: null,
});

const versionsOf = async (attemptId: string): Promise<string[]> =>
  (await database.pool.query<{ item_version_id: string }>('SELECT item_version_id FROM assessment.attempt_slot WHERE attempt_id = $1 ORDER BY ordinal', [attemptId])).rows.map(
    (row) => row.item_version_id,
  );

async function startPractice(): Promise<string> {
  const created = practice();
  expectValue(await attempts.create(created));
  await database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress', started_at = '2026-10-21T09:00:00Z' WHERE attempt_id = $1`, [created.attemptId]);
  return created.attemptId;
}

describe('a practice attempt grows', () => {
  it('takes the next slot while created and while in progress, and reads back in order', async () => {
    const created = practice();
    expectValue(await attempts.create(created));
    expectValue(await attempts.appendSlot(created.attemptId, nextSlot(3), '2026-10-21T08:30:00.000Z'));
    await database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress', started_at = '2026-10-21T09:00:00Z'`);
    expectValue(await attempts.appendSlot(created.attemptId, nextSlot(4), '2026-10-21T09:10:00.000Z'));
    const found = expectValue(await attempts.findById(created.attemptId));
    expect(found.slots.map((slot) => slot.ordinal)).toEqual([1, 2, 3, 4]);
    expect(found.slots.map((slot) => slot.itemVersionId)).toEqual([1, 2, 3, 4].map((n) => id(TAG.itemVersion, n)));
  });

  it('leaves every existing slot exactly as it was', async () => {
    const attemptId = await startPractice();
    const before = await database.pool.query('SELECT * FROM assessment.attempt_slot WHERE attempt_id = $1 ORDER BY ordinal', [attemptId]);
    expectValue(await attempts.appendSlot(attemptId, nextSlot(3), '2026-10-21T09:10:00.000Z'));
    const after = await database.pool.query('SELECT * FROM assessment.attempt_slot WHERE attempt_id = $1 AND ordinal <= 2 ORDER BY ordinal', [attemptId]);
    expect(after.rows).toEqual(before.rows);
  });

  it('refuses a second slot at an ordinal already taken', async () => {
    const attemptId = await startPractice();
    const refused = expectError(await attempts.appendSlot(attemptId, { ...nextSlot(9), ordinal: 2 }, '2026-10-21T09:10:00.000Z'));
    expect(refused.kind).toBe('Conflict');
  });

  it('refuses a slot once the attempt is submitted or abandoned', async () => {
    const attemptId = await startPractice();
    await database.pool.query(`UPDATE assessment.attempt SET state = 'submitted', submitted_at = now(), submission_reason = 'manual', idempotency_key = 'k'`);
    const message = await refusal(() => attempts.appendSlot(attemptId, nextSlot(3), '2026-10-21T09:10:00.000Z').then((result) => {
      if (!result.ok) throw new Error(result.error.message);
    }));
    expect(message).toContain('assessment_slots_are_pinned_at_creation');
    expect(await versionsOf(attemptId)).toHaveLength(2);
  });
});

describe('a mock does not grow', () => {
  it('refuses a slot on an attempt that has a form, once it has started — the rule it always had', async () => {
    await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool);
    await startAttemptRow(database.pool, attemptId);
    const message = await refusal(() =>
      database.pool.query(
        `INSERT INTO assessment.attempt_slot (attempt_id, slot_id, ordinal, item_id, item_version_id) VALUES ($1, $2, 99, $3, $4)`,
        [attemptId, id(TAG.slot, 99), id(TAG.item, 99), id(TAG.itemVersion, 99)],
      ),
    );
    expect(message).toContain('assessment_slots_are_pinned_at_creation');
  });
});

describe('a pin only ever gains rows', () => {
  it('refuses a change to an existing slot\'s item version, and its removal, from the owner and from the application role', async () => {
    const attemptId = await startPractice();
    expectValue(await attempts.appendSlot(attemptId, nextSlot(3), '2026-10-21T09:10:00.000Z'));
    const update = () => database.pool.query(`UPDATE assessment.attempt_slot SET item_version_id = $2 WHERE attempt_id = $1 AND ordinal = 1`, [attemptId, id(TAG.itemVersion, 77)]);
    const remove = () => database.pool.query(`DELETE FROM assessment.attempt_slot WHERE attempt_id = $1 AND ordinal = 1`, [attemptId]);
    expect(await refusal(update)).toContain('append-only');
    expect(await refusal(remove)).toContain('append-only');
    const client = await database.pool.connect();
    try {
      await client.query('SET ROLE questionbank_app');
      expect(await refusal(() => client.query(`UPDATE assessment.attempt_slot SET item_version_id = $2 WHERE attempt_id = $1`, [attemptId, id(TAG.itemVersion, 77)]))).toContain('permission denied');
      expect(await refusal(() => client.query(`DELETE FROM assessment.attempt_slot WHERE attempt_id = $1`, [attemptId]))).toContain('permission denied');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
    expect(await versionsOf(attemptId)).toEqual([1, 2, 3].map((n) => id(TAG.itemVersion, n)));
  });

  it('keeps a response recorded before the growth resolving to the version it was given, after it', async () => {
    const attemptId = await startPractice();
    await insertEvent(database.pool, attemptId, 1);
    expectValue(await attempts.appendSlot(attemptId, nextSlot(3), '2026-10-21T09:10:00.000Z'));
    expectValue(await attempts.appendSlot(attemptId, nextSlot(4), '2026-10-21T09:20:00.000Z'));
    const { rows } = await database.pool.query<{ item_version_id: string; slot_version: string }>(
      `SELECT e.item_version_id, s.item_version_id AS slot_version
         FROM assessment.response_event e
         JOIN assessment.attempt_slot s ON (s.attempt_id, s.slot_id, s.item_version_id) = (e.attempt_id, e.slot_id, e.item_version_id)
        WHERE e.attempt_id = $1`,
      [attemptId],
    );
    expect(rows).toEqual([{ item_version_id: id(TAG.itemVersion, 1), slot_version: id(TAG.itemVersion, 1) }]);
  });

  it('refuses a response that names a version other than the one its slot holds, however long the list has grown', async () => {
    const attemptId = await startPractice();
    expectValue(await attempts.appendSlot(attemptId, nextSlot(3), '2026-10-21T09:10:00.000Z'));
    const message = await refusal(() => insertEvent(database.pool, attemptId, 1, { slotId: id(TAG.slot, 1), itemVersionId: id(TAG.itemVersion, 3) }));
    expect(message).toContain('response_event_pin_matches_slot');
  });

  it('is the append-only trigger that refuses a change to a slot with no ledger row: with it dropped, the same UPDATE is accepted', async () => {
    await seedForm(database.pool);
    const attemptId = await seedAttempt(database.pool);
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER attempt_slot_append_only ON assessment.attempt_slot');
      const result = await client.query(`UPDATE assessment.attempt_slot SET item_version_id = $2 WHERE attempt_id = $1 AND ordinal = 1`, [attemptId, id(TAG.itemVersion, 77)]);
      expect(result.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('is held twice for a practice slot: with the trigger dropped, its ledger row still refuses a change of version', async () => {
    const attemptId = await startPractice();
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER attempt_slot_append_only ON assessment.attempt_slot');
      const message = await refusal(() =>
        client.query(`UPDATE assessment.attempt_slot SET item_version_id = $2 WHERE attempt_id = $1 AND ordinal = 1`, [attemptId, id(TAG.itemVersion, 77)]),
      );
      expect(message).toContain('exposure_ledger_matches_attempt_slot');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    expect(await versionsOf(attemptId)).toEqual([1, 2].map((n) => id(TAG.itemVersion, n)));
  });
});
