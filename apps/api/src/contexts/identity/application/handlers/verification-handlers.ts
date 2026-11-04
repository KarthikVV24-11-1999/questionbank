import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, Clock, IdentifierFactory, MailPort, OneTimeTokenStore, TokenFactory, UserStore } from '../ports.js';
import { TOKEN_INVALID, issueAndMail } from './credential-handlers.js';

/** Email verification (M8-04): a single-use, time-boxed token, hashed at rest, replaced by a second issue. */
export const VERIFY_EMAIL_POLICY = policy('VerifyEmail', [ROLES.guest]);
export const REQUEST_EMAIL_VERIFICATION_POLICY = policy('RequestEmailVerification', [ROLES.learner, ROLES.author, ROLES.reviewer, ROLES.contentOps, ROLES.curriculumCurator, ROLES.examOwner, ROLES.ops, ROLES.admin]);

/** What asking for a new message says when the provider would not take it. */
export const MAIL_UNAVAILABLE = applicationError('Unavailable', 'MAIL_UNAVAILABLE', 'The message could not be sent just now. Try again shortly.');

export class VerifyEmailHandler {
  readonly name = 'VerifyEmail';
  readonly policy = VERIFY_EMAIL_POLICY;

  constructor(private readonly deps: { readonly oneTime: OneTimeTokenStore; readonly users: UserStore; readonly tokens: TokenFactory; readonly clock: Clock }) {}

  async handle(command: { readonly token: unknown }, context: ApplicationContext): Promise<Result<{ readonly verified: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    if (typeof command.token !== 'string' || command.token.length === 0 || command.token.length > 256) return err(TOKEN_INVALID);
    const now = this.deps.clock.now();
    // the code is spent, the address marked and the row written together: a code can no longer be lost to a crash between them
    const spent = await this.deps.oneTime.verifyEmail(this.deps.tokens.hashToken(command.token), now, (userId) => ({ principal: context.principal, action: 'EmailVerified', targetContext: 'identity', targetType: 'User', targetId: userId, correlationId: context.correlationId, occurredAt: now }));
    if (spent === null) return err(TOKEN_INVALID);
    return ok({ verified: true });
  }
}

export class RequestEmailVerificationHandler {
  readonly name = 'RequestEmailVerification';
  readonly policy = REQUEST_EMAIL_VERIFICATION_POLICY;

  constructor(private readonly deps: { readonly oneTime: OneTimeTokenStore; readonly users: UserStore; readonly mail: MailPort; readonly tokens: TokenFactory; readonly clock: Clock; readonly identifiers: IdentifierFactory; readonly publicUrl?: string | undefined }) {}

  /** A new code for the caller's own address, replacing the one before it. Already verified is not an error and sends nothing. */
  async handle(_command: Record<string, never>, context: ApplicationContext): Promise<Result<{ readonly accepted: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const found = await this.deps.users.findById(context.principal.id);
    if (found === null) return err(applicationError('NotFound', 'USER_NOT_FOUND', 'There is no such user.'));
    if (found.user.emailVerifiedAt === null) {
      try {
        await issueAndMail(this.deps, found.user, 'email_verification', this.deps.clock.now());
      } catch {
        // the caller is signed in and the address is their own, so there is nothing to hide: say it did not go, and that asking again is the answer (DEC-M8-25)
        return err(MAIL_UNAVAILABLE);
      }
    }
    return ok({ accepted: true });
  }
}
