import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../../platform/auth/roles.js';
import { SESSION_IDLE_MS, SESSION_LIFETIME_MS } from '../../domain/session-policy.js';
import type { ApplicationContext, SessionRecord, SessionStore, TokenFactory, UserStore } from '../ports.js';
import { SESSION_STATUS_POLICY, SessionStatusHandler } from './session-handlers.js';

const NOW = new Date('2026-11-04T09:00:00.000Z');
const tokens = { newToken: () => 'unused', hashToken: (token: string) => new TextEncoder().encode(token) } as TokenFactory;
const context: ApplicationContext = { principal: { kind: 'human', id: 'anyone', roleContext: [ROLES.guest] }, correlationId: 'c' };

function rig(session: Partial<SessionRecord> | null, over: { disabled?: boolean; missingUser?: boolean } = {}) {
  const record: SessionRecord | null = session === null ? null : { sessionId: 's1', userId: 'u1', tokenHash: new Uint8Array(), createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + SESSION_LIFETIME_MS), revokedAt: null, revokedReason: null, rotatedFrom: null, ...session };
  const sessions = { findByTokenHash: async () => record } as unknown as SessionStore;
  const users = { findById: async () => (over.missingUser === true ? null : { user: { userId: 'u1', disabledAt: over.disabled === true ? NOW : null }, credential: null }) } as unknown as UserStore;
  return new SessionStatusHandler({ sessions, users, tokens, clock: { now: () => NOW } });
}
const ask = (handler: SessionStatusHandler, token: unknown = 'tok') => handler.handle({ sessionToken: token }, context);

describe('whether a session is in force, and why not', () => {
  it('is open to someone with no session, because the question is asked before there is one', () => {
    expect(SESSION_STATUS_POLICY.allowedRoles).toEqual([ROLES.guest]);
  });

  it('says signed in for a live session of an enabled user', async () => {
    expect(await ask(rig({}))).toEqual({ ok: true, value: { signedIn: true, endedBy: null } });
  });

  it('says it was ended by another sign-in only for a session the device limit ended', async () => {
    expect(await ask(rig({ revokedAt: NOW, revokedReason: 'device_limit' }))).toEqual({ ok: true, value: { signedIn: false, endedBy: 'another_sign_in' } });
  });

  it('says nothing of why for any other end: a sign-out, a password change, a recovery, an unknown reason, and none given', async () => {
    for (const revokedReason of ['logout', 'password_change', 'password_reset', 'rotated', 'something_else', null]) {
      expect(await ask(rig({ revokedAt: NOW, revokedReason })), String(revokedReason)).toEqual({ ok: true, value: { signedIn: false, endedBy: null } });
    }
  });

  it('says not signed in, and nothing more, for a session past its life or idle too long, even one the limit had also ended', async () => {
    expect(await ask(rig({ expiresAt: NOW }))).toEqual({ ok: true, value: { signedIn: false, endedBy: null } });
    expect(await ask(rig({ lastSeenAt: new Date(NOW.getTime() - SESSION_IDLE_MS) }))).toEqual({ ok: true, value: { signedIn: false, endedBy: null } });
  });

  it('says not signed in for a user who has been disabled or is gone', async () => {
    expect(await ask(rig({}, { disabled: true }))).toEqual({ ok: true, value: { signedIn: false, endedBy: null } });
    expect(await ask(rig({}, { missingUser: true }))).toEqual({ ok: true, value: { signedIn: false, endedBy: null } });
  });

  it('answers a token that is nobody\'s, and no token, as it answers an ended session of any other kind', async () => {
    expect(await ask(rig(null))).toEqual({ ok: true, value: { signedIn: false, endedBy: null } });
    expect(await ask(rig({ revokedAt: NOW, revokedReason: 'device_limit' }), null)).toEqual({ ok: true, value: { signedIn: false, endedBy: null } });
  });

  it('refuses a caller who is not even a guest', async () => {
    const result = await rig({}).handle({ sessionToken: 'tok' }, { ...context, principal: { ...context.principal, roleContext: [] } });
    expect(result.ok).toBe(false);
  });
});
