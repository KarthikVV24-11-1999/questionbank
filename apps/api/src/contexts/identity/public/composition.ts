import type { DynamicModule } from '@nestjs/common';
import { ROLES } from '../../../platform/auth/roles.js';
import type { Pool } from 'pg';
import { Admission, type IdentityRouteLimits, type RefusalLog } from '../api/admission.js';
import { IdentityModule } from '../api/identity.module.js';
import type { PrincipalResolver } from '../api/identity.controller.js';
import { ChangePasswordHandler, LoginHandler, RegisterHandler, RequestPasswordRecoveryHandler, ResetPasswordHandler } from '../application/handlers/credential-handlers.js';
import { AssignRoleHandler, BootstrapFirstAdminHandler, RemoveRoleHandler } from '../application/handlers/role-handlers.js';
import { LogoutAllHandler, LogoutHandler, RotateSessionHandler } from '../application/handlers/session-handlers.js';
import { RequestEmailVerificationHandler, VerifyEmailHandler } from '../application/handlers/verification-handlers.js';
import type { TransactionalAudit, BoundedRunner, BreachedPasswords, Clock, IdentifierFactory, MailPort, PasswordHasher, RateLimiter } from '../application/ports.js';
import { PasswordScreen } from '../application/password-screen.js';
import { SessionAuthenticator } from '../application/session-authenticator.js';
import { DirectoryMail, MemoryMail, UnconfiguredMail } from '../infrastructure/mail-adapters.js';
import { BundledPasswordList } from '../infrastructure/bundled-password-list.js';
import { BoundedPasswordHasher } from '../infrastructure/bounded-password-hasher.js';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher.js';
import { PostgresCredentialStore, PostgresOneTimeTokenStore, PostgresRoleStore, PostgresSessionStore, PostgresUserStore } from '../infrastructure/postgres-stores.js';
import { PostgresPrincipalResolver, SessionResolutions, sessionAuthentication, type AuthLogger } from '../infrastructure/session-principals.js';
import { CryptoTokenFactory } from '../infrastructure/token-factory.js';

/**
 * The identity context's only door for the composition root (DEC-M0-5): the principal resolver every other context is given, the middleware that fills it, and the routes.
 *
 * `identityPrincipals` is deliberately a separate call from `register`: the root builds the resolver first, hands it to every context, and only then composes the routes.
 */
export type { AuthLogger } from '../infrastructure/session-principals.js';
export type { BoundedRunner, BreachedPasswords, BreachVerdict, MailMessage, MailPort, PasswordHasher, RateLimiter, RouteLimits } from '../application/ports.js';
export type { IdentityRouteLimits, RefusalLog } from '../api/admission.js';

/**
 * The mail adapter for an environment (M8-04), when none is supplied. Development writes a file a message; a test keeps them; anything else gets an adapter that fails the
 * send, because the provider is a later decision and a message carries a secret that must not be written to a disk by default.
 */
export function defaultMail(environment: { readonly nodeEnv: 'development' | 'test' | 'production'; readonly directory: string; readonly now: () => Date }): MailPort {
  if (environment.nodeEnv === 'development') return new DirectoryMail(environment.directory, environment.now);
  return environment.nodeEnv === 'test' ? new MemoryMail() : new UnconfiguredMail();
}

export interface IdentityPrincipalsDeps {
  readonly pool: Pool;
  readonly audit: TransactionalAudit;
  readonly clock: Clock;
  readonly logger?: AuthLogger;
}

export interface IdentityPrincipals {
  /** The port every context takes, answered from the session table. */
  readonly resolver: PrincipalResolver;
  /** To be installed before any controller; it authenticates the request's token and records the answer for `resolver`. */
  readonly middleware: ReturnType<typeof sessionAuthentication>;
}

export function identityPrincipals(deps: IdentityPrincipalsDeps): IdentityPrincipals {
  for (const key of ['pool', 'clock', 'audit'] as const) {
    if (deps[key] === undefined) throw new Error(`identity composition is missing required dependency: ${key}`);
  }
  const resolutions = new SessionResolutions();
  const authenticator = new SessionAuthenticator({ sessions: new PostgresSessionStore(deps.pool), users: new PostgresUserStore(deps.pool, deps.audit), tokens: new CryptoTokenFactory(), clock: deps.clock });
  return { resolver: new PostgresPrincipalResolver(resolutions, deps.logger), middleware: sessionAuthentication(authenticator, resolutions) };
}

export interface IdentityCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: TransactionalAudit;
  readonly mail: MailPort;
  readonly principals: PrincipalResolver;
  /** The most live sessions a user may hold; the oldest is ended when a login exceeds it. */
  readonly maxSessionsPerUser: number;
  /** Absent in production: scrypt under today's parameters. A test passes a cheaper one. */
  readonly hasher?: PasswordHasher;
  /** Where the authentication routes' counters live (M8-06); the Postgres adapter in production, so the limit is the same across instances. */
  readonly limiter: RateLimiter;
  readonly limits: IdentityRouteLimits;
  /** What takes turns at the derives (M8-08), applied to whatever hasher is in use, so no route escapes it. */
  readonly hashBound: BoundedRunner;
  readonly refusals?: RefusalLog;
  /** Where a password is looked up before it is accepted (M8-11). Absent: the list that ships with the code. A test passes one that fails. */
  readonly breached?: BreachedPasswords;
}

export interface IdentityHandlers {
  readonly register: RegisterHandler;
  readonly login: LoginHandler;
  readonly requestPasswordRecovery: RequestPasswordRecoveryHandler;
  readonly resetPassword: ResetPasswordHandler;
  readonly changePassword: ChangePasswordHandler;
  readonly verifyEmail: VerifyEmailHandler;
  readonly requestEmailVerification: RequestEmailVerificationHandler;
  readonly logout: LogoutHandler;
  readonly logoutAll: LogoutAllHandler;
  readonly rotateSession: RotateSessionHandler;
  readonly assignRole: AssignRoleHandler;
  readonly removeRole: RemoveRoleHandler;
}

export function identityHandlers(deps: IdentityCompositionDeps): IdentityHandlers {
  for (const key of ['pool', 'clock', 'identifiers', 'audit', 'mail', 'maxSessionsPerUser', 'limiter', 'limits', 'hashBound'] as const) {
    if (deps[key] === undefined) throw new Error(`identity composition is missing required dependency: ${key}`);
  }
  if (!Number.isInteger(deps.maxSessionsPerUser) || deps.maxSessionsPerUser < 1) throw new Error('identity composition: maxSessionsPerUser must be a positive integer');
  const users = new PostgresUserStore(deps.pool, deps.audit);
  const sessions = new PostgresSessionStore(deps.pool);
  const oneTime = new PostgresOneTimeTokenStore(deps.pool, deps.audit);
  const credentials = new PostgresCredentialStore(deps.pool, deps.audit);
  const screen = new PasswordScreen({
    source: deps.breached ?? new BundledPasswordList(),
    log: {
      unavailable: ({ action, correlationId, reason }) =>
        deps.refusals?.log({ level: 'warn', message: 'password not checked against known passwords', correlationId, context: 'identity.password', attributes: { errorCode: 'BREACH_CHECK_UNAVAILABLE', reason, route: action } }),
    },
  });
  const common = { users, hasher: new BoundedPasswordHasher(deps.hasher ?? new ScryptPasswordHasher(), deps.hashBound), tokens: new CryptoTokenFactory(), clock: deps.clock, identifiers: deps.identifiers, screen };
  return {
    register: new RegisterHandler({ ...common, oneTime, mail: deps.mail }),
    login: new LoginHandler({ ...common, sessions, maxSessionsPerUser: deps.maxSessionsPerUser }),
    requestPasswordRecovery: new RequestPasswordRecoveryHandler({ ...common, oneTime, mail: deps.mail }),
    resetPassword: new ResetPasswordHandler({ ...common, credentials }),
    changePassword: new ChangePasswordHandler({ ...common, sessions, credentials }),
    verifyEmail: new VerifyEmailHandler({ oneTime, users, tokens: common.tokens, clock: deps.clock }),
    requestEmailVerification: new RequestEmailVerificationHandler({ oneTime, users, mail: deps.mail, tokens: common.tokens, clock: deps.clock, identifiers: deps.identifiers }),
    logout: new LogoutHandler({ sessions, tokens: common.tokens, clock: deps.clock }),
    logoutAll: new LogoutAllHandler({ credentials, clock: deps.clock }),
    rotateSession: new RotateSessionHandler({ sessions, tokens: common.tokens, clock: deps.clock, identifiers: deps.identifiers }),
    assignRole: new AssignRoleHandler({ roles: new PostgresRoleStore(deps.pool, deps.audit), clock: deps.clock }),
    removeRole: new RemoveRoleHandler({ roles: new PostgresRoleStore(deps.pool, deps.audit), clock: deps.clock }),
  };
}

export function register(deps: IdentityCompositionDeps): DynamicModule {
  return IdentityModule.register({ handlers: identityHandlers(deps), principals: deps.principals, admission: new Admission(deps.limiter, deps.limits, deps.refusals) });
}

/** Who the first-administrator command acts as: the system, with an id that is nobody's. */
const BOOTSTRAP_PRINCIPAL = Object.freeze({ kind: 'system' as const, id: '00000000-0000-4000-8000-0000000000b1', roleContext: Object.freeze([ROLES.system]) });

/**
 * Makes the first administrator (M8-12), for an operator with access to the database; `bootstrap-admin.ts` is the command line around it. Nothing in the application's routes calls it.
 * The result says what happened in the words of the handler's refusals, so the command can print them.
 */
export async function bootstrapFirstAdmin(deps: Pick<IdentityCompositionDeps, 'pool' | 'clock' | 'audit'>, email: string, correlationId: string) {
  return new BootstrapFirstAdminHandler({ roles: new PostgresRoleStore(deps.pool, deps.audit), clock: deps.clock }).handle({ email }, { principal: BOOTSTRAP_PRINCIPAL, correlationId });
}
