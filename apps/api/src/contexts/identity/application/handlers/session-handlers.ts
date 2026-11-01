import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import { SESSION_LIFETIME_MS } from '../../domain/session-policy.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, CredentialStore, IdentifierFactory, SessionStore, TokenFactory } from '../ports.js';

/**
 * Ending and renewing sessions (M8-03). Revocation is effective: a revoked session is refused by the next request, because every request looks the session up
 * (`SessionAuthenticator`) and revocation is a column that lookup reads. There is no cache between them.
 */
const AUTHENTICATED = [ROLES.learner, ROLES.author, ROLES.reviewer, ROLES.contentOps, ROLES.curriculumCurator, ROLES.examOwner, ROLES.ops, ROLES.admin];
export const LOGOUT_POLICY = policy('Logout', AUTHENTICATED);
export const LOGOUT_ALL_POLICY = policy('LogoutAll', AUTHENTICATED);
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

  constructor(private readonly deps: { readonly credentials: CredentialStore; readonly clock: Clock; readonly audit: AuditRecorder }) {}

  async handle(_command: Record<string, never>, context: ApplicationContext): Promise<Result<{ readonly revoked: number }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const now = this.deps.clock.now();
    const revoked = await this.deps.credentials.revokeAll(context.principal.id, now, 'logout_all');
    await this.deps.audit.record({ principal: context.principal, action: 'AllSessionsRevoked', targetContext: 'identity', targetType: 'User', targetId: context.principal.id, correlationId: context.correlationId, occurredAt: now });
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
