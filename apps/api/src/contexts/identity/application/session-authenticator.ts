import type { PrincipalRef } from '@questionbank/domain-types';
import { isRole } from '../../../platform/auth/roles.js';
import { sessionState, SESSION_TOUCH_EVERY_MS } from '../domain/session-policy.js';
import type { Clock, SessionStore, TokenFactory, UserStore } from './ports.js';

/**
 * Who a bearer token is, from the database, on every request (M8-03). This is what ADR-0014 conceded the stub could not do: a revoked session, a disabled user and a
 * session past its life are refused at the very next request, because nothing sits between the request and the row.
 *
 * The answer is a `PrincipalRef` and nothing more, the same shape the stub produced, so no context's authorization changes. A refusal is a code and no more; what the person
 * on the other end is told is the same 401 whichever it was.
 */
export type AuthenticationRefusal = 'MISSING_HEADER' | 'MALFORMED_SCHEME' | 'EMPTY_TOKEN' | 'SESSION_UNKNOWN' | 'SESSION_REVOKED' | 'SESSION_EXPIRED' | 'SESSION_IDLE' | 'USER_DISABLED';

export type Authentication = { readonly ok: true; readonly principal: PrincipalRef } | { readonly ok: false; readonly code: AuthenticationRefusal };

const BEARER = 'Bearer ';

export class SessionAuthenticator {
  constructor(private readonly deps: { readonly sessions: SessionStore; readonly users: UserStore; readonly tokens: TokenFactory; readonly clock: Clock }) {}

  async authenticate(authorization: string | undefined): Promise<Authentication> {
    if (typeof authorization !== 'string') return { ok: false, code: 'MISSING_HEADER' };
    if (!authorization.startsWith(BEARER)) return { ok: false, code: 'MALFORMED_SCHEME' };
    const token = authorization.slice(BEARER.length);
    if (token.length === 0) return { ok: false, code: 'EMPTY_TOKEN' };

    const session = await this.deps.sessions.findByTokenHash(this.deps.tokens.hashToken(token));
    if (session === null) return { ok: false, code: 'SESSION_UNKNOWN' };
    const now = this.deps.clock.now();
    const state = sessionState(session, now);
    if (state === 'revoked') return { ok: false, code: 'SESSION_REVOKED' };
    if (state === 'expired') return { ok: false, code: 'SESSION_EXPIRED' };
    if (state === 'idle') return { ok: false, code: 'SESSION_IDLE' };

    const found = await this.deps.users.findById(session.userId);
    if (found === null || found.user.disabledAt !== null) return { ok: false, code: 'USER_DISABLED' };
    if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_TOUCH_EVERY_MS) await this.deps.sessions.touch(session.sessionId, now);
    // a role the application does not know is a role nothing authorizes: dropped here, so it fails closed
    const roles = Object.freeze(found.user.roles.filter(isRole));
    return { ok: true, principal: Object.freeze({ kind: 'human', id: found.user.userId, roleContext: roles }) };
  }
}
