import { ROLES } from '../../../../platform/auth/roles.js';
import { normalizeEmail } from '../../domain/email.js';
import { needsRehash, type StoredCredential } from '../../domain/password-hash.js';
import { err, ok, type Result } from '../../domain/result.js';
import { ONE_TIME_TOKEN_TTL_MS, SESSION_LIFETIME_MS } from '../../domain/session-policy.js';
import type { User } from '../../domain/user.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import { describeRefusal, type PasswordScreen } from '../password-screen.js';
import type {
  ApplicationContext,
  AuditRecord,
  Clock,
  CredentialStore,
  IdentifierFactory,
  MailMessage,
  MailPort,
  OneTimeTokenStore,
  PasswordHasher,
  SessionStore,
  TokenFactory,
  UserStore,
} from '../ports.js';

/**
 * The credential commands (M8-02, M8-03, M8-04): registering, logging in, changing a password, asking for recovery and resetting.
 *
 * **What a stranger can learn.** Registration and recovery answer the same whether or not the address is known, and a failed login answers the same whatever failed. It is not
 * enough that the bodies match: each path does the same *work*, so the time says no more than the body. A login for an unknown address still pays for a password hash,
 * against a credential made once at start-up; a registration for a known address still hashes the password it was given; a recovery for an unknown address still draws a
 * token and hashes it. Nothing here returns early on an address it does not know.
 *
 * **What is audited.** The row is handed to the store with the change it records, and written in the same transaction (M8-14): a change and its row land together or neither does.
 *
 * **What is never kept.** No password reaches a log, an error, an audit row or a response, and none is stored: a credential is a salted, parameterised hash.
 */
export const REGISTER_POLICY = policy('Register', [ROLES.guest]);
export const LOGIN_POLICY = policy('Login', [ROLES.guest]);
export const REQUEST_PASSWORD_RECOVERY_POLICY = policy('RequestPasswordRecovery', [ROLES.guest]);
export const RESET_PASSWORD_POLICY = policy('ResetPassword', [ROLES.guest]);
export const CHANGE_PASSWORD_POLICY = policy('ChangePassword', [ROLES.learner, ROLES.author, ROLES.reviewer, ROLES.contentOps, ROLES.curriculumCurator, ROLES.examOwner, ROLES.ops, ROLES.admin]);

/** What a failed login says, whatever failed. */
export const INVALID_CREDENTIALS = applicationError('Authentication', 'INVALID_CREDENTIALS', 'The email or password is not right.');
/** What a recovery or verification token that does not hold says, whether it was never issued, is used, was replaced or has expired. */
export const TOKEN_INVALID = applicationError('Validation', 'TOKEN_INVALID', 'That link is not valid any longer.');

const DEFAULT_ROLES: readonly string[] = [ROLES.learner];

interface Common {
  readonly users: UserStore;
  readonly hasher: PasswordHasher;
  readonly tokens: TokenFactory;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  /** Whether a password may be set: asked by every path that sets one, before it hashes or reads anything (M8-11). */
  readonly screen: PasswordScreen;
}

export class RegisterHandler {
  readonly name = 'Register';
  readonly policy = REGISTER_POLICY;

  constructor(private readonly deps: Common & { readonly oneTime: OneTimeTokenStore; readonly mail: MailPort; readonly mailFailed?: MailFailureReport; readonly publicUrl?: string | undefined }) {}

  /** Always answers `accepted`: a new address gets a verification message, a known one gets a message saying so, and the caller cannot tell which from here. */
  async handle(command: { readonly email: unknown; readonly password: unknown }, context: ApplicationContext): Promise<Result<{ readonly accepted: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const email = normalizeEmail(command.email);
    if (!email.ok) return err(applicationError('Validation', email.error, 'That is not an email address.'));
    const strength = await this.deps.screen.check(command.password, { action: 'register', correlationId: context.correlationId });
    if (!strength.ok) return err(applicationError('Validation', strength.error, describeRefusal(strength.error)));

    // paid for on both paths
    const credential = await this.deps.hasher.hash(strength.value);
    const now = this.deps.clock.now();
    const existing = await this.deps.users.findByEmail(email.value);
    const user: User = Object.freeze({
      userId: this.deps.identifiers.next(),
      email: email.value,
      emailNormalized: email.value,
      emailVerifiedAt: null,
      roles: DEFAULT_ROLES,
      disabledAt: null,
      createdAt: now,
    });
    // the audit row goes into the store with the user: written with it, or neither is
    const registered: AuditRecord = { principal: context.principal, action: 'UserRegistered', targetContext: 'identity', targetType: 'User', targetId: user.userId, correlationId: context.correlationId, occurredAt: now };
    const created = existing === null && (await this.deps.users.create(user, credential, registered));
    if (created) {
      await issueAndMail(this.deps, user, 'email_verification', now, { report: this.deps.mailFailed, correlationId: context.correlationId });
    } else {
      await sendQuietly(this.deps.mail, { to: email.value, purpose: 'already_registered', subject: 'You already have an account', body: 'Someone tried to register with this address. If it was you, log in or recover your password; if not, ignore this message.' }, { report: this.deps.mailFailed, correlationId: context.correlationId });
    }
    return ok({ accepted: true });
  }
}

export interface LoginResult {
  readonly sessionToken: string;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly userId: string;
  readonly emailVerified: boolean;
}

export class LoginHandler {
  readonly name = 'Login';
  readonly policy = LOGIN_POLICY;
  /** A credential nobody holds, made once, to verify against when there is nothing to verify: the work is the same. */
  #decoy: Promise<StoredCredential> | undefined;

  constructor(private readonly deps: Common & { readonly sessions: SessionStore; readonly maxSessionsPerUser: number }) {}

  async handle(command: { readonly email: unknown; readonly password: unknown }, context: ApplicationContext): Promise<Result<LoginResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    // anything that is not text cannot be a password, and cannot have been one this code made a hash of; it still costs what a wrong one costs
    const password = typeof command.password === 'string' && command.password.length <= 1024 ? command.password : '';
    const email = normalizeEmail(command.email);
    const found = email.ok ? await this.deps.users.findByEmail(email.value) : null;

    const real = found !== null && found.credential !== null && found.user.disabledAt === null;
    const stored = real ? found.credential! : await this.decoy();
    const matched = await this.deps.hasher.verify(password, stored);
    if (!real || !matched) return err(INVALID_CREDENTIALS);

    const { user } = found;
    const now = this.deps.clock.now();
    if (needsRehash(found.credential!.parameters, this.deps.hasher.parameters)) {
      await this.deps.users.rehash(user.userId, await this.deps.hasher.hash(password), now);
    }
    const sessionToken = this.deps.tokens.newToken();
    const sessionId = this.deps.identifiers.next();
    const expiresAt = new Date(now.getTime() + SESSION_LIFETIME_MS);
    await this.deps.sessions.insertWithinLimit(
      { sessionId, userId: user.userId, tokenHash: this.deps.tokens.hashToken(sessionToken), createdAt: now, expiresAt, rotatedFrom: null },
      this.deps.maxSessionsPerUser,
    );
    return ok({ sessionToken, sessionId, expiresAt: expiresAt.toISOString(), userId: user.userId, emailVerified: user.emailVerifiedAt !== null });
  }

  private decoy(): Promise<StoredCredential> {
    // A decoy that could not be made (the queue was full) is not kept: remembered, it would fail every unknown address after it.
    this.#decoy ??= this.deps.hasher.hash('a password that nobody has, made so that an unknown address costs what a known one does').catch((error: unknown) => {
      this.#decoy = undefined;
      throw error;
    });
    return this.#decoy;
  }
}

export class ChangePasswordHandler {
  readonly name = 'ChangePassword';
  readonly policy = CHANGE_PASSWORD_POLICY;

  constructor(private readonly deps: Common & { readonly sessions: SessionStore; readonly credentials: CredentialStore }) {}

  /** The current password is asked for again, a new one replaces it, and every other session of the user is revoked in the same transaction. The one in use stays. */
  async handle(
    command: { readonly sessionToken: unknown; readonly currentPassword: unknown; readonly newPassword: unknown },
    context: ApplicationContext,
  ): Promise<Result<{ readonly revokedOtherSessions: number }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const next = await this.deps.screen.check(command.newPassword, { action: 'password-change', correlationId: context.correlationId });
    if (!next.ok) return err(applicationError('Validation', next.error, describeRefusal(next.error)));
    const userId = context.principal.id;
    const found = await this.deps.users.findById(userId);
    if (found === null || found.credential === null || typeof command.currentPassword !== 'string') return err(applicationError('Authentication', 'CURRENT_PASSWORD_WRONG', 'The current password is not right.'));
    if (!(await this.deps.hasher.verify(command.currentPassword, found.credential))) return err(applicationError('Authentication', 'CURRENT_PASSWORD_WRONG', 'The current password is not right.'));

    const current = typeof command.sessionToken === 'string' ? await this.deps.sessions.findByTokenHash(this.deps.tokens.hashToken(command.sessionToken)) : null;
    const now = this.deps.clock.now();
    const changed = await this.deps.credentials.replaceAndRevoke({
      userId,
      credential: await this.deps.hasher.hash(next.value),
      at: now,
      exceptSessionId: current?.sessionId ?? null,
      reason: 'password_changed',
      audit: { principal: context.principal, action: 'PasswordChanged', targetContext: 'identity', targetType: 'User', targetId: userId, correlationId: context.correlationId, occurredAt: now },
    });
    return ok({ revokedOtherSessions: changed.revoked });
  }
}

export class RequestPasswordRecoveryHandler {
  readonly name = 'RequestPasswordRecovery';
  readonly policy = REQUEST_PASSWORD_RECOVERY_POLICY;

  constructor(private readonly deps: Common & { readonly oneTime: OneTimeTokenStore; readonly mail: MailPort; readonly mailFailed?: MailFailureReport; readonly publicUrl?: string | undefined }) {}

  /** Always answers `accepted`. A known address gets a single-use token that replaces any earlier one; an unknown one gets the same work and no message. */
  async handle(command: { readonly email: unknown }, context: ApplicationContext): Promise<Result<{ readonly accepted: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const email = normalizeEmail(command.email);
    const found = email.ok ? await this.deps.users.findByEmail(email.value) : null;
    const now = this.deps.clock.now();
    if (found !== null && found.user.disabledAt === null) {
      await issueAndMail(this.deps, found.user, 'password_recovery', now, { report: this.deps.mailFailed, correlationId: context.correlationId });
    } else {
      // the token that would have been drawn and hashed
      this.deps.tokens.hashToken(this.deps.tokens.newToken());
    }
    return ok({ accepted: true });
  }
}

export class ResetPasswordHandler {
  readonly name = 'ResetPassword';
  readonly policy = RESET_PASSWORD_POLICY;

  constructor(private readonly deps: Common & { readonly credentials: CredentialStore }) {}

  /** Spends a recovery token, sets the new password, and revokes every session of the user — someone who had the old password does not keep a login. */
  async handle(command: { readonly token: unknown; readonly newPassword: unknown }, context: ApplicationContext): Promise<Result<{ readonly done: true }, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const next = await this.deps.screen.check(command.newPassword, { action: 'reset', correlationId: context.correlationId });
    if (!next.ok) return err(applicationError('Validation', next.error, describeRefusal(next.error)));
    if (typeof command.token !== 'string' || command.token.length === 0 || command.token.length > 256) return err(TOKEN_INVALID);
    const now = this.deps.clock.now();
    const reset = await this.deps.credentials.resetWithToken({
      tokenHash: this.deps.tokens.hashToken(command.token),
      credential: await this.deps.hasher.hash(next.value),
      at: now,
      audit: (userId) => ({ principal: context.principal, action: 'PasswordReset', targetContext: 'identity', targetType: 'User', targetId: userId, correlationId: context.correlationId, occurredAt: now }),
    });
    if (reset === null) return err(TOKEN_INVALID);
    return ok({ done: true });
  }
}

/** Draws a token, stores its hash (replacing any open one), and mails the token itself: the one place it exists in the clear besides the recipient's inbox. */
/** Told when a message the caller must not learn about did not go: the purpose and the correlation id, never the address or the body. */
export type MailFailureReport = (failure: { readonly purpose: MailMessage['purpose']; readonly correlationId: string; readonly reason: string }) => void;

/**
 * Sends, and when `quiet` is given a failure is reported and swallowed. Registration and recovery answer the same whether or not an address is known, so a send that fails
 * for a known address and never happens for an unknown one would be an oracle: a 503 for the one and a 202 for the other. The account or the token is already stored, and
 * the person's way to a message is the resend route (DEC-M8-25).
 */
export async function sendQuietly(mail: MailPort, message: MailMessage, quiet?: { readonly report: MailFailureReport | undefined; readonly correlationId: string }): Promise<void> {
  if (quiet === undefined) return mail.send(message);
  try {
    await mail.send(message);
  } catch (cause) {
    quiet.report?.({ purpose: message.purpose, correlationId: quiet.correlationId, reason: cause instanceof Error ? cause.message.slice(0, 200) : 'unknown' });
  }
}

export async function issueAndMail(
  deps: { readonly oneTime: OneTimeTokenStore; readonly mail: MailPort; readonly tokens: TokenFactory; readonly identifiers: IdentifierFactory; readonly publicUrl?: string | undefined },
  user: User,
  purpose: 'email_verification' | 'password_recovery',
  now: Date,
  quiet?: { readonly report: MailFailureReport | undefined; readonly correlationId: string },
): Promise<void> {
  const token = deps.tokens.newToken();
  await deps.oneTime.issue({ tokenId: deps.identifiers.next(), userId: user.userId, purpose, tokenHash: deps.tokens.hashToken(token), createdAt: now, expiresAt: new Date(now.getTime() + ONE_TIME_TOKEN_TTL_MS[purpose]) });
  const verification = purpose === 'email_verification';
  // the link carries the code in the fragment, which a browser does not send to a server or to another site in a referrer
  const link = deps.publicUrl === undefined ? '' : ` Or open ${deps.publicUrl}/#${verification ? 'verify' : 'reset'}=${token}`;
  await sendQuietly(
    deps.mail,
    {
      to: user.email,
      purpose,
      subject: verification ? 'Confirm your email address' : 'Reset your password',
      body: verification
        ? `Your confirmation code is ${token}. It works once, for 48 hours.${link}`
        : `Your password reset code is ${token}. It works once, for one hour.${link} If you did not ask for it, ignore this message.`,
    },
    quiet,
  );
}
