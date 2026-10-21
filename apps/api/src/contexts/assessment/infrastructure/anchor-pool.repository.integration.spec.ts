import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import { refusal } from '../../../testing/assessment-db.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { addAnchorPoolMember } from '../domain/anchor-pool.js';
import { PostgresAnchorPoolRepository } from './anchor-pool.repository.js';

/** Real Postgres, never a double (ENGINEERING-HANDBOOK §5). */
let database: TestDatabase;
let pool: PostgresAnchorPoolRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  pool = new PostgresAnchorPoolRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

beforeEach(async () => {
  await database.pool.query('TRUNCATE assessment.anchor_pool_member');
});

const member = (n: number, addedAt = '2026-10-01T00:00:00.000Z') =>
  expectValue(addAnchorPoolMember({ itemVersionId: id(TAG.itemVersion, n), exposureCap: 40 + n, addedAt }));

describe('membership is a stored fact', () => {
  // Field by field against literals, never `toEqual(saved)` (ADR-0017).
  it('reads back every field of a member', async () => {
    expectValue(await pool.add(member(1)));
    const [found] = expectValue(await pool.listActive());
    expect(found!.itemVersionId).toBe('000000b3-0000-4000-8000-000000000001');
    expect(found!.exposureCap).toBe(41);
    expect(found!.addedAt).toBe('2026-10-01T00:00:00.000Z');
    expect(found!.retiredAt).toBeNull();
    expect(Object.keys(found!).sort()).toEqual(['addedAt', 'exposureCap', 'itemVersionId', 'retiredAt']);
  });

  it('lists the active members oldest first, and not the ones that left', async () => {
    expectValue(await pool.add(member(2, '2026-10-02T00:00:00.000Z')));
    expectValue(await pool.add(member(1, '2026-10-01T00:00:00.000Z')));
    expectValue(await pool.add(member(3, '2026-10-03T00:00:00.000Z')));
    expectValue(await pool.retire(id(TAG.itemVersion, 2), '2026-11-01T00:00:00.000Z'));
    expect(expectValue(await pool.listActive()).map((m) => m.itemVersionId)).toEqual([id(TAG.itemVersion, 1), id(TAG.itemVersion, 3)]);
  });

  it('is empty before anything is added', async () => {
    expect(expectValue(await pool.listActive())).toEqual([]);
  });
});

describe('a version does not come back', () => {
  it('refuses to add a version already in the pool, and one that has left', async () => {
    expectValue(await pool.add(member(1)));
    expect(expectError(await pool.add(member(1))).code).toBe('CONFLICT');
    expectValue(await pool.retire(id(TAG.itemVersion, 1), '2026-11-01T00:00:00.000Z'));
    expect(expectError(await pool.add(member(1))).code).toBe('CONFLICT');
  });

  it('retires once: NotFound for a stranger, Conflict the second time, and the first time stands', async () => {
    expect(expectError(await pool.retire(id(TAG.itemVersion, 9), '2026-11-01T00:00:00.000Z')).kind).toBe('NotFound');
    expectValue(await pool.add(member(1)));
    const retired = expectValue(await pool.retire(id(TAG.itemVersion, 1), '2026-11-01T00:00:00.000Z'));
    expect(retired.retiredAt).toBe('2026-11-01T00:00:00.000Z');
    expect(expectError(await pool.retire(id(TAG.itemVersion, 1), '2026-12-01T00:00:00.000Z')).code).toBe('CONFLICT');
    const { rows } = await database.pool.query('SELECT retired_at FROM assessment.anchor_pool_member');
    expect(rows[0].retired_at.toISOString()).toBe('2026-11-01T00:00:00.000Z');
  });

  it('refuses to retire a version before it joined', async () => {
    expectValue(await pool.add(member(1)));
    expect(expectError(await pool.retire(id(TAG.itemVersion, 1), '2026-09-01T00:00:00.000Z')).code).toBe('PERSISTENCE_REJECTED');
  });

  it('lets only one of two simultaneous retirements win: the one that read an unretired row loses its update', async () => {
    expectValue(await pool.add(member(1)));
    const first = await database.pool.connect();
    try {
      await first.query('BEGIN');
      await first.query(`UPDATE assessment.anchor_pool_member SET retired_at = '2026-11-01T00:00:00Z'`);
      // reads the committed, still-unretired row, then waits on the lock the first transaction holds
      const second = pool.retire(id(TAG.itemVersion, 1), '2026-11-02T00:00:00.000Z');
      // Wait for the condition, never a duration: the second retirement is blocked on the row.
      for (;;) {
        const { rows } = await database.pool.query(`SELECT 1 FROM pg_stat_activity WHERE wait_event_type = 'Lock' AND query LIKE 'UPDATE assessment.anchor_pool_member%'`);
        if (rows.length > 0) break;
        await new Promise((resolve) => setImmediate(resolve));
      }
      await first.query('COMMIT');
      expect(expectError(await second).code).toBe('CONFLICT');
    } finally {
      first.release();
    }
  });
});

describe('the database holds the pool\'s rules too', () => {
  it('refuses to delete a member, as owner and as the application role', async () => {
    expectValue(await pool.add(member(1)));
    expect(await refusal(() => database.pool.query('DELETE FROM assessment.anchor_pool_member'))).toContain('assessment_anchor_pool_member_is_never_deleted');
    const client = await database.pool.connect();
    try {
      await client.query('SET ROLE questionbank_app');
      expect(await refusal(() => client.query('DELETE FROM assessment.anchor_pool_member'))).toContain('permission denied');
      expect(await refusal(() => client.query('TRUNCATE assessment.anchor_pool_member'))).toContain('permission denied');
    } finally {
      await client.query('RESET ROLE');
      client.release();
    }
  });

  it('refuses every change to a row except leaving the pool, once', async () => {
    expectValue(await pool.add(member(1)));
    for (const set of [`exposure_cap = 999`, `added_at = now()`, `item_version_id = '${id(TAG.itemVersion, 9)}'`, `retired_at = NULL`]) {
      expect(await refusal(() => database.pool.query(`UPDATE assessment.anchor_pool_member SET ${set}`)), set).toContain('assessment_anchor_pool_member_only_retires');
    }
    await database.pool.query(`UPDATE assessment.anchor_pool_member SET retired_at = '2026-11-01T00:00:00Z'`);
    expect(await refusal(() => database.pool.query(`UPDATE assessment.anchor_pool_member SET retired_at = '2026-12-01T00:00:00Z'`))).toContain('only_retires');
  });

  it('is the trigger that refuses: with it dropped, the cap can be rewritten', async () => {
    expectValue(await pool.add(member(1)));
    const client = await database.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DROP TRIGGER anchor_pool_member_guarded ON assessment.anchor_pool_member');
      const result = await client.query('UPDATE assessment.anchor_pool_member SET exposure_cap = 999');
      expect(result.rowCount).toBe(1);
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  });
});

describe('what the store refuses', () => {
  it('reports a connection failure as a value', async () => {
    const { Pool } = await import('pg');
    const broken = new Pool({ connectionString: 'postgres://postgres@127.0.0.1:1/none', connectionTimeoutMillis: 200 });
    broken.on('error', () => undefined);
    const repo = new PostgresAnchorPoolRepository(broken);
    expect(expectError(await repo.add(member(1))).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await repo.retire(id(TAG.itemVersion, 1), '2026-11-01T00:00:00.000Z')).code).toBe('PERSISTENCE_REJECTED');
    expect(expectError(await repo.listActive()).code).toBe('PERSISTENCE_REJECTED');
    await broken.end().catch(() => undefined);
  });
});
