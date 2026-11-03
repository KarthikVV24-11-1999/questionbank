import { describe, expect, it } from 'vitest';
import { ROLES, ROLE_VALUES } from '../../../../platform/auth/roles.js';
import type { ApplicationContext, AuditFor, AuditRecord, RoleChangeOutcome, RoleStore, FirstAdminOutcome } from '../ports.js';
import { ASSIGNABLE_ROLES, ASSIGN_ROLE_POLICY, AssignRoleHandler, BOOTSTRAP_ADMIN_POLICY, BootstrapFirstAdminHandler, REMOVE_ROLE_POLICY, RemoveRoleHandler } from './role-handlers.js';

const NOW = new Date('2026-11-03T09:00:00.000Z');
const principal = (...roles: string[]) => ({ kind: 'human' as const, id: 'caller-1', roleContext: roles });
const context = (...roles: string[]): ApplicationContext => ({ principal: principal(...roles), correlationId: 'corr-1' });

/**
 * The store is told what to audit, and writes it itself in the transaction of the change (M8-14). The fake does what the real one does on the two outcomes that audit: it calls the
 * function it was given with the person's id and keeps the row, and on every other outcome it writes nothing. The atomicity itself is the store's, and is tested there.
 */
function rig(outcome: RoleChangeOutcome | FirstAdminOutcome = { status: 'changed', userId: 'user-9', roles: ['learner', 'author'] }) {
  const calls: unknown[] = [];
  const audits: AuditRecord[] = [];
  const writes = (audit: AuditFor) => {
    if (outcome.status === 'changed' || outcome.status === 'granted') audits.push(audit((outcome as { userId: string }).userId));
  };
  const roles: RoleStore = {
    change: async (change) => (calls.push({ ...change, audit: undefined }), writes(change.audit), outcome as RoleChangeOutcome),
    grantFirstAdmin: async (email, audit) => (calls.push(email), writes(audit), outcome as FirstAdminOutcome),
  };
  const deps = { roles, clock: { now: () => NOW } };
  return { calls, audits, assign: new AssignRoleHandler(deps), remove: new RemoveRoleHandler(deps), bootstrap: new BootstrapFirstAdminHandler(deps) };
}

describe('who may assign and remove a role', () => {
  it('is admin, alone: the policies name no other role', () => {
    expect(ASSIGN_ROLE_POLICY.allowedRoles).toEqual([ROLES.admin]);
    expect(REMOVE_ROLE_POLICY.allowedRoles).toEqual([ROLES.admin]);
  });

  it('each handler carries its own policy, named for the command: a denial says which command was refused', async () => {
    const { assign, remove, bootstrap } = rig();
    expect([assign.policy, remove.policy, bootstrap.policy]).toEqual([ASSIGN_ROLE_POLICY, REMOVE_ROLE_POLICY, BOOTSTRAP_ADMIN_POLICY]);
    expect([assign.policy.name, remove.policy.name, bootstrap.policy.name]).toEqual(['AssignRole', 'RemoveRole', 'BootstrapFirstAdmin']);
    expect(await remove.handle({ email: 'a@example.com', role: ROLES.author }, context(ROLES.learner))).toMatchObject({ error: { message: expect.stringContaining('RemoveRole') } });
  });

  it('refuses every other role, before it reads or writes anything', async () => {
    const { calls, audits, assign, remove } = rig();
    for (const role of ROLE_VALUES.filter((value) => value !== ROLES.admin)) {
      for (const handler of [assign, remove]) {
        const result = await handler.handle({ email: 'a@example.com', role: ROLES.author }, context(role));
        expect(result, `${handler.name} as ${role}`).toMatchObject({ ok: false, error: { kind: 'Authorization', code: 'NOT_PERMITTED' } });
      }
    }
    expect(calls).toEqual([]);
    expect(audits).toEqual([]);
  });

  it('admits an admin who also holds other roles', async () => {
    const { assign } = rig();
    expect((await assign.handle({ email: 'a@example.com', role: ROLES.author }, context(ROLES.learner, ROLES.admin))).ok).toBe(true);
  });
});

describe('which roles a person can hold', () => {
  it('are the human ones: not a guest, not the system, not the generation pipeline', () => {
    expect([...ASSIGNABLE_ROLES].sort()).toEqual([ROLES.admin, ROLES.author, ROLES.contentOps, ROLES.curriculumCurator, ROLES.examOwner, ROLES.learner, ROLES.ops, ROLES.reviewer].sort());
  });

  it('refuses anything else with the same answer, and writes nothing', async () => {
    const { calls, assign, remove } = rig();
    for (const bad of [ROLES.guest, ROLES.system, ROLES.generationPipeline, 'banana', '', undefined, null, 7, ['admin']]) {
      for (const handler of [assign, remove]) {
        expect(await handler.handle({ email: 'a@example.com', role: bad }, context(ROLES.admin)), `${handler.name} ${String(bad)}`).toMatchObject({ ok: false, error: { kind: 'Validation', code: 'ROLE_NOT_ASSIGNABLE' } });
      }
    }
    expect(calls).toEqual([]);
  });

  it('refuses an address that is not one', async () => {
    const { calls, assign } = rig();
    expect(await assign.handle({ email: 'not-an-address', role: ROLES.author }, context(ROLES.admin))).toMatchObject({ ok: false, error: { kind: 'Validation', code: 'EMAIL_INVALID' } });
    expect(calls).toEqual([]);
  });
});

describe('what a change does', () => {
  it('asks the store for the address as it is keyed, the role, and which way', async () => {
    const { calls, assign, remove } = rig();
    await assign.handle({ email: '  Asha@Example.COM ', role: ROLES.reviewer }, context(ROLES.admin));
    await remove.handle({ email: 'asha@example.com', role: ROLES.reviewer }, context(ROLES.admin));
    expect(calls).toEqual([
      { actorId: 'caller-1', email: 'asha@example.com', role: ROLES.reviewer, operation: 'assign', audit: undefined },
      { actorId: 'caller-1', email: 'asha@example.com', role: ROLES.reviewer, operation: 'remove', audit: undefined },
    ]);
  });

  it('audits a change that changed something: who did it, to whom, which role, and which way', async () => {
    const { audits, assign, remove } = rig({ status: 'changed', userId: 'user-9', roles: ['learner', 'author'] });
    expect(await assign.handle({ email: 'a@example.com', role: ROLES.author }, context(ROLES.admin))).toEqual({ ok: true, value: { userId: 'user-9', roles: ['learner', 'author'], changed: true } });
    await remove.handle({ email: 'a@example.com', role: ROLES.author }, context(ROLES.admin));
    expect(audits).toEqual([
      { principal: principal(ROLES.admin), action: 'RoleAssigned', targetContext: 'identity', targetType: 'UserRole', targetId: 'user-9:author', correlationId: 'corr-1', occurredAt: NOW },
      { principal: principal(ROLES.admin), action: 'RoleRemoved', targetContext: 'identity', targetType: 'UserRole', targetId: 'user-9:author', correlationId: 'corr-1', occurredAt: NOW },
    ]);
  });

  it('says so and audits nothing when the person already was, or already was not, what was asked', async () => {
    const { audits, assign } = rig({ status: 'unchanged', userId: 'user-9', roles: ['learner', 'author'] });
    expect(await assign.handle({ email: 'a@example.com', role: ROLES.author }, context(ROLES.admin))).toEqual({ ok: true, value: { userId: 'user-9', roles: ['learner', 'author'], changed: false } });
    expect(audits).toEqual([]);
  });

  it.each([
    [{ status: 'not_found' }, 'NotFound', 'USER_NOT_FOUND'],
    [{ status: 'last_role' }, 'RuleViolation', 'LAST_ROLE'],
    [{ status: 'last_admin' }, 'RuleViolation', 'LAST_ADMIN'],
    [{ status: 'self' }, 'RuleViolation', 'OWN_ROLES'],
  ] as const)('answers %j with %s %s, and audits nothing', async (outcome, kind, code) => {
    const { audits, remove } = rig(outcome);
    expect(await remove.handle({ email: 'a@example.com', role: ROLES.admin }, context(ROLES.admin))).toMatchObject({ ok: false, error: { kind, code } });
    expect(audits).toEqual([]);
  });
});

describe('the first administrator', () => {
  const system: ApplicationContext = { principal: { kind: 'system', id: 'bootstrap', roleContext: [ROLES.system] }, correlationId: 'corr-1' };

  it('is made by the system alone', async () => {
    expect(BOOTSTRAP_ADMIN_POLICY.allowedRoles).toEqual([ROLES.system]);
    const { calls, bootstrap } = rig({ status: 'granted', userId: 'user-9' });
    for (const role of ROLE_VALUES.filter((value) => value !== ROLES.system)) {
      expect(await bootstrap.handle({ email: 'a@example.com' }, context(role)), role).toMatchObject({ ok: false, error: { code: 'NOT_PERMITTED' } });
    }
    expect(calls).toEqual([]);
  });

  it('grants, audits as the system, and names the person and the role', async () => {
    const { audits, calls, bootstrap } = rig({ status: 'granted', userId: 'user-9' });
    expect(await bootstrap.handle({ email: ' First@Example.com ' }, system)).toEqual({ ok: true, value: { userId: 'user-9' } });
    expect(calls).toEqual(['first@example.com']);
    expect(audits).toEqual([{ principal: system.principal, action: 'FirstAdminGranted', targetContext: 'identity', targetType: 'UserRole', targetId: 'user-9:admin', correlationId: 'corr-1', occurredAt: NOW }]);
  });

  it.each([
    [{ status: 'not_found' }, 'NotFound', 'USER_NOT_FOUND'],
    [{ status: 'not_verified' }, 'RuleViolation', 'EMAIL_NOT_VERIFIED'],
    [{ status: 'admin_exists' }, 'RuleViolation', 'ADMIN_EXISTS'],
  ] as const)('answers %j with %s %s, and audits nothing', async (outcome, kind, code) => {
    const { audits, bootstrap } = rig(outcome);
    expect(await bootstrap.handle({ email: 'a@example.com' }, system)).toMatchObject({ ok: false, error: { kind, code } });
    expect(audits).toEqual([]);
  });

  it('refuses an address that is not one', async () => {
    const { calls, bootstrap } = rig();
    expect(await bootstrap.handle({ email: 7 }, system)).toMatchObject({ ok: false, error: { code: 'EMAIL_INVALID' } });
    expect(calls).toEqual([]);
  });
});
