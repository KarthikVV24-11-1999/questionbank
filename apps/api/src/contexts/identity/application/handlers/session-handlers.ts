import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import { SESSION_LIFETIME_MS, sessionState } from '../../domain/session-policy.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, Clock, CredentialStore, IdentifierFactory, SessionStore, TokenFactory, UserStore } from '../ports.js';

/**
 * Ending and renewing sessions (M8-03). Revocation is effective: a revoked session is refused by the next request, because every request looks the session up
 * (`SessionAuthenticator`) and revocation is a column that lookup reads. There is no cache between them.
 */
const AUTHENTICATED = [ROLES.learner, ROLES.author, ROLES.reviewer, ROLES.contentOps, ROLES.curriculumCurator, ROLES.examOwner, ROLES.ops, ROLES.admin];
export const LOGOUT_POLICY = policy('Logout', AUTHENTICATED);
export const LOGOUT_ALL_POLICY = policy('LogoutAll', AUTHENTICATED);
export const SESSION_STATUS_POLICY = policy('SessionStatus', [ROLES.guest]);
export const ROTATE_SESSION_POLICY = policy('RotateSession', AUTHENTICATED);

interface Deps {
  readonly sessions: SessionStore;
  readonly tokens: TokenFactory;
  readonly clock: Clock;
}

export class LogoutHandler {
  readonly name = 'Logout';
  readonly policy = LOGOUT_POLICY;

  constructor(private readonly deps: Deps) {}

  /** Ends the session the request came in on. A token that is not the caller's own is not found, which is what a token that is not anyone's is too. */
  async handle(command: { readonly sessionToken: unknown }, context: ApplicationContext): Promise<Result<{ readonly done: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const session = typeof command.sessionToken === 'string' ? await this.deps.sessions.findByTokenHash(this.deps.tokens.hashToken(command.sessionToken)) : null;
    if (session === null || session.userId !== context.principal.id) return err(applicationError('NotFound', 'SESSION_NOT_FOUND', 'There is no such session.'));
    await this.deps.sessions.revoke(session.sessionId, 'logout', this.deps.clock.now());
    return ok({ done: true });
  }
}

export class LogoutAllHandler {
  readonly name = 'LogoutAll';
  readonly policy = LOGOUT_ALL_POLICY;

  constructor(private readonly deps: { readonly credentials: CredentialStore; readonly clock: Clock }) {}

  async handle(_command: Record<string, never>, context: ApplicationContext): Promise<Result<{ readonly revoked: number }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const now = this.deps.clock.now();
    const revoked = await this.deps.credentials.revokeAll(context.principal.id, now, 'logout_all', {
      principal: context.principal,
      action: 'AllSessionsRevoked',
      targetContext: 'identity',
      targetType: 'User',
      targetId: context.principal.id,
      correlationId: context.correlationId,
      occurredAt: now,
    });
    return ok({ revoked });
  }
}

export class RotateSessionHandler {
  readonly name = 'RotateSession';
  readonly policy = ROTATE_SESSION_POLICY;

  constructor(private readonly deps: Deps & { readonly identifiers: IdentifierFactory }) {}

  /** Swaps the token for a new one and ends the old, together. The new session keeps the old one's age limit off: it is a fresh lifetime, so a client that rotates stays in. */
  async handle(
    command: { readonly sessionToken: unknown },
    context: ApplicationContext,
  ): Promise<Result<{ readonly sessionToken: string; readonly sessionId: string; readonly expiresAt: string }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const old = typeof command.sessionToken === 'string' ? await this.deps.sessions.findByTokenHash(this.deps.tokens.hashToken(command.sessionToken)) : null;
    if (old === null || old.userId !== context.principal.id) return err(applicationError('NotFound', 'SESSION_NOT_FOUND', 'There is no such session.'));
    const now = this.deps.clock.now();
    const sessionToken = this.deps.tokens.newToken();
    const sessionId = this.deps.identifiers.next();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    const rotated = await this.deps.sessions.rotate(old.sessionId, { sessionId, userId: old.userId, tokenHash: this.deps.tokens.hashToken(sessionToken), createdAt: now, expiresAt, rotatedFrom: old.sessionId }, now);
    if (!rotated) return err(applicationError('NotFound', 'SESSION_NOT_FOUND', 'There is no such session.'));
    return ok({ sessionToken, sessionId, expiresAt: expiresAt.toISOString() });
  }
}

/** Why a session is not in force, in terms a person can be told: only the one reason there is a sentence for. */
export type SessionEnd = 'another_sign_in';

export interface SessionStatus {
  readonly signedIn: boolean;
  /** Set when the session was ended by a sign-in that put the person over the device limit (D122); `null` for every other reason, and when there was no session. */
  readonly endedBy: SessionEnd | null;
}

export class SessionStatusHandler {
  readonly name = 'SessionStatus';
  readonly policy = SESSION_STATUS_POLICY;

  constructor(private readonly deps: { readonly sessions: SessionStore; readonly users: UserStore; readonly tokens: TokenFactory; readonly clock: Clock }) {}

  /**
   * Whether the token the request carries is a session in force, and if it was ended by a later sign-in, that. It answers 200 either way, so a page asking on every load is not a
   * stream of 401s, and it says no more to someone holding a token than that token's own session would. A token that is nobody's is the same answer as one that has ended for any other
   * reason, so it cannot be used to find out which tokens exist.
   */
  async handle(command: { readonly sessionToken: unknown }, context: ApplicationContext): Promise<Result<SessionStatus, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const session = typeof command.sessionToken === 'string' ? await this.deps.sessions.findByTokenHash(this.deps.tokens.hashToken(command.sessionToken)) : null;
    if (session === null) return ok({ signedIn: false, endedBy: null });
    if (sessionState(session, this.deps.clock.now()) === 'live') {
      const found = await this.deps.users.findById(session.userId);
      return ok({ signedIn: found !== null && found.user.disabledAt === null, endedBy: null });
    }
    return ok({ signedIn: false, endedBy: session.revokedReason === 'device_limit' ? 'another_sign_in' : null });
  }
}

