import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { SESSION_REF, TAG, aDraftForm, anAttempt, formSlots, id, poolOf } from '../../../testing/assessment-fixtures.js';
import { PUBLISHED_AT, seedAnchorPool, storeActiveForm, storePublishedForm } from '../../../testing/assessment-store.js';
import { refusal } from '../../../testing/assessment-db.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { PostgresAttemptRepository } from './attempt.repository.js';
import { PostgresExposureLedger } from './exposure-ledger.repository.js';
import { PostgresFormRepository } from './form.repository.js';
import { PostgresResponseLog } from './response-log.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let ledger: PostgresExposureLedger;
let forms: PostgresFormRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  ledger = new PostgresExposureLedger(database.pool);
  forms = new PostgresFormRepository(database.pool);
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

const ledgerRows = async () => (await database.pool.query('SELECT count(*)::int AS n FROM assessment.exposure_ledger_entry')).rows[0].n as number;

/** A second form that reuses form one's item versions under its own slot ids. */
const secondForm = (formId: string, sessionRef = 'second-session') =>
  aDraftForm({
    formId,
    sessionRefs: [sessionRef],
    sections: [
      {
        ordinal: 1,
        sectionSpecRef: 'a',
        slots: formSlots().map((slot, i) => ({ ...slot, slotId: id(TAG.slot, 500 + i) })),
      },
    ],
  });

describe('publication writes the ledger, in the same transaction as the state change', () => {
  // Field by field against literals, never `toEqual(saved)` (ADR-0017).
  it('reads back every field of every row', async () => {
    const form = await storePublishedForm(database.pool);
    const entries = expectValue(await ledger.entriesForForm(form.formId));
    expect(entries).toHaveLength(6);
    const first = entries[0]!;
    expect(first.formId).toBe('000000a3-0000-4000-8000-000000000001');
    expect(first.slotId).toBe('000000b1-0000-4000-8000-000000000001');
    expect(first.itemId).toBe('000000b2-0000-4000-8000-000000000001');
    expect(first.itemVersionId).toBe('000000b3-0000-4000-8000-000000000001');
    expect(first.sessionRef).toBe('2026-01-27/shift-2');
    expect(first.isAnchor).toBe(true);
    expect(first.writtenAt).toBe('2026-10-21T07:00:00.000Z');
    expect(Object.keys(first).sort()).toEqual(['formId', 'isAnchor', 'itemId', 'itemVersionId', 'sessionRef', 'slotId', 'writtenAt']);
    expect(entries.map((e) => e.slotId)).toEqual([1, 2, 3, 4, 5, 6].map((n) => id(TAG.slot, n)));
    expect(entries.map((e) => e.isAnchor)).toEqual([true, false, false, false, false, false]);
    expect(Object.isFrozen(first)).toBe(true);
  });

  it('writes nothing for a draft', async () => {
    expectValue(await forms.save(aDraftForm()));
    expect(await ledgerRows()).toBe(0);
    expect(expectValue(await ledger.entriesForForm(id(TAG.form)))).toEqual([]);
  });

  it('is atomic: a form refused at the anchor floor leaves no ledger rows and stays a draft', async () => {
    expectValue(await forms.save(aDraftForm()));
    // no pool seeded, so the flagged anchor is not a member
    const failure = expectError(await forms.publish(id(TAG.form), PUBLISHED_AT));
    expect(failure.code).toBe('FORM_ANCHOR_FLAG_DISAGREES_WITH_POOL');
    expect(await ledgerRows()).toBe(0);
    expect((await database.pool.query('SELECT state FROM assessment.form')).rows[0].state).toBe('draft');
  });

  it('is atomic the other way: a ledger write the database refuses leaves the form a draft and no rows behind', async () => {
    const draft = aDraftForm();
    expectValue(await forms.save(draft));
    await seedAnchorPool(database.pool, poolOf(draft));
    // a stray row for one slot makes the publication's own insert collide partway through
    await database.pool.query(
      `INSERT INTO assessment.exposure_ledger_entry (form_id, slot_id, item_id, item_version_id, session_ref, is_anchor, written_at)
       VALUES ($1, $2, $3, $4, $5, false, now())`,
      [id(TAG.form), id(TAG.slot, 4), id(TAG.item, 4), id(TAG.itemVersion, 4), SESSION_REF],
    );
    const failure = expectError(await forms.publish(id(TAG.form), PUBLISHED_AT));
    expect(failure.code).toBe('CONFLICT');
    expect(await ledgerRows()).toBe(1);
    expect((await database.pool.query('SELECT state FROM assessment.form')).rows[0].state).toBe('draft');
  });

  it('a form published twice does not double-count', async () => {
    const form = await storePublishedForm(database.pool);
    expect(await ledgerRows()).toBe(6);
    const again = expectValue(await forms.publish(form.formId, '2026-12-01T00:00:00.000Z'));
    expect(again.publishedAt).toBe(PUBLISHED_AT);
    expect(await ledgerRows()).toBe(6);
    const counts = expectValue(await ledger.countsByItemVersion([id(TAG.itemVersion, 1)]));
    expect(counts.get(id(TAG.itemVersion, 1))).toBe(1);
  });

  it('is NotFound for a form that was never saved', async () => {
    expect(expectError(await forms.publish(id(TAG.form, 77), PUBLISHED_AT)).kind).toBe('NotFound');
  });

  it('reports a connection failure as a value', async () => {
    const { Pool } = await import('pg');
    const broken = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    broken.on('error', () => undefined);
    expect(expectError(await new PostgresFormRepository(broken).publish(id(TAG.form), PUBLISHED_AT)).code).toBe('STORE_UNAVAILABLE');
    const reader = new PostgresExposureLedger(broken);
    expect(expectError(await reader.countsByItemVersion([])).code).toBe('STORE_UNAVAILABLE');
    expect(expectError(await reader.entriesForForm(id(TAG.form))).code).toBe('STORE_UNAVAILABLE');
    expect(expectError(await reader.exposureBySession([])).code).toBe('STORE_UNAVAILABLE');
    await broken.end().catch(() => undefined);
  });
});

describe('what the ledger answers', () => {
  it('counts forms per item version, and leaves a version never placed out of the map', async () => {
    await storePublishedForm(database.pool);
    const second = secondForm(id(TAG.form, 2));
    expectValue(await forms.save(second));
    expectValue(await forms.publish(second.formId, PUBLISHED_AT));
    const counts = expectValue(await ledger.countsByItemVersion([id(TAG.itemVersion, 1), id(TAG.itemVersion, 2), id(TAG.itemVersion, 99)]));
    expect(counts.get(id(TAG.itemVersion, 1))).toBe(2);
    expect(counts.get(id(TAG.itemVersion, 2))).toBe(2);
    expect(counts.has(id(TAG.itemVersion, 99))).toBe(false);
    expect(expectValue(await ledger.countsByItemVersion([])).size).toBe(0);
  });

  it('carries the session each form was published for, so exposure has session identity', async () => {
    await storePublishedForm(database.pool);
    const second = secondForm(id(TAG.form, 2), 'another-shift');
    expectValue(await forms.save(second));
    expectValue(await forms.publish(second.formId, PUBLISHED_AT));
    const { rows } = await database.pool.query(
      `SELECT session_ref, count(*)::int AS n FROM assessment.exposure_ledger_entry WHERE item_version_id = $1 GROUP BY session_ref ORDER BY session_ref`,
      [id(TAG.itemVersion, 1)],
    );
    expect(rows).toEqual([
      { session_ref: '2026-01-27/shift-2', n: 1 },
      { session_ref: 'another-shift', n: 1 },
    ]);
  });
});

describe('exposure joined to the attempts that sat it, per session (ADR-0032)', () => {
  const SHIFT_1 = '2026-01-27/shift-1';
  const SHIFT_2 = '2026-01-27/shift-2';
  const attempt = (n: number, sessionRef: string) => anAttempt({ attemptId: id(TAG.attempt, n), studentId: id(TAG.student, n), sessionRef });

  async function sit(attempts: PostgresAttemptRepository, n: number, sessionRef: string): Promise<void> {
    const created = attempt(n, sessionRef);
    expectValue(await attempts.create(created));
    await database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress', started_at = $2, deadline_at = $3 WHERE attempt_id = $1`, [
      created.attemptId,
      '2026-10-21T09:00:00Z',
      '2026-10-21T12:00:00Z',
    ]);
  }

  it('gets the right answer per session over one form published for two', async () => {
    const form = await storeActiveForm(database.pool, { sessionRefs: [SHIFT_1, SHIFT_2] });
    const attempts = new PostgresAttemptRepository(database.pool);
    // three students sit shift 1, one sits shift 2, and one creates an attempt in shift 2 that never starts
    await sit(attempts, 1, SHIFT_1);
    await sit(attempts, 2, SHIFT_1);
    await sit(attempts, 3, SHIFT_1);
    await sit(attempts, 4, SHIFT_2);
    expectValue(await attempts.create(attempt(5, SHIFT_2)));

    const rows = expectValue(await ledger.exposureBySession([id(TAG.itemVersion, 1), id(TAG.itemVersion, 2)]));
    expect(rows.map((r) => [r.itemVersionId, r.sessionRef, r.placements, r.attemptsSat])).toEqual([
      [id(TAG.itemVersion, 1), SHIFT_1, 1, 3],
      [id(TAG.itemVersion, 1), SHIFT_2, 1, 1],
      [id(TAG.itemVersion, 2), SHIFT_1, 1, 3],
      [id(TAG.itemVersion, 2), SHIFT_2, 1, 1],
    ]);
    expect(form.sessionRefs).toEqual([SHIFT_1, SHIFT_2]);
    expect(Object.keys(rows[0]!).sort()).toEqual(['attemptsSat', 'itemVersionId', 'placements', 'sessionRef']);
  });

  it('keeps sessions apart: an item placed in two forms of one session counts once per form, and another session is untouched', async () => {
    await storeActiveForm(database.pool, { sessionRefs: [SHIFT_1] });
    const second = secondForm(id(TAG.form, 2), SHIFT_1);
    expectValue(await forms.save(second));
    expectValue(await forms.publish(second.formId, PUBLISHED_AT));
    const rows = expectValue(await ledger.exposureBySession([id(TAG.itemVersion, 1)]));
    expect(rows.map((r) => [r.sessionRef, r.placements, r.attemptsSat])).toEqual([[SHIFT_1, 2, 0]]);
  });

  it('reports a session nobody has sat as zero attempts, and an unplaced version as nothing', async () => {
    await storeActiveForm(database.pool, { sessionRefs: [SHIFT_1, SHIFT_2] });
    const rows = expectValue(await ledger.exposureBySession([id(TAG.itemVersion, 1), id(TAG.itemVersion, 99)]));
    expect(rows.map((r) => [r.sessionRef, r.attemptsSat])).toEqual([[SHIFT_1, 0], [SHIFT_2, 0]]);
    expect(expectValue(await ledger.exposureBySession([]))).toEqual([]);
  });

  it('writes a ledger row per slot per session at publication, and the rows say which session', async () => {
    const form = await storeActiveForm(database.pool, { sessionRefs: [SHIFT_1, SHIFT_2] });
    expect(await ledgerRows()).toBe(12);
    const entries = expectValue(await ledger.entriesForForm(form.formId));
    expect(entries.filter((e) => e.sessionRef === SHIFT_1)).toHaveLength(6);
    expect(entries.filter((e) => e.sessionRef === SHIFT_2)).toHaveLength(6);
  });
});

describe('written at publication and nowhere else', () => {
  it('cannot be written once the form is published, by the owner or the application role', async () => {
    await storePublishedForm(database.pool);
    const insert = (client: { query: (q: string, p: unknown[]) => Promise<unknown> }) =>
      client.query(
        `INSERT INTO assessment.exposure_ledger_entry (form_id, slot_id, item_id, item_version_id, session_ref, is_anchor, written_at)
         VALUES ($1, $2, $3, $4, $5, true, now())`,
        [id(TAG.form), id(TAG.slot, 1), id(TAG.item, 1), id(TAG.itemVersion, 1), SESSION_REF],
      );
    expect(await refusal(() => insert(database.pool))).toContain('assessment_ledger_is_written_at_publication');
    const client = await database.pool.connect();
    try {
      await client.query('SET ROLE questionbank_app');
      expect(await refusal(() => insert(client))).toContain('assessment_ledger_is_written_at_publication');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
    expect(await ledgerRows()).toBe(6);
  });

  it('is not written by starting an attempt, taking a response, or submitting: the count does not move', async () => {
    const form = await storeActiveForm(database.pool);
    const attempts = new PostgresAttemptRepository(database.pool);
    const created = anAttempt({ formId: form.formId });
    expectValue(await attempts.create(created));
    expect(await ledgerRows()).toBe(6);
    expect(new PostgresResponseLog(database.pool)).toBeDefined();
    await database.pool.query(`UPDATE assessment.attempt SET state = 'in_progress', started_at = now(), deadline_at = now() + interval '1 hour'`);
    expect(await ledgerRows()).toBe(6);
  });

  const ledgerWriters = (root: string): string[] => {
    const files = (directory: string): string[] =>
      readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) return files(path);
        return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
      });
    return files(root)
      .filter((file) => /INSERT\s+INTO\s+assessment\.exposure_ledger_entry/iu.test(readFileSync(file, 'utf8')))
      .map((file) => relative(root, file))
      .sort();
  };

  it('is named in an INSERT by exactly two files of assessment\'s source: publication, and the attempt that pins a practice slot', () => {
    const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    expect(ledgerWriters(root)).toEqual(['infrastructure/attempt.repository.ts', 'infrastructure/form.repository.ts']);
    // each reaches it only from the one place that is allowed to: publish(), and the practice exposure step
    const forms = readFileSync(join(root, 'infrastructure/form.repository.ts'), 'utf8');
    expect(forms.indexOf('INSERT INTO assessment.exposure_ledger_entry')).toBeGreaterThan(forms.indexOf('async #publish('));
    const attemptsSource = readFileSync(join(root, 'infrastructure/attempt.repository.ts'), 'utf8');
    expect(attemptsSource.indexOf('INSERT INTO assessment.exposure_ledger_entry')).toBeGreaterThan(attemptsSource.indexOf('async #expose('));
    expect(attemptsSource.match(/INSERT\s+INTO\s+assessment\.exposure_ledger_entry/giu)).toHaveLength(1);
  });

  it('the scan names a third writer in the committed planted fixture', () => {
    const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../../../fitness-fixtures/as-ledger-writer');
    expect(ledgerWriters(fixtures)).toEqual(['infrastructure/third-writer.ts']);
  });
});

describe('the database holds the ledger\'s rules', () => {
  it('refuses UPDATE and DELETE from the owner by trigger, and UPDATE, DELETE and TRUNCATE from the application role by grant', async () => {
    await storePublishedForm(database.pool);
    expect(await refusal(() => database.pool.query(`UPDATE assessment.exposure_ledger_entry SET is_anchor = NOT is_anchor`))).toContain('append-only');
    expect(await refusal(() => database.pool.query(`DELETE FROM assessment.exposure_ledger_entry`))).toContain('append-only');
    const client = await database.pool.connect();
    try {
      await client.query('SET ROLE questionbank_app');
      expect(await refusal(() => client.query(`UPDATE assessment.exposure_ledger_entry SET is_anchor = true`))).toContain('permission denied');
      expect(await refusal(() => client.query(`DELETE FROM assessment.exposure_ledger_entry`))).toContain('permission denied');
      expect(await refusal(() => client.query(`TRUNCATE assessment.exposure_ledger_entry`))).toContain('permission denied');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
    expect(await ledgerRows()).toBe(6);
  });

  it('refuses a row that disagrees with its slot, or with the form\'s session', async () => {
    const draft = aDraftForm();
    expectValue(await forms.save(draft));
    const insert = (values: { slot?: number; version?: number; anchor?: boolean; session?: string }) =>
      database.pool.query(
        `INSERT INTO assessment.exposure_ledger_entry (form_id, slot_id, item_id, item_version_id, session_ref, is_anchor, written_at)
         VALUES ($1, $2, $3, $4, $5, $6, now())`,
        [id(TAG.form), id(TAG.slot, values.slot ?? 2), id(TAG.item, values.slot ?? 2), id(TAG.itemVersion, values.version ?? values.slot ?? 2), values.session ?? SESSION_REF, values.anchor ?? false],
      );
    expect(await refusal(() => insert({ version: 50 }))).toContain('exposure_ledger_matches_slot');
    expect(await refusal(() => insert({ anchor: true }))).toContain('exposure_ledger_matches_slot');
    expect(await refusal(() => insert({ session: 'someone-else' }))).toContain('exposure_ledger_matches_session');
    await insert({});
  });

  it('is the trigger that refuses a late write: with it dropped, a row is accepted after publication', async () => {
    await storePublishedForm(database.pool);
    await database.pool.query('DELETE FROM assessment.exposure_ledger_entry WHERE false');
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL session_replication_role = replica');
      await client.query('DELETE FROM assessment.exposure_ledger_entry WHERE slot_id = $1', [id(TAG.slot, 3)]);
      await client.query('RESET session_replication_role');
      await client.query('DROP TRIGGER exposure_ledger_written_at_publication ON assessment.exposure_ledger_entry');
      const result = await client.query(
        `INSERT INTO assessment.exposure_ledger_entry (form_id, slot_id, item_id, item_version_id, session_ref, is_anchor, written_at)
         VALUES ($1, $2, $3, $4, $5, false, now())`,
        [id(TAG.form), id(TAG.slot, 3), id(TAG.item, 3), id(TAG.itemVersion, 3), SESSION_REF],
      );
      expect(result.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});
