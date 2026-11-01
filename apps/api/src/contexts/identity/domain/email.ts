import { err, ok, type Result } from './result.js';

/**
 * An address as the context knows it: trimmed and lower-cased, which is the key a person is found and kept unique by. Deliberately not a full RFC 5322 parse — the
 * only proof an address is real is a message that arrives, and a pattern stricter than that refuses people with unusual addresses for nothing.
 */
const SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;
export const MAX_EMAIL_LENGTH = 254;

export function normalizeEmail(raw: unknown): Result<string, 'EMAIL_INVALID'> {
  if (typeof raw !== 'string') return err('EMAIL_INVALID');
  const email = raw.trim().toLowerCase();
  return email.length <= MAX_EMAIL_LENGTH && SHAPE.test(email) ? ok(email) : err('EMAIL_INVALID');
}
