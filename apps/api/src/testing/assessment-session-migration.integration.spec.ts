import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { TAG, id } from './assessment-fixtures.js';
import { connectTestDatabase, readMigrations, type TestDatabase } from './database.js';

/**
 * M6-21 — what the session-identity migration does to rows that already exist.
 * It runs against a database built only up to the migration before it, seeded
 * with the shapes M6-18 left behind, and then migrated.
 */
const OURS = '20260909100000_assessment_session_identity.sql';
let database: TestDatabase;

async function buildUpToTheMigration(): Promise<void> {
  await database.revertMigrations().catch(() => undefined);
  for (const migration of readMigrations().filter((m) => m.name < OURS)) await database.pool.query(migration.up);
}

async function runTheMigration(): Promise<void> {
  const ours = readMigrations().find((m) => m.name === OURS)!;
  await database.pool.query(ours.up);
}

/** Inserts rows exactly as M6-18 would have left them, with triggers and keys set aside for the seeding only. */
async function seed(rows: { draftSession?: string; publishedSession?: string }): Promise<void> {
  const client = await database.pool.connect();
  try {
    await client.query('SET session_replication_role = replica');
    if (rows.draftSession !== undefined) {
      await client.query(
        `INSERT INTO assessment.form (form_id, exam_profile_version_id, form_type, session_ref, blueprint_conformance)
         VALUES ($1, $2, 'mock', $3, '{}')`,
        [id(TAG.form, 1), id(TAG.profile), rows.draftSession],
      );
    }
    if (rows.publishedSession !== undefined) {
      await client.query(
        `INSERT INTO assessment.form (form_id, exam_profile_version_id, form_type, session_ref, blueprint_conformance, state, published_at, opens_at, closes_at)
         VALUES ($1, $2, 'mock', $3, '{"satisfied": true}', 'active', now(), '2026-10-21T08:00:00Z', '2026-10-21T12:00:00Z')`,
        [id(TAG.form, 2), id(TAG.profile), rows.publishedSession],
      );
      await client.query(
        `INSERT INTO assessment.attempt (attempt_id, student_id, mode, form_id, exam_profile_version_id, marking_rule_set_hash, taxonomy_version_id,
           delivery_policy, session_id, shift_id, duration_ms, window_closes_at, created_at)
         VALUES ($1, $2, 'mock', $3, $4, $5, $6, '{}', $7, 's', 1000, '2026-10-21T12:00:00Z', now())`,
        [id(TAG.attempt), id(TAG.student), id(TAG.form, 2), id(TAG.profile), 'a'.repeat(64), id(TAG.taxonomy), id(TAG.session)],
      );
    }
  } finally {
    await client.query('RESET session_replication_role');
    client.release();
  }
}

beforeEach(async () => {
  database ??= await connectTestDatabase();
  await buildUpToTheMigration();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.applyMigrations();
  await database.revertMigrations();
  await database.close();
});

describe('migrating forms and attempts that already exist', () => {
  it('turns a real session into a form_session row and backfills the attempt that sat it', async () => {
    await seed({ publishedSession: 'sitting-1' });
    await runTheMigration();
    const sessions = await database.pool.query('SELECT form_id, session_ref FROM assessment.form_session');
    expect(sessions.rows).toEqual([{ form_id: id(TAG.form, 2), session_ref: 'sitting-1' }]);
    const attempt = await database.pool.query('SELECT session_ref FROM assessment.attempt');
    expect(attempt.rows).toEqual([{ session_ref: 'sitting-1' }]);
  });

  it('removes the columns the old identities lived in', async () => {
    await runTheMigration();
    const { rows } = await database.pool.query(
      `SELECT table_name || '.' || column_name AS c FROM information_schema.columns
        WHERE table_schema = 'assessment' AND column_name IN ('session_id', 'session_ref') ORDER BY 1`,
    );
    expect(rows.map((r) => r.c)).toEqual(['attempt.session_ref', 'exposure_ledger_entry.session_ref', 'form_session.session_ref']);
  });

  it('leaves a draft that carried the unassigned placeholder with no session, so it must declare real ones', async () => {
    await seed({ draftSession: 'unassigned:d' });
    await runTheMigration();
    expect((await database.pool.query('SELECT count(*)::int AS n FROM assessment.form_session')).rows[0]).toEqual({ n: 0 });
    expect((await database.pool.query('SELECT count(*)::int AS n FROM assessment.form')).rows[0]).toEqual({ n: 1 });
  });

  it('refuses to run while a published form carries the placeholder, and changes nothing', async () => {
    await seed({ publishedSession: 'unassigned:p' });
    await expect(runTheMigration()).rejects.toThrow('assessment_session_identity_needs_real_sessions');
    const { rows } = await database.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'assessment' AND table_name = 'form_session'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });

  it('trims a legacy session into its canonical form', async () => {
    await seed({ publishedSession: '  sitting-2  ' });
    await runTheMigration();
    expect((await database.pool.query('SELECT session_ref FROM assessment.form_session')).rows).toEqual([{ session_ref: 'sitting-2' }]);
  });
});
