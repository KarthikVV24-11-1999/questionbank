import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory, MailPort, OneTimeTokenStore, TokenFactory, UserStore } from '../ports.js';
import { TOKEN_INVALID, issueAndMail } from './credential-handlers.js';

/** Email verification (M8-04): a single-use, time-boxed token, hashed at rest, replaced by a second issue. */
export const VERIFY_EMAIL_POLICY = policy('VerifyEmail', [ROLES.guest]);
export const REQUEST_EMAIL_VERIFICATION_POLICY = policy('RequestEmailVerification', [ROLES.learner, ROLES.author, ROLES.reviewer, ROLES.contentOps, ROLES.curriculumCurator, ROLES.examOwner, ROLES.ops, ROLES.admin]);

export class VerifyEmailHandler {
  readonly name = 'VerifyEmail';
  readonly policy = VERIFY_EMAIL_POLICY;

  constructor(private readonly deps: { readonly oneTime: OneTimeTokenStore; readonly users: UserStore; readonly tokens: TokenFactory; readonly clock: Clock; readonly audit: AuditRecorder }) {}

  async handle(command: { readonly token: unknown }, context: ApplicationContext): Promise<Result<{ readonly verified: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    if (typeof command.token !== 'string' || command.token.length === 0 || command.token.length > 256) return err(TOKEN_INVALID);
    const now = this.deps.clock.now();
    const spent = await this.deps.oneTime.consume(this.deps.tokens.hashToken(command.token), 'email_verification', now);
    if (spent === null) return err(TOKEN_INVALID);
    await this.deps.users.markEmailVerified(spent.userId, now);
    await this.deps.audit.record({ principal: context.principal, action: 'EmailVerified', targetContext: 'identity', targetType: 'User', targetId: spent.userId, correlationId: context.correlationId, occurredAt: now });
    return ok({ verified: true });
  }
}

export class RequestEmailVerificationHandler {
  readonly name = 'RequestEmailVerification';
  readonly policy = REQUEST_EMAIL_VERIFICATION_POLICY;

  constructor(private readonly deps: { readonly oneTime: OneTimeTokenStore; readonly users: UserStore; readonly mail: MailPort; readonly tokens: TokenFactory; readonly clock: Clock; readonly identifiers: IdentifierFactory }) {}

  /** A new code for the caller's own address, replacing the one before it. Already verified is not an error and sends nothing. */
  async handle(_command: Record<string, never>, context: ApplicationContext): Promise<Result<{ readonly accepted: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const found = await this.deps.users.findById(context.principal.id);
    if (found === null) return err(applicationError('NotFound', 'USER_NOT_FOUND', 'There is no such user.'));
    if (found.user.emailVerifiedAt === null) await issueAndMail(this.deps, found.user, 'email_verification', this.deps.clock.now());
    return ok({ accepted: true });
  }
}
