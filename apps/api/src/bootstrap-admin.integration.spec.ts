import { seedPerson } from './testing/identity-people.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { run } from './bootstrap-admin.js';
import { PostgresUserStore } from './contexts/identity/infrastructure/postgres-stores.js';
import { CURRENT_PASSWORD_PARAMETERS } from './contexts/identity/domain/password-hash.js';
import { DATABASE_URL, connectTestDatabase, type TestDatabase } from './testing/database.js';

let database: TestDatabase;
const NOW = new Date('2026-11-03T09:00:00.000Z');
const LOADED = () => ({ ok: true as const, value: { databaseUrl: DATABASE_URL } });

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
  await database.pool.query('DELETE FROM identity.credential');
  await database.pool.query('DELETE FROM identity.app_user');
});

async function person(verified: boolean): Promise<{ email: string; userId: string }> {
  const userId = randomUUID();
  const email = `first-${userId.slice(0, 8)}@example.com`;
  await seedPerson(database.pool, { userId, email, emailNormalized: email, emailVerifiedAt: null, roles: ['learner'], disabledAt: null, createdAt: NOW }, { parameters: CURRENT_PASSWORD_PARAMETERS, salt: new Uint8Array(16), hash: new Uint8Array(32) });
  if (verified) await database.pool.query('UPDATE identity.app_user SET email_verified_at = $2 WHERE user_id = $1', [userId, NOW]);
  return { email, userId };
}

async function command(args: string[], load: Parameters<typeof run>[1] = LOADED) {
  const lines: string[] = [];
  const code = await run(args, load, (line) => void lines.push(line));
  return { code, output: lines.join('\n') };
}

describe('the first-administrator command (M8-12)', () => {
  it('makes a verified person an administrator, says so, exits 0, and leaves an audit row from the system', async () => {
    const who = await person(true);
    const result = await command([who.email.toUpperCase()]);
    expect(result).toEqual({ code: 0, output: `${who.email} is now an administrator` });
    expect((await database.pool.query('SELECT roles FROM identity.app_user WHERE user_id = $1', [who.userId])).rows[0].roles).toEqual(['learner', 'admin']);
    const audit = (await database.pool.query(`SELECT action, principal_kind, target_id FROM platform.audit_record WHERE target_context = 'identity' AND action = 'FirstAdminGranted'`)).rows;
    expect(audit).toEqual([{ action: 'FirstAdminGranted', principal_kind: 'system', target_id: `${who.userId}:admin` }]);
  });

  it('refuses a second run, exits 1, says why, and changes nothing', async () => {
    const [first, second] = [await person(true), await person(true)];
    expect((await command([first.email])).code).toBe(0);
    const again = await command([second.email]);
    expect(again).toEqual({ code: 1, output: 'There is already an administrator; roles are assigned by one.' });
    expect((await database.pool.query('SELECT roles FROM identity.app_user WHERE user_id = $1', [second.userId])).rows[0].roles).toEqual(['learner']);
  });

  it('refuses an address that is not verified and one nobody registered, each with its own words and exit 1', async () => {
    const unverified = await person(false);
    expect(await command([unverified.email])).toEqual({ code: 1, output: 'That address is not verified yet.' });
    expect(await command(['nobody@example.com'])).toEqual({ code: 1, output: 'There is no one with that address; register it first.' });
  });

  it('exits 2, and touches nothing, when it cannot run: no address, two addresses, a configuration that does not load, a database that is not there', async () => {
    const who = await person(true);
    expect(await command([])).toEqual({ code: 2, output: 'usage: bootstrap-admin <email>' });
    expect(await command([who.email, 'someone.else@example.com'])).toEqual({ code: 2, output: 'usage: bootstrap-admin <email>' });
    expect(await command([who.email], () => ({ ok: false, error: { key: 'databaseUrl', message: 'DATABASE_URL is not set' } }))).toEqual({ code: 2, output: 'DATABASE_URL is not set' });
    const unreachable = await command([who.email], () => ({ ok: true, value: { databaseUrl: 'postgres://postgres@127.0.0.1:1/nothing' } }));
    expect(unreachable.code).toBe(2);
    expect(unreachable.output).toMatch(/^could not run: /u);
    expect((await database.pool.query('SELECT roles FROM identity.app_user WHERE user_id = $1', [who.userId])).rows[0].roles).toEqual(['learner']);
  });
});
