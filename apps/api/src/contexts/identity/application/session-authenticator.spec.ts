import { describe, expect, it } from 'vitest';
import { SESSION_IDLE_MS, SESSION_LIFETIME_MS, SESSION_TOUCH_EVERY_MS } from '../domain/session-policy.js';
import type { SessionRecord, SessionStore, TokenFactory, UserStore, UserWithCredential } from './ports.js';
import { SessionAuthenticator } from './session-authenticator.js';

const NOW = new Date('2026-11-02T09:00:00.000Z');
const tokens: TokenFactory = { newToken: () => 'unused', hashToken: (token) => new TextEncoder().encode(token) };
const USER_ID = '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a';

function rig(options: { session?: Partial<SessionRecord> | null; roles?: string[]; disabled?: boolean; missingUser?: boolean; now?: Date } = {}) {
  const touched: Array<[string, Date]> = [];
  const session: SessionRecord | null =
    options.session === null
      ? null
      : { sessionId: 's1', userId: USER_ID, tokenHash: new Uint8Array(), createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + SESSION_LIFETIME_MS), revokedAt: null, rotatedFrom: null, ...options.session };
  const sessions = { findByTokenHash: async () => session, touch: async (id: string, at: Date) => void touched.push([id, at]) } as unknown as SessionStore;
  const found: UserWithCredential | null = options.missingUser
    ? null
    : { user: { userId: USER_ID, email: 'a@b.co', emailNormalized: 'a@b.co', emailVerifiedAt: null, roles: options.roles ?? ['learner'], disabledAt: options.disabled === true ? NOW : null, createdAt: NOW }, credential: null };
  const users = { findById: async () => found } as unknown as UserStore;
  return { touched, authenticator: new SessionAuthenticator({ sessions, users, tokens, clock: { now: () => options.now ?? NOW } }) };
}

describe('roles after the session was made (M8-12)', () => {
  it('are the ones the user holds now, read at every request: a role given or taken away is in force at the next one, on the same session', async () => {
    let roles = ['learner'];
    const session: SessionRecord = { sessionId: 's1', userId: USER_ID, tokenHash: new Uint8Array(), createdAt: NOW, lastSeenAt: NOW, expiresAt: new Date(NOW.getTime() + SESSION_LIFETIME_MS), revokedAt: null, rotatedFrom: null };
    const sessions = { findByTokenHash: async () => session, touch: async () => undefined } as unknown as SessionStore;
    const users = { findById: async () => ({ user: { userId: USER_ID, email: 'a@b.co', emailNormalized: 'a@b.co', emailVerifiedAt: null, roles, disabledAt: null, createdAt: NOW }, credential: null }) } as unknown as UserStore;
    const authenticator = new SessionAuthenticator({ sessions, users, tokens, clock: { now: () => NOW } });
    const rolesNow = async () => {
      const answer = await authenticator.authenticate('Bearer abc');
      if (!answer.ok) throw new Error(answer.code);
      return answer.principal.roleContext;
    };
    expect(await rolesNow()).toEqual(['learner']);
    roles = ['learner', 'admin'];
    expect(await rolesNow()).toEqual(['learner', 'admin']);
    roles = ['learner'];
    expect(await rolesNow()).toEqual(['learner']);
  });
});

describe('authenticating a bearer token against the session table', () => {
  it('names why a header is refused before it looks anything up', async () => {
    const { authenticator } = rig();
    expect(await authenticator.authenticate(undefined)).toEqual({ ok: false, code: 'MISSING_HEADER' });
    expect(await authenticator.authenticate('Basic abc')).toEqual({ ok: false, code: 'MALFORMED_SCHEME' });
    expect(await authenticator.authenticate('Bearer ')).toEqual({ ok: false, code: 'EMPTY_TOKEN' });
  });

  it('names why a session is refused: unknown, revoked, expired, idle, or its user disabled or gone', async () => {
    const header = 'Bearer abc';
    expect(await rig({ session: null }).authenticator.authenticate(header)).toEqual({ ok: false, code: 'SESSION_UNKNOWN' });
    expect(await rig({ session: { revokedAt: NOW } }).authenticator.authenticate(header)).toEqual({ ok: false, code: 'SESSION_REVOKED' });
    expect(await rig({ now: new Date(NOW.getTime() + SESSION_LIFETIME_MS) }).authenticator.authenticate(header)).toEqual({ ok: false, code: 'SESSION_EXPIRED' });
    expect(await rig({ now: new Date(NOW.getTime() + SESSION_IDLE_MS) }).authenticator.authenticate(header)).toEqual({ ok: false, code: 'SESSION_IDLE' });
    expect(await rig({ disabled: true }).authenticator.authenticate(header)).toEqual({ ok: false, code: 'USER_DISABLED' });
    expect(await rig({ missingUser: true }).authenticator.authenticate(header)).toEqual({ ok: false, code: 'USER_DISABLED' });
  });

  it('returns a principal of exactly the shared kernel\'s shape: kind, id and roles', async () => {
    const answer = await rig({ roles: ['learner', 'admin'] }).authenticator.authenticate('Bearer abc');
    expect(answer).toEqual({ ok: true, principal: { kind: 'human', id: USER_ID, roleContext: ['learner', 'admin'] } });
    expect(Object.keys((answer as { principal: object }).principal).sort()).toEqual(['id', 'kind', 'roleContext']);
  });

  it('drops a role the application does not know, so it fails closed', async () => {
    const answer = await rig({ roles: ['learner', 'superuser', 'ADMIN'] }).authenticator.authenticate('Bearer abc');
    expect(answer).toMatchObject({ ok: true, principal: { roleContext: ['learner'] } });
  });

  it('records use at most once a minute, so a busy client is not a write a request', async () => {
    const soon = rig({ now: new Date(NOW.getTime() + SESSION_TOUCH_EVERY_MS - 1) });
    await soon.authenticator.authenticate('Bearer abc');
    expect(soon.touched).toEqual([]);
    const later = rig({ now: new Date(NOW.getTime() + SESSION_TOUCH_EVERY_MS) });
    await later.authenticator.authenticate('Bearer abc');
    expect(later.touched).toEqual([['s1', new Date(NOW.getTime() + SESSION_TOUCH_EVERY_MS)]]);
  });
});
