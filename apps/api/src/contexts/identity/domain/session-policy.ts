/**
 * How long a session lives, and how a session is judged (M8-03). Constants here, not configuration: each is a product decision that a deployment should not drift
 * on. The device limit is configuration (`MAX_SESSIONS_PER_USER`) because it is the one an operator tunes.
 */
export const SESSION_LIFETIME_MS = 30 * 24 * 3_600_000;
/** A session unused for this long is refused, though it has not expired. */
export const SESSION_IDLE_MS = 7 * 24 * 3_600_000;
/** `last_seen_at` is written at most this often, so a busy client does not turn every request into a write. */
export const SESSION_TOUCH_EVERY_MS = 60_000;

export interface SessionFacts {
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

export type SessionState = 'live' | 'revoked' | 'expired' | 'idle';

/** Revocation is judged first: a revoked session is refused at the next request, not at its next expiry. */
export function sessionState(session: SessionFacts, now: Date): SessionState {
  if (session.revokedAt !== null) return 'revoked';
  if (now.getTime() >= session.expiresAt.getTime()) return 'expired';
  if (now.getTime() - session.lastSeenAt.getTime() >= SESSION_IDLE_MS) return 'idle';
  return 'live';
}

/** What a one-time token is for, and how long it is good for. */
export const ONE_TIME_TOKEN_PURPOSES = ['email_verification', 'password_recovery'] as const;
export type OneTimeTokenPurpose = (typeof ONE_TIME_TOKEN_PURPOSES)[number];

export const ONE_TIME_TOKEN_TTL_MS: Readonly<Record<OneTimeTokenPurpose, number>> = Object.freeze({
  email_verification: 48 * 3_600_000,
  password_recovery: 3_600_000,
});

export interface OneTimeTokenFacts {
  readonly expiresAt: Date;
  readonly usedAt: Date | null;
  readonly supersededAt: Date | null;
}

export type OneTimeTokenState = 'open' | 'used' | 'superseded' | 'expired';

export function oneTimeTokenState(token: OneTimeTokenFacts, now: Date): OneTimeTokenState {
  if (token.usedAt !== null) return 'used';
  if (token.supersededAt !== null) return 'superseded';
  if (now.getTime() >= token.expiresAt.getTime()) return 'expired';
  return 'open';
}
