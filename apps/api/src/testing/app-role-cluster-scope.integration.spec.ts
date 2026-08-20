import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DATABASE_URL, connectTestDatabase, type TestDatabase } from './database.js';

/**
 * The regression this proves (infra/migrations/20260814100000_app_role.sql):
 * `questionbank_app` is a cluster-scoped role. `DROP OWNED BY` in that
 * migration's down path only revokes what the role owns in the *current*
 * database — it cannot see, and cannot revoke, grants the same role holds in
 * a different database in the same cluster. The README's own Day One
 * instructions create exactly that condition: step 4 applies migrations to
 * `questionbank`, and the integration suite separately applies them to
 * `questionbank_test` — so after both have run once, `questionbank_app`
 * holds live grants in two databases at once.
 *
 * The old down path also ran `DROP ROLE IF EXISTS questionbank_app`, a
 * cluster-scoped statement a database-scoped migration cannot know is safe:
 * Postgres refuses it with "role questionbank_app cannot be dropped because
 * some objects depend on it" the moment the role holds anything anywhere
 * else in the cluster — which is exactly the state a second, real database
 * left it in. Every `revertMigrations()` after that point failed the same
 * way, in every context, which is what this test reproduces on demand rather
 * than by accident of local setup order.
 *
 * A throwaway third database stands in for `questionbank` here — hermetic,
 * so this passes in CI without depending on a reader having followed the
 * README's manual step first.
 */

function adminUrlFor(baseUrl: string): URL {
  const admin = new URL(baseUrl);
  admin.pathname = '/postgres';
  return admin;
}

const SCRATCH_DATABASE = `questionbank_scratch_${randomUUID().replaceAll('-', '_')}`;

let adminPool: Pool;
let testDatabase: TestDatabase;

beforeAll(async () => {
  adminPool = new Pool({ connectionString: adminUrlFor(DATABASE_URL).toString(), max: 1 });

  // A second, real database in the same cluster — migrated up, which is what
  // leaves questionbank_app holding grants outside the test database.
  await adminPool.query(`CREATE DATABASE ${SCRATCH_DATABASE}`);
  const scratchUrl = new URL(DATABASE_URL);
  scratchUrl.pathname = `/${SCRATCH_DATABASE}`;
  const scratch = await connectTestDatabase(scratchUrl.toString());
  await scratch.applyMigrations();
  await scratch.close();
});

afterAll(async () => {
  await testDatabase.revertMigrations();
  await testDatabase.close();
  // A database-scoped DROP is exactly what the fixed migration itself
  // cannot do for the role — this is cleaning up a whole scratch database,
  // not the cluster role, so it is safe and ordinary.
  await adminPool.query(`DROP DATABASE IF EXISTS ${SCRATCH_DATABASE}`);
  await adminPool.end();
});

describe('the app role migration survives a revert while it still holds grants in another database', () => {
  it('runs up, down and up again against the test database without error', async () => {
    testDatabase = await connectTestDatabase();

    // Whatever state questionbank_test happens to be in — this is the same
    // revert the old migration failed on, now proven to succeed regardless.
    await expect(testDatabase.revertMigrations()).resolves.toBeUndefined();
    await expect(testDatabase.applyMigrations()).resolves.toBeUndefined();
    await expect(testDatabase.revertMigrations()).resolves.toBeUndefined();
    await expect(testDatabase.applyMigrations()).resolves.toBeUndefined();

    const { rows } = await testDatabase.pool.query<{ rolname: string }>(
      `SELECT rolname FROM pg_roles WHERE rolname = 'questionbank_app'`,
    );
    expect(rows).toHaveLength(1);
  });
});
