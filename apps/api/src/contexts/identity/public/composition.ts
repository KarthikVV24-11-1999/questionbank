import type { DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { IdentityModule } from '../api/identity.module.js';
import type { PrincipalResolver } from '../api/identity.controller.js';
import { ChangePasswordHandler, LoginHandler, RegisterHandler, RequestPasswordRecoveryHandler, ResetPasswordHandler } from '../application/handlers/credential-handlers.js';
import { LogoutAllHandler, LogoutHandler, RotateSessionHandler } from '../application/handlers/session-handlers.js';
import { RequestEmailVerificationHandler, VerifyEmailHandler } from '../application/handlers/verification-handlers.js';
import type { AuditRecorder, Clock, IdentifierFactory, MailPort, PasswordHasher } from '../application/ports.js';
import { SessionAuthenticator } from '../application/session-authenticator.js';
import { DirectoryMail, MemoryMail, UnconfiguredMail } from '../infrastructure/mail-adapters.js';
import { ScryptPasswordHasher } from '../infrastructure/scrypt-password-hasher.js';
import { PostgresCredentialStore, PostgresOneTimeTokenStore, PostgresSessionStore, PostgresUserStore } from '../infrastructure/postgres-stores.js';
import { PostgresPrincipalResolver, SessionResolutions, sessionAuthentication, type AuthLogger } from '../infrastructure/session-principals.js';
import { CryptoTokenFactory } from '../infrastructure/token-factory.js';

/**
 * The identity context's only door for the composition root (DEC-M0-5): the principal resolver every other context is given, the middleware that fills it, and the routes.
 *
 * `identityPrincipals` is deliberately a separate call from `register`: the root builds the resolver first, hands it to every context, and only then composes the routes.
 */
export type { AuthLogger } from '../infrastructure/session-principals.js';
export type { MailMessage, MailPort } from '../application/ports.js';

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
  for (const key of ['pool', 'clock'] as const) {
    if (deps[key] === undefined) throw new Error(`identity composition is missing required dependency: ${key}`);
  }
  const resolutions = new SessionResolutions();
  const authenticator = new SessionAuthenticator({ sessions: new PostgresSessionStore(deps.pool), users: new PostgresUserStore(deps.pool), tokens: new CryptoTokenFactory(), clock: deps.clock });
  return { resolver: new PostgresPrincipalResolver(resolutions, deps.logger), middleware: sessionAuthentication(authenticator, resolutions) };
}

export interface IdentityCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly mail: MailPort;
  readonly principals: PrincipalResolver;
  /** The most live sessions a user may hold; the oldest is ended when a login exceeds it. */
  readonly maxSessionsPerUser: number;
  /** Absent in production: scrypt under today's parameters. A test passes a cheaper one. */
  readonly hasher?: PasswordHasher;
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
}

export function identityHandlers(deps: IdentityCompositionDeps): IdentityHandlers {
  for (const key of ['pool', 'clock', 'identifiers', 'audit', 'mail', 'maxSessionsPerUser'] as const) {
    if (deps[key] === undefined) throw new Error(`identity composition is missing required dependency: ${key}`);
  }
  if (!Number.isInteger(deps.maxSessionsPerUser) || deps.maxSessionsPerUser < 1) throw new Error('identity composition: maxSessionsPerUser must be a positive integer');
  const users = new PostgresUserStore(deps.pool);
  const sessions = new PostgresSessionStore(deps.pool);
  const oneTime = new PostgresOneTimeTokenStore(deps.pool);
  const credentials = new PostgresCredentialStore(deps.pool);
  const common = { users, hasher: deps.hasher ?? new ScryptPasswordHasher(), tokens: new CryptoTokenFactory(), clock: deps.clock, identifiers: deps.identifiers };
  return {
    register: new RegisterHandler({ ...common, oneTime, mail: deps.mail, audit: deps.audit }),
    login: new LoginHandler({ ...common, sessions, maxSessionsPerUser: deps.maxSessionsPerUser }),
    requestPasswordRecovery: new RequestPasswordRecoveryHandler({ ...common, oneTime, mail: deps.mail }),
    resetPassword: new ResetPasswordHandler({ ...common, credentials, audit: deps.audit }),
    changePassword: new ChangePasswordHandler({ ...common, sessions, credentials, audit: deps.audit }),
    verifyEmail: new VerifyEmailHandler({ oneTime, users, tokens: common.tokens, clock: deps.clock, audit: deps.audit }),
    requestEmailVerification: new RequestEmailVerificationHandler({ oneTime, users, mail: deps.mail, tokens: common.tokens, clock: deps.clock, identifiers: deps.identifiers }),
    logout: new LogoutHandler({ sessions, tokens: common.tokens, clock: deps.clock }),
    logoutAll: new LogoutAllHandler({ credentials, clock: deps.clock, audit: deps.audit }),
    rotateSession: new RotateSessionHandler({ sessions, tokens: common.tokens, clock: deps.clock, identifiers: deps.identifiers }),
  };
}

export function register(deps: IdentityCompositionDeps): DynamicModule {
  return IdentityModule.register({ handlers: identityHandlers(deps), principals: deps.principals });
}
