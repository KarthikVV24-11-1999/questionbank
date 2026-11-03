import { auditFor, seedPerson } from '../../../testing/identity-people.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../../../platform/auth/roles.js';
import { PostgresAuditRecorder } from '../../../platform/persistence/audit-recorder.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { CURRENT_PASSWORD_PARAMETERS } from '../domain/password-hash.js';
import { PostgresRoleStore, PostgresUserStore } from './postgres-stores.js';

let database: TestDatabase;
const NOW = new Date('2026-11-03T09:00:00.000Z');
const CREDENTIAL = { parameters: CURRENT_PASSWORD_PARAMETERS, salt: new Uint8Array(16).fill(1), hash: new Uint8Array(32).fill(2) };

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

async function person(options: { roles?: string[]; verified?: boolean; disabled?: boolean } = {}): Promise<{ email: string; userId: string }> {
  const userId = randomUUID();
  const email = `p-${userId.slice(0, 8)}@example.com`;
  await seedPerson(database.pool, { userId, email, emailNormalized: email, emailVerifiedAt: options.verified === true ? NOW : null, roles: options.roles ?? [ROLES.learner], disabledAt: options.disabled === true ? NOW : null, createdAt: NOW }, CREDENTIAL);
  // `create` makes an unverified, enabled person; the rest is set the way the application sets it
  await database.pool.query('UPDATE identity.app_user SET email_verified_at = $2, disabled_at = $3 WHERE user_id = $1', [userId, options.verified === true ? NOW : null, options.disabled === true ? NOW : null]);
  return { email, userId };
}
const rolesOf = async (userId: string): Promise<string[]> => (await database.pool.query('SELECT roles FROM identity.app_user WHERE user_id = $1', [userId])).rows[0].roles;
const store = () => new PostgresRoleStore(database.pool, new PostgresAuditRecorder(database.pool));
const AUDIT = (action: string) => (userId: string) => ({ ...auditFor(action)(userId), targetType: 'UserRole' });
/** Somebody who is not the person changed: the store judges nothing about the asker's role, the handler's policy did that. */
const ASKER = '00000000-0000-4000-8000-0000000000a1';

describe('assigning a role', () => {
  it('adds it to the roles a person holds, and keeps the ones they had', async () => {
    const who = await person();
    expect(await store().change({ actorId: ASKER, email: who.email, role: ROLES.author, operation: 'assign', audit: AUDIT('RoleAssigned') })).toEqual({ status: 'changed', userId: who.userId, roles: [ROLES.learner, ROLES.author] });
    expect(await rolesOf(who.userId)).toEqual([ROLES.learner, ROLES.author]);
  });

  it('changes nothing for a role already held', async () => {
    const who = await person({ roles: [ROLES.learner, ROLES.author] });
    expect(await store().change({ actorId: ASKER, email: who.email, role: ROLES.author, operation: 'assign', audit: AUDIT('RoleAssigned') })).toEqual({ status: 'unchanged', userId: who.userId, roles: [ROLES.learner, ROLES.author] });
    expect(await rolesOf(who.userId)).toEqual([ROLES.learner, ROLES.author]);
  });

  it('says not_found for an address nobody has, and touches nobody', async () => {
    const bystander = await person();
    expect(await store().change({ actorId: ASKER, email: 'nobody@example.com', role: ROLES.author, operation: 'assign', audit: AUDIT('RoleAssigned') })).toEqual({ status: 'not_found' });
    expect(await rolesOf(bystander.userId)).toEqual([ROLES.learner]);
  });

  it('assigns to the person named and to no one else', async () => {
    const [a, b] = [await person(), await person()];
    await store().change({ actorId: ASKER, email: a.email, role: ROLES.reviewer, operation: 'assign', audit: AUDIT('RoleAssigned') });
    expect([await rolesOf(a.userId), await rolesOf(b.userId)]).toEqual([[ROLES.learner, ROLES.reviewer], [ROLES.learner]]);
  });
});

describe('changing one\'s own roles', () => {
  it('is refused, either way, and changes nothing: the store is told who is asking', async () => {
    const who = await person({ roles: [ROLES.learner, ROLES.admin] });
    await person({ roles: [ROLES.learner, ROLES.admin] });
    expect(await store().change({ actorId: who.userId, email: who.email, role: ROLES.author, operation: 'assign', audit: AUDIT('RoleAssigned') })).toEqual({ status: 'self' });
    expect(await store().change({ actorId: who.userId, email: who.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') })).toEqual({ status: 'self' });
    expect(await rolesOf(who.userId)).toEqual([ROLES.learner, ROLES.admin]);
  });

  it('is refused only for the asker\'s own row: another person\'s is changed as usual', async () => {
    const [asker, other] = [await person({ roles: [ROLES.learner, ROLES.admin] }), await person()];
    expect(await store().change({ actorId: asker.userId, email: other.email, role: ROLES.author, operation: 'assign', audit: AUDIT('RoleAssigned') })).toMatchObject({ status: 'changed' });
  });
});

describe('removing a role', () => {
  it('takes it away and keeps the others', async () => {
    const who = await person({ roles: [ROLES.learner, ROLES.author] });
    expect(await store().change({ actorId: ASKER, email: who.email, role: ROLES.author, operation: 'remove', audit: AUDIT('RoleRemoved') })).toEqual({ status: 'changed', userId: who.userId, roles: [ROLES.learner] });
    expect(await rolesOf(who.userId)).toEqual([ROLES.learner]);
  });

  it('changes nothing for a role not held', async () => {
    const who = await person();
    expect(await store().change({ actorId: ASKER, email: who.email, role: ROLES.author, operation: 'remove', audit: AUDIT('RoleRemoved') })).toEqual({ status: 'unchanged', userId: who.userId, roles: [ROLES.learner] });
  });

  it('will not take a person\'s only role, whichever it is', async () => {
    const who = await person({ roles: [ROLES.author] });
    expect(await store().change({ actorId: ASKER, email: who.email, role: ROLES.author, operation: 'remove', audit: AUDIT('RoleRemoved') })).toEqual({ status: 'last_role' });
    expect(await rolesOf(who.userId)).toEqual([ROLES.author]);
  });

  it('will not take the last administrator\'s role, and will once there is another', async () => {
    const [first, second] = [await person({ roles: [ROLES.learner, ROLES.admin] }), await person({ roles: [ROLES.learner, ROLES.admin] })];
    expect(await store().change({ actorId: ASKER, email: first.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') })).toMatchObject({ status: 'changed' });
    expect(await store().change({ actorId: ASKER, email: second.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') })).toEqual({ status: 'last_admin' });
    expect(await rolesOf(second.userId)).toEqual([ROLES.learner, ROLES.admin]);
  });

  it('does not count a disabled administrator as one who could still administer', async () => {
    const live = await person({ roles: [ROLES.learner, ROLES.admin] });
    await person({ roles: [ROLES.learner, ROLES.admin], disabled: true });
    expect(await store().change({ actorId: ASKER, email: live.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') })).toEqual({ status: 'last_admin' });
  });

  it('lets a disabled administrator\'s role go, since it was not holding the system up', async () => {
    await person({ roles: [ROLES.learner, ROLES.admin] });
    const gone = await person({ roles: [ROLES.learner, ROLES.admin], disabled: true });
    expect(await store().change({ actorId: ASKER, email: gone.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') })).toMatchObject({ status: 'changed' });
  });

  it('lets a disabled administrator\'s role go even when it is the only one: nobody could administer through it anyway', async () => {
    const gone = await person({ roles: [ROLES.learner, ROLES.admin], disabled: true });
    expect(await store().change({ actorId: ASKER, email: gone.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') })).toMatchObject({ status: 'changed' });
  });

  it('never leaves nobody an administrator when two are removed at once: one removal holds and the other is refused', async () => {
    for (let round = 0; round < 12; round += 1) {
      await database.pool.query('DELETE FROM identity.credential');
      await database.pool.query('DELETE FROM identity.app_user');
      const [a, b] = [await person({ roles: [ROLES.learner, ROLES.admin] }), await person({ roles: [ROLES.learner, ROLES.admin] })];
      const outcomes = await Promise.all([store().change({ actorId: ASKER, email: a.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') }), store().change({ actorId: ASKER, email: b.email, role: ROLES.admin, operation: 'remove', audit: AUDIT('RoleRemoved') })]);
      expect(outcomes.map((outcome) => outcome.status).sort(), `round ${round}`).toEqual(['changed', 'last_admin']);
      expect((await database.pool.query('SELECT count(*)::int AS n FROM identity.app_user WHERE $1 = ANY(roles)', [ROLES.admin])).rows[0].n).toBe(1);
    }
  });
});

describe('two roles of a person at once', () => {
  it('cannot both be taken from someone who holds just those two: one goes, the other would leave them with none and is refused', async () => {
    for (let round = 0; round < 12; round += 1) {
      const who = await person({ roles: [ROLES.author, ROLES.reviewer] });
      const outcomes = await Promise.all([store().change({ actorId: ASKER, email: who.email, role: ROLES.author, operation: 'remove', audit: AUDIT('RoleRemoved') }), store().change({ actorId: ASKER, email: who.email, role: ROLES.reviewer, operation: 'remove', audit: AUDIT('RoleRemoved') })]);
      expect(outcomes.map((outcome) => outcome.status).sort(), `round ${round}`).toEqual(['changed', 'last_role']);
      expect((await rolesOf(who.userId)).length, `round ${round}`).toBe(1);
    }
  });
});

describe('making the first administrator', () => {
  it('grants it to a verified person when no administrator exists, and keeps their other roles', async () => {
    const who = await person({ verified: true });
    expect(await store().grantFirstAdmin(who.email, AUDIT('FirstAdminGranted'))).toEqual({ status: 'granted', userId: who.userId });
    expect(await rolesOf(who.userId)).toEqual([ROLES.learner, ROLES.admin]);
  });

  it('refuses an address that is not verified, and one nobody has', async () => {
    const unverified = await person();
    expect(await store().grantFirstAdmin(unverified.email, AUDIT('FirstAdminGranted'))).toEqual({ status: 'not_verified' });
    expect(await store().grantFirstAdmin('nobody@example.com', AUDIT('FirstAdminGranted'))).toEqual({ status: 'not_found' });
    expect(await rolesOf(unverified.userId)).toEqual([ROLES.learner]);
  });

  it('refuses once an enabled administrator exists, whoever asks', async () => {
    await person({ roles: [ROLES.learner, ROLES.admin] });
    const later = await person({ verified: true });
    expect(await store().grantFirstAdmin(later.email, AUDIT('FirstAdminGranted'))).toEqual({ status: 'admin_exists' });
    expect(await rolesOf(later.userId)).toEqual([ROLES.learner]);
  });

  it('is open again when every administrator is disabled, since then nobody can administer', async () => {
    await person({ roles: [ROLES.learner, ROLES.admin], disabled: true });
    const next = await person({ verified: true });
    expect(await store().grantFirstAdmin(next.email, AUDIT('FirstAdminGranted'))).toEqual({ status: 'granted', userId: next.userId });
  });

  it('makes one administrator when two operators run it at once', async () => {
    for (let round = 0; round < 12; round += 1) {
      await database.pool.query('DELETE FROM identity.credential');
      await database.pool.query('DELETE FROM identity.app_user');
      const [a, b] = [await person({ verified: true }), await person({ verified: true })];
      const outcomes = await Promise.all([store().grantFirstAdmin(a.email, AUDIT('FirstAdminGranted')), store().grantFirstAdmin(b.email, AUDIT('FirstAdminGranted'))]);
      expect(outcomes.map((outcome) => outcome.status).sort(), `round ${round}`).toEqual(['admin_exists', 'granted']);
    }
  });
});
