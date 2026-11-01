import type { PrincipalRef } from '@questionbank/domain-types';
import type { PasswordParameters, StoredCredential } from '../domain/password-hash.js';
import type { OneTimeTokenPurpose } from '../domain/session-policy.js';
import type { User } from '../domain/user.js';
import type { AuthorizationContext } from './authorization.js';

export interface ApplicationContext extends AuthorizationContext {
  readonly correlationId: string;
}

/** One row per consequential command (DATA-ARCHITECTURE P3). A login is not one: it is frequent and says nothing a session row does not. */
export interface AuditRecord {
  readonly principal: PrincipalRef;
  readonly action: string;
  readonly targetContext: 'identity';
  readonly targetType: string;
  readonly targetId: string;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface AuditRecorder {
  record(entry: AuditRecord): Promise<void>;
}

export interface Clock {
  now(): Date;
}

export interface IdentifierFactory {
  next(): string;
}

/** The password hash. Randomness and the memory-hard work are its; what the parameters mean is the domain's. */
export interface PasswordHasher {
  /** The parameters a new credential is made under: today's. */
  readonly parameters: PasswordParameters;
  hash(password: string): Promise<StoredCredential>;
  /** In constant time, under the parameters the credential carries. */
  verify(password: string, stored: StoredCredential): Promise<boolean>;
}

/** Opaque random tokens, and the one-way function they are stored under. */
export interface TokenFactory {
  /** 32 random bytes, base64url: shown once, to the person it was issued to. */
  newToken(): string;
  /** SHA-256 of the token. */
  hashToken(token: string): Uint8Array;
}

export interface UserWithCredential {
  readonly user: User;
  readonly credential: StoredCredential | null;
}

export interface UserStore {
  findByEmail(emailNormalized: string): Promise<UserWithCredential | null>;
  findById(userId: string): Promise<UserWithCredential | null>;
  /** `false` where the address is already taken, however the race went. */
  create(user: User, credential: StoredCredential): Promise<boolean>;
  markEmailVerified(userId: string, at: Date): Promise<void>;
  /** Rewrites a credential under newer parameters, after a successful login. The password has not changed. */
  rehash(userId: string, credential: StoredCredential, at: Date): Promise<void>;
}

export type SessionRevocation = 'logout' | 'logout_all' | 'rotated' | 'device_limit' | 'password_changed' | 'password_reset' | 'disabled';

export interface SessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  readonly tokenHash: Uint8Array;
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
  readonly rotatedFrom: string | null;
}

export interface NewSession {
  readonly sessionId: string;
  readonly userId: string;
  readonly tokenHash: Uint8Array;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly rotatedFrom: string | null;
}

export interface SessionStore {
  /** Stores the session, and revokes the user's oldest live ones until no more than `maxLive` are left (the new one counts), in one transaction. */
  insertWithinLimit(session: NewSession, maxLive: number): Promise<{ readonly revokedForLimit: number }>;
  findByTokenHash(tokenHash: Uint8Array): Promise<SessionRecord | null>;
  touch(sessionId: string, at: Date): Promise<void>;
  /** `true` if this call revoked it; a session already revoked is not revoked again. */
  revoke(sessionId: string, reason: SessionRevocation, at: Date): Promise<boolean>;
  /** Replaces a session with a new one, atomically: the old is revoked as `rotated` only if it was live. `false` if it was not. */
  rotate(oldSessionId: string, replacement: NewSession, at: Date): Promise<boolean>;
}

export interface OneTimeTokenStore {
  /** Stores a token for the user and purpose and supersedes every earlier one still open, in one transaction. */
  issue(token: { readonly tokenId: string; readonly userId: string; readonly purpose: OneTimeTokenPurpose; readonly tokenHash: Uint8Array; readonly createdAt: Date; readonly expiresAt: Date }): Promise<void>;
  /** Marks an open, unexpired token of that purpose used, once, and says whose it was; `null` for a token that is unknown, used, superseded or expired — all alike. */
  consume(tokenHash: Uint8Array, purpose: OneTimeTokenPurpose, at: Date): Promise<{ readonly userId: string } | null>;
}

/** Writes that change a credential and must take the user's sessions with them, atomically. */
export interface CredentialStore {
  /** Replaces the credential and revokes every session of the user but `exceptSessionId`, in one transaction. */
  replaceAndRevoke(change: { readonly userId: string; readonly credential: StoredCredential; readonly at: Date; readonly exceptSessionId: string | null; readonly reason: SessionRevocation }): Promise<{ readonly revoked: number }>;
  /** Consumes a recovery token, replaces the credential, and revokes every session of the user, in one transaction. `null` where the token does not hold. */
  resetWithToken(change: { readonly tokenHash: Uint8Array; readonly credential: StoredCredential; readonly at: Date }): Promise<{ readonly userId: string; readonly revoked: number } | null>;
  /** Every session of the user, revoked. */
  revokeAll(userId: string, at: Date, reason: SessionRevocation): Promise<number>;
}

export type MailPurpose = 'email_verification' | 'password_recovery' | 'already_registered';

export interface MailMessage {
  readonly to: string;
  readonly purpose: MailPurpose;
  readonly subject: string;
  /** For the first two it carries a secret token; an adapter delivers it and never logs it. */
  readonly body: string;
}

/** The seam to whatever sends mail. The provider is a later decision; see the context README for what an adapter has to satisfy. */
export interface MailPort {
  send(message: MailMessage): Promise<void>;
}

export interface IdentitySettings {
  readonly maxSessionsPerUser: number;
}
