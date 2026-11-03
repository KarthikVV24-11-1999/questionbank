import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../../../platform/auth/roles.js';
import { PostgresAuditRecorder } from '../../../platform/persistence/audit-recorder.js';
import { DATABASE_URL, connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { seedPerson } from '../../../testing/identity-people.js';
import type { AuditRecord, TransactionalAudit } from '../application/ports.js';
import { CURRENT_PASSWORD_PARAMETERS, type StoredCredential } from '../domain/password-hash.js';
import { PostgresCredentialStore, PostgresOneTimeTokenStore, PostgresRoleStore, PostgresSessionStore, PostgresUserStore } from './postgres-stores.js';

/**
 * A change and its audit row land together, or neither does (M8-14). Every audited write in identity is run twice. Once with an audit write that fails, after the change it records
 * has been made inside the transaction: nothing of the change may remain. And once with a recorder that looks, from a second connection and while the transaction is still open, for
 * the change and for the row: neither may be visible yet, which is what writing the row on the transaction's own connection means. A row written through a pool would be seen at once,
 * and a row written after the commit would be seen only afterwards, so each of those mistakes fails one of the two.
 */
let database: TestDatabase;
let outside: Pool;
const NOW = new Date('2026-11-03T09:00:00.000Z');
const real = () => new PostgresAuditRecorder(database.pool);
const CREDENTIAL = (byte: number): StoredCredential => ({ parameters: CURRENT_PASSWORD_PARAMETERS, salt: new Uint8Array(16).fill(byte), hash: new Uint8Array(32).fill(byte) });

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  outside = new Pool({ connectionString: DATABASE_URL, max: 2 });
});
afterAll(async () => {
  await outside.end();
  await database.revertMigrations();
  await database.close();
});
beforeEach(async () => {
  for (const table of ['session', 'one_time_token', 'credential', 'app_user']) await database.pool.query(`DELETE FROM identity.${table}`);
});

const failing: TransactionalAudit = {
  recordWithin: async () => {
    throw new Error('the audit write failed');
  },
};

interface Case {
  readonly name: string;
  /** Sets the world up and returns the operation, the correlation id its audit row carries, and a check that the change is in the database. */
  readonly arrange: (audit: TransactionalAudit) => Promise<{ run: () => Promise<unknown>; correlationId: string; changed: (db: Pool) => Promise<boolean> }>;
}

const row = (correlationId: string, userId: string, action: string): AuditRecord => ({ principal: { kind: 'human', id: userId, roleContext: [ROLES.learner] }, action, targetContext: 'identity', targetType: 'User', targetId: userId, correlationId, occurredAt: NOW });

async function person(options: { roles?: string[]; verified?: boolean } = {}): Promise<{ userId: string; email: string }> {
  const userId = randomUUID();
  const email = `p-${userId.slice(0, 8)}@example.com`;
  await seedPerson(database.pool, { userId, email, emailNormalized: email, emailVerifiedAt: null, roles: options.roles ?? [ROLES.learner], disabledAt: null, createdAt: NOW }, CREDENTIAL(1));
  await database.pool.query('UPDATE identity.app_user SET email_verified_at = $2 WHERE user_id = $1', [userId, options.verified === true ? NOW : null]);
  return { userId, email };
}

const session = (userId: string) => new PostgresSessionStore(database.pool).insertWithinLimit({ sessionId: randomUUID(), userId, tokenHash: new Uint8Array(32).fill(Math.floor(Math.random() * 255)).map((value, index) => (index === 0 ? Math.floor(Math.random() * 255) : value) ^ index), createdAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000), rotatedFrom: null }, 5);
const liveSessions = async (db: Pool, userId: string): Promise<number> => (await db.query('SELECT count(*)::int AS n FROM identity.session WHERE user_id = $1 AND revoked_at IS NULL', [userId])).rows[0].n;
const rolesOf = async (db: Pool, userId: string): Promise<string[]> => (await db.query('SELECT roles FROM identity.app_user WHERE user_id = $1', [userId])).rows[0].roles;
const hashByte = async (db: Pool, userId: string): Promise<number> => (await db.query('SELECT get_byte(hash, 0) AS b FROM identity.credential WHERE user_id = $1', [userId])).rows[0].b;

const token = (byte: number) => new Uint8Array(32).fill(byte);

const CASES: Case[] = [
  {
    name: 'registering a person',
    arrange: async (audit) => {
      const userId = randomUUID();
      const correlationId = `corr-${userId}`;
      const user = { userId, email: `${userId}@example.com`, emailNormalized: `${userId}@example.com`, emailVerifiedAt: null, roles: [ROLES.learner], disabledAt: null, createdAt: NOW };
      return {
        run: () => new PostgresUserStore(database.pool, audit).create(user, CREDENTIAL(2), row(correlationId, userId, 'UserRegistered')),
        correlationId,
        changed: async (db) => (await db.query('SELECT 1 FROM identity.app_user WHERE user_id = $1', [userId])).rowCount === 1,
      };
    },
  },
  {
    name: 'verifying an address',
    arrange: async (audit) => {
      const who = await person();
      const correlationId = `corr-${who.userId}`;
      await new PostgresOneTimeTokenStore(database.pool, audit).issue({ tokenId: randomUUID(), userId: who.userId, purpose: 'email_verification', tokenHash: token(3), createdAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000) });
      return {
        run: () => new PostgresOneTimeTokenStore(database.pool, audit).verifyEmail(token(3), NOW, (userId) => row(correlationId, userId, 'EmailVerified')),
        correlationId,
        changed: async (db) => (await db.query('SELECT 1 FROM identity.app_user WHERE user_id = $1 AND email_verified_at IS NOT NULL', [who.userId])).rowCount === 1 && (await db.query('SELECT 1 FROM identity.one_time_token WHERE user_id = $1 AND used_at IS NOT NULL', [who.userId])).rowCount === 1,
      };
    },
  },
  {
    name: 'changing a password',
    arrange: async (audit) => {
      const who = await person();
      await session(who.userId);
      const correlationId = `corr-${who.userId}`;
      return {
        run: () => new PostgresCredentialStore(database.pool, audit).replaceAndRevoke({ userId: who.userId, credential: CREDENTIAL(9), at: NOW, exceptSessionId: null, reason: 'password_changed', audit: row(correlationId, who.userId, 'PasswordChanged') }),
        correlationId,
        changed: async (db) => (await hashByte(db, who.userId)) === 9 && (await liveSessions(db, who.userId)) === 0,
      };
    },
  },
  {
    name: 'resetting a password',
    arrange: async (audit) => {
      const who = await person();
      await session(who.userId);
      const correlationId = `corr-${who.userId}`;
      await new PostgresOneTimeTokenStore(database.pool, audit).issue({ tokenId: randomUUID(), userId: who.userId, purpose: 'password_recovery', tokenHash: token(4), createdAt: NOW, expiresAt: new Date(NOW.getTime() + 3_600_000) });
      return {
        run: () => new PostgresCredentialStore(database.pool, audit).resetWithToken({ tokenHash: token(4), credential: CREDENTIAL(8), at: NOW, audit: (userId) => row(correlationId, userId, 'PasswordReset') }),
        correlationId,
        changed: async (db) => (await hashByte(db, who.userId)) === 8 && (await liveSessions(db, who.userId)) === 0 && (await db.query('SELECT 1 FROM identity.one_time_token WHERE user_id = $1 AND used_at IS NOT NULL', [who.userId])).rowCount === 1,
      };
    },
  },
  {
    name: 'ending every session',
    arrange: async (audit) => {
      const who = await person();
      await session(who.userId);
      const correlationId = `corr-${who.userId}`;
      return {
        run: () => new PostgresCredentialStore(database.pool, audit).revokeAll(who.userId, NOW, 'logout_all', row(correlationId, who.userId, 'AllSessionsRevoked')),
        correlationId,
        changed: async (db) => (await liveSessions(db, who.userId)) === 0,
      };
    },
  },
  {
    name: 'giving a role',
    arrange: async (audit) => {
      const who = await person();
      const correlationId = `corr-${who.userId}`;
      return {
        run: () => new PostgresRoleStore(database.pool, audit).change({ actorId: randomUUID(), email: who.email, role: ROLES.author, operation: 'assign', audit: (userId) => row(correlationId, userId, 'RoleAssigned') }),
        correlationId,
        changed: async (db) => (await rolesOf(db, who.userId)).includes(ROLES.author),
      };
    },
  },
  {
    name: 'taking a role away',
    arrange: async (audit) => {
      const who = await person({ roles: [ROLES.learner, ROLES.author] });
      const correlationId = `corr-${who.userId}`;
      return {
        run: () => new PostgresRoleStore(database.pool, audit).change({ actorId: randomUUID(), email: who.email, role: ROLES.author, operation: 'remove', audit: (userId) => row(correlationId, userId, 'RoleRemoved') }),
        correlationId,
        changed: async (db) => !(await rolesOf(db, who.userId)).includes(ROLES.author),
      };
    },
  },
  {
    name: 'making the first administrator',
    arrange: async (audit) => {
      const who = await person({ verified: true });
      const correlationId = `corr-${who.userId}`;
      return {
        run: () => new PostgresRoleStore(database.pool, audit).grantFirstAdmin(who.email, (userId) => row(correlationId, userId, 'FirstAdminGranted')),
        correlationId,
        changed: async (db) => (await rolesOf(db, who.userId)).includes(ROLES.admin),
      };
    },
  },
];

const auditRows = async (db: Pool, correlationId: string): Promise<number> => (await db.query('SELECT count(*)::int AS n FROM platform.audit_record WHERE correlation_id = $1', [correlationId])).rows[0].n;

describe.each(CASES)('$name', ({ arrange }) => {
  it('is taken back whole when its audit row cannot be written: the change is not there afterwards', async () => {
    const { run, correlationId, changed } = await arrange(failing);
    expect(await changed(outside)).toBe(false);
    await expect(run()).rejects.toThrow('the audit write failed');
    expect(await changed(outside)).toBe(false);
    expect(await auditRows(outside, correlationId)).toBe(0);
  });

  it('commits the change and its row together: while the transaction is open neither can be seen from another connection, and afterwards both can', async () => {
    const seen: Array<{ changed: boolean; rows: number }> = [];
    let probe: (() => Promise<void>) | undefined;
    const looking: TransactionalAudit = {
      recordWithin: async (db, entry) => {
        await real().recordWithin(db, entry);
        await probe?.();
      },
    };
    const { run, correlationId, changed } = await arrange(looking);
    probe = async () => void seen.push({ changed: await changed(outside), rows: await auditRows(outside, correlationId) });
    await run();
    expect(seen).toEqual([{ changed: false, rows: 0 }]);
    expect(await changed(outside)).toBe(true);
    expect(await auditRows(outside, correlationId)).toBe(1);
  });
});

describe('a write that changes nothing', () => {
  it('writes no audit row: a role already held, an address nobody has, a code that does not hold', async () => {
    const who = await person({ roles: [ROLES.learner, ROLES.author] });
    const correlationId = `corr-${randomUUID()}`;
    const roles = new PostgresRoleStore(database.pool, real());
    const audit = (userId: string) => row(correlationId, userId, 'RoleAssigned');
    expect(await roles.change({ actorId: randomUUID(), email: who.email, role: ROLES.author, operation: 'assign', audit })).toMatchObject({ status: 'unchanged' });
    expect(await roles.change({ actorId: randomUUID(), email: 'nobody@example.com', role: ROLES.author, operation: 'assign', audit })).toEqual({ status: 'not_found' });
    expect(await new PostgresOneTimeTokenStore(database.pool, real()).verifyEmail(token(77), NOW, audit)).toBeNull();
    expect(await new PostgresCredentialStore(database.pool, real()).resetWithToken({ tokenHash: token(78), credential: CREDENTIAL(5), at: NOW, audit })).toBeNull();
    expect(await auditRows(outside, correlationId)).toBe(0);
  });
});
