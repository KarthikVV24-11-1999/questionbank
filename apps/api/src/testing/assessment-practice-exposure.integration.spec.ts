import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { PostgresAttemptRepository } from '../contexts/assessment/infrastructure/attempt.repository.js';
import { PostgresExposureLedger } from '../contexts/assessment/infrastructure/exposure-ledger.repository.js';
import { expectValue } from './expect-result.js';
import { refusal, seedAttempt, seedForm } from './assessment-db.js';
import { TAG, anAttempt, id, slots } from './assessment-fixtures.js';
import { connectTestDatabase, type TestDatabase } from './database.js';

/**
 * M7-30 — exposure counts a practice delivery, under a constraint that is still total.
 *
 * A practice run has no shift and no form, so it cannot be tied to the ledger by the form-and-session key. It is tied by its own: the attempt slot
 * that delivered it. Every refusal below is a constraint that holds for every row of the ledger; none reads a mode to decide whether it applies. The
 * hard direction is the second block: a practice slot cannot be delivered without its ledger row, and the proof that the trigger is what refuses it.
 */
let database: TestDatabase;
let attempts: PostgresAttemptRepository;
let ledger: PostgresExposureLedger;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  attempts = new PostgresAttemptRepository(database.pool);
  ledger = new PostgresExposureLedger(database.pool);
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

const slot = (n: number) => ({ slotId: id(TAG.slot, n), ordinal: n, itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), stimulusVersionId: null });

const rows = async () =>
  (await database.pool.query('SELECT form_id, attempt_id, slot_id, item_version_id, session_ref, is_anchor FROM assessment.exposure_ledger_entry ORDER BY slot_id')).rows;

const insertRow = (values: Record<string, unknown>, runner: { query: (sql: string, values: unknown[]) => Promise<unknown> } = database.pool) => {
  const entries = Object.entries({ written_at: '2026-10-21T09:00:00Z', ...values });
  return runner.query(
    `INSERT INTO assessment.exposure_ledger_entry (${entries.map(([c]) => c).join(', ')}) VALUES (${entries.map((_, i) => `$${i + 1}`).join(', ')})`,
    entries.map(([, v]) => v),
  );
};

const constraintOf = async (run: () => Promise<unknown>): Promise<string> => {
  const message = await refusal(run);
  return /constraint "([^"]+)"/u.exec(message)?.[1] ?? message;
};

describe('a practice delivery is in the ledger', () => {
  it('writes one row per slot at creation and one per slot appended, keyed by the attempt slot', async () => {
    const created = practice(2);
    expectValue(await attempts.create(created));
    expectValue(await attempts.appendSlot(created.attemptId, slot(3), '2026-10-21T09:10:00.000Z'));
    const found = await rows();
    expect(found).toHaveLength(3);
    expect(found.every((row) => row.form_id === null && row.session_ref === null && row.is_anchor === null && row.attempt_id === created.attemptId)).toBe(true);
    expect(found.map((row) => row.item_version_id)).toEqual([1, 2, 3].map((n) => id(TAG.itemVersion, n)));
  });

  it('counts a practice delivery as a placement of the version, and leaves per-session exposure to forms', async () => {
    expectValue(await attempts.create(practice(2)));
    const counts = expectValue(await ledger.countsByItemVersion([id(TAG.itemVersion, 1), id(TAG.itemVersion, 2), id(TAG.itemVersion, 9)]));
    expect([...counts.entries()]).toEqual([[id(TAG.itemVersion, 1), 1], [id(TAG.itemVersion, 2), 1]]);
    expect(expectValue(await ledger.exposureBySession([id(TAG.itemVersion, 1)]))).toEqual([]);
  });

  it('writes nothing when the slot is refused, and nothing when the ledger row is: the slot and its row are one transaction', async () => {
    const created = practice(1);
    expectValue(await attempts.create(created));
    // a repeated ordinal is refused by the slot insert; no row may have been left behind
    await attempts.appendSlot(created.attemptId, { ...slot(5), ordinal: 1 }, '2026-10-21T09:10:00.000Z');
    expect(await rows()).toHaveLength(1);
    // a second delivery of the same slot id is refused by the primary key; again no extra row
    await attempts.appendSlot(created.attemptId, { ...slot(1), ordinal: 2 }, '2026-10-21T09:10:00.000Z');
    expect(await rows()).toHaveLength(1);
    expect((await database.pool.query('SELECT 1 FROM assessment.attempt_slot')).rowCount).toBe(1);
  });
});

describe('every shape of a row that is wrong is refused by the database', () => {
  it('refuses a row that names both a form slot and an attempt slot, and one that names neither', async () => {
    expectValue(await attempts.create(practice(1)));
    await seedForm(database.pool, { publish: false });
    const both = { form_id: id(TAG.form), attempt_id: id(TAG.attempt), slot_id: id(TAG.slot, 1), item_id: id(TAG.item, 1), item_version_id: id(TAG.itemVersion, 1), session_ref: 's', is_anchor: false };
    expect(await constraintOf(() => insertRow(both))).toBe('exposure_ledger_describes_one_slot');
    // naming neither is refused too: by the trigger first (no attempt to be live), and by the CHECK were the trigger gone
    expect(await refusal(() => insertRow({ slot_id: id(TAG.slot, 1), item_id: id(TAG.item, 1), item_version_id: id(TAG.itemVersion, 1) }))).toContain(
      'assessment_ledger_practice_row_needs_a_live_practice_attempt',
    );
  });

  it('refuses a form row without its session or anchor flag, and an attempt row that carries them', async () => {
    expectValue(await attempts.create(practice(1)));
    await seedForm(database.pool, { publish: false });
    const form = { form_id: id(TAG.form), slot_id: id(TAG.slot, 2), item_id: id(TAG.item, 2), item_version_id: id(TAG.itemVersion, 2) };
    expect(await constraintOf(() => insertRow({ ...form, is_anchor: false }))).toBe('exposure_ledger_form_columns_travel_together');
    expect(await constraintOf(() => insertRow({ ...form, session_ref: 's' }))).toBe('exposure_ledger_form_columns_travel_together');
    const attempt = { attempt_id: id(TAG.attempt), slot_id: id(TAG.slot, 1), item_id: id(TAG.item, 1), item_version_id: id(TAG.itemVersion, 1) };
    expect(await constraintOf(() => insertRow({ ...attempt, session_ref: 's' }))).toBe('exposure_ledger_form_columns_travel_together');
  });

  it('refuses an attempt row that disagrees with its slot, and a second row for one slot', async () => {
    expectValue(await attempts.create(practice(1)));
    const second = { attempt_id: id(TAG.attempt), slot_id: id(TAG.slot, 9), item_id: id(TAG.item, 9) };
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`INSERT INTO assessment.attempt_slot (attempt_id, slot_id, ordinal, item_id, item_version_id) VALUES ($1, $2, 9, $3, $4)`, [
        id(TAG.attempt), id(TAG.slot, 9), id(TAG.item, 9), id(TAG.itemVersion, 9),
      ]);
      expect(await constraintOf(() => insertRow({ ...second, item_version_id: id(TAG.itemVersion, 50) }, client))).toBe('exposure_ledger_matches_attempt_slot');
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
    const again = { attempt_id: id(TAG.attempt), slot_id: id(TAG.slot, 1), item_id: id(TAG.item, 1), item_version_id: id(TAG.itemVersion, 1) };
    expect(await constraintOf(() => insertRow(again))).toBe('exposure_ledger_one_row_per_attempt_slot');
  });

  it('refuses a practice row for the slot of an attempt that has a form, and for a practice attempt that is finished', async () => {
    const mock = await seedAttempt(database.pool).catch(async () => {
      await seedForm(database.pool);
      return seedAttempt(database.pool);
    });
    const onMock = { attempt_id: mock, slot_id: id(TAG.slot, 1), item_id: id(TAG.item, 1), item_version_id: id(TAG.itemVersion, 1) };
    expect(await refusal(() => insertRow(onMock))).toContain('assessment_ledger_practice_row_needs_a_live_practice_attempt');

    await clean();
    const created = practice(1);
    expectValue(await attempts.create(created));
    await database.pool.query(`UPDATE assessment.attempt SET state = 'abandoned', abandoned_at = now()`);
    const done = await attempts.appendSlot(created.attemptId, slot(4), '2026-10-21T09:10:00.000Z');
    expect(done.ok).toBe(false);
    expect(await rows()).toHaveLength(1);
  });

  it('still refuses what it always did: a form row that disagrees with the form\'s session, and any UPDATE or DELETE', async () => {
    await seedForm(database.pool, { publish: false });
    const row = { form_id: id(TAG.form), slot_id: id(TAG.slot, 2), item_id: id(TAG.item, 2), item_version_id: id(TAG.itemVersion, 2), is_anchor: false };
    expect(await constraintOf(() => insertRow({ ...row, session_ref: 'someone-else' }))).toBe('exposure_ledger_matches_session');
    expectValue(await attempts.create(practice(1)));
    expect(await refusal(() => database.pool.query(`UPDATE assessment.exposure_ledger_entry SET written_at = now()`))).toContain('append-only');
    expect(await refusal(() => database.pool.query(`DELETE FROM assessment.exposure_ledger_entry`))).toContain('append-only');
  });
});

describe('practice cannot be the hole', () => {
  const bareSlot = (client: { query: (sql: string, values: unknown[]) => Promise<unknown> }, attemptId: string) =>
    client.query(`INSERT INTO assessment.attempt_slot (attempt_id, slot_id, ordinal, item_id, item_version_id) VALUES ($1, $2, 9, $3, $4)`, [
      attemptId,
      id(TAG.slot, 9),
      id(TAG.item, 9),
      id(TAG.itemVersion, 9),
    ]);

  it('fails the transaction that delivers a practice slot with no ledger row', async () => {
    const created = practice(1);
    expectValue(await attempts.create(created));
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await bareSlot(client, created.attemptId);
      expect(await refusal(() => client.query('COMMIT'))).toContain('assessment_practice_delivery_is_exposure');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect((await database.pool.query('SELECT 1 FROM assessment.attempt_slot')).rowCount).toBe(1);
  });

  it('is the deferred trigger that refuses it: with it dropped, the same bare slot commits', async () => {
    const created = practice(1);
    expectValue(await attempts.create(created));
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER attempt_slot_practice_is_exposed ON assessment.attempt_slot');
      await bareSlot(client, created.attemptId);
      await client.query('SET CONSTRAINTS ALL IMMEDIATE');
      expect((await client.query('SELECT 1 FROM assessment.attempt_slot')).rowCount).toBe(2);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });

  it('lets a slot and its row commit together, the row after the slot it describes', async () => {
    const created = practice(1);
    expectValue(await attempts.create(created));
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await bareSlot(client, created.attemptId);
      await insertRow({ attempt_id: created.attemptId, slot_id: id(TAG.slot, 9), item_id: id(TAG.item, 9), item_version_id: id(TAG.itemVersion, 9) }, client);
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    expect(await rows()).toHaveLength(2);
  });
});
