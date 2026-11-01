import { describe, expect, it } from 'vitest';
import { normalizeEmail } from './email.js';
import { CURRENT_PASSWORD_PARAMETERS, needsRehash } from './password-hash.js';
import { MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, checkPassword } from './password-policy.js';
import { ONE_TIME_TOKEN_TTL_MS, oneTimeTokenState, sessionState, SESSION_IDLE_MS, SESSION_LIFETIME_MS, SESSION_TOUCH_EVERY_MS } from './session-policy.js';

describe('an email address', () => {
  it('is trimmed and lower-cased, so one person has one key', () => {
    expect(normalizeEmail('  Asha.Verma@Example.COM ')).toEqual({ ok: true, value: 'asha.verma@example.com' });
  });

  it('is refused when it is not text, has no domain, has a space inside, or is longer than an address can be', () => {
    for (const bad of [undefined, 42, '', 'plain', 'a@b', 'a b@c.d', '@c.d', `${'a'.repeat(250)}@x.io`]) expect(normalizeEmail(bad), String(bad)).toEqual({ ok: false, error: 'EMAIL_INVALID' });
  });
});

describe('a password', () => {
  it('needs twelve characters and no more than 256, counted as people type them', () => {
    expect(checkPassword('x'.repeat(MIN_PASSWORD_LENGTH - 1))).toEqual({ ok: false, error: 'PASSWORD_TOO_SHORT' });
    expect(checkPassword('x'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
    expect(checkPassword('x'.repeat(MAX_PASSWORD_LENGTH)).ok).toBe(true);
    expect(checkPassword('x'.repeat(MAX_PASSWORD_LENGTH + 1))).toEqual({ ok: false, error: 'PASSWORD_TOO_LONG' });
    expect(checkPassword('🔑'.repeat(MIN_PASSWORD_LENGTH)).ok).toBe(true);
    expect(checkPassword('🔑'.repeat(MIN_PASSWORD_LENGTH - 1)).ok).toBe(false);
  });

  it('must be text', () => {
    for (const bad of [undefined, null, 123456789012, ['a'.repeat(20)]]) expect(checkPassword(bad)).toEqual({ ok: false, error: 'PASSWORD_NOT_TEXT' });
  });
});

describe('the parameters a password is hashed under', () => {
  it('are scrypt at N=2^16, r=8, p=1 with a 32-byte key: about 64 MB a hash, and not 2^17', () => {
    expect(CURRENT_PASSWORD_PARAMETERS).toEqual({ algorithm: 'scrypt', n: 65_536, r: 8, p: 1, keyLength: 32 });
    expect(128 * CURRENT_PASSWORD_PARAMETERS.n * CURRENT_PASSWORD_PARAMETERS.r).toBe(64 * 1024 * 1024);
  });

  it('say a credential needs rehashing when any one of them is not today\'s, and not otherwise', () => {
    expect(needsRehash(CURRENT_PASSWORD_PARAMETERS)).toBe(false);
    for (const change of [{ n: 16_384 }, { r: 4 }, { p: 2 }, { keyLength: 64 }]) expect(needsRehash({ ...CURRENT_PASSWORD_PARAMETERS, ...change }), JSON.stringify(change)).toBe(true);
  });
});

describe('how long things last', () => {
  it('is thirty days for a session, a week idle, a minute between records of use, two days for a verification code and an hour for a recovery code', () => {
    const hour = 3_600_000;
    expect([SESSION_LIFETIME_MS, SESSION_IDLE_MS, SESSION_TOUCH_EVERY_MS]).toEqual([30 * 24 * hour, 7 * 24 * hour, 60_000]);
    expect(ONE_TIME_TOKEN_TTL_MS).toEqual({ email_verification: 48 * hour, password_recovery: hour });
  });
});

describe('judging a session', () => {
  const at = new Date('2026-11-02T09:00:00.000Z');
  const fresh = { createdAt: at, lastSeenAt: at, expiresAt: new Date(at.getTime() + SESSION_LIFETIME_MS), revokedAt: null };
  const later = (ms: number) => new Date(at.getTime() + ms);

  it('is live until it is revoked, expires, or goes unused for the idle window', () => {
    expect(sessionState(fresh, later(1))).toBe('live');
    expect(sessionState(fresh, later(SESSION_IDLE_MS - 1))).toBe('live');
    expect(sessionState(fresh, later(SESSION_IDLE_MS))).toBe('idle');
    expect(sessionState({ ...fresh, lastSeenAt: later(SESSION_LIFETIME_MS - 1_000) }, later(SESSION_LIFETIME_MS - 1))).toBe('live');
    expect(sessionState({ ...fresh, lastSeenAt: later(SESSION_LIFETIME_MS - 1_000) }, later(SESSION_LIFETIME_MS))).toBe('expired');
  });

  it('is revoked first: a revoked session is refused whatever else is true of it', () => {
    expect(sessionState({ ...fresh, revokedAt: at }, later(1))).toBe('revoked');
    expect(sessionState({ ...fresh, revokedAt: at }, later(SESSION_LIFETIME_MS * 2))).toBe('revoked');
  });
});

describe('judging a one-time token', () => {
  const at = new Date('2026-11-02T09:00:00.000Z');
  const open = { expiresAt: new Date(at.getTime() + 3_600_000), usedAt: null, supersededAt: null };

  it('is open until it is used, replaced or out of time, and says which', () => {
    expect(oneTimeTokenState(open, at)).toBe('open');
    expect(oneTimeTokenState({ ...open, usedAt: at }, at)).toBe('used');
    expect(oneTimeTokenState({ ...open, supersededAt: at }, at)).toBe('superseded');
    expect(oneTimeTokenState(open, new Date(at.getTime() + 3_600_000))).toBe('expired');
    expect(oneTimeTokenState({ ...open, usedAt: at, supersededAt: at }, new Date(at.getTime() + 9_999_999))).toBe('used');
  });
});
