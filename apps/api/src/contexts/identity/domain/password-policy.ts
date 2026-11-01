import { err, ok, type Result } from './result.js';

/**
 * What a password must be to be accepted. Length and nothing else: composition rules make people choose worse passwords, and the upper bound is not generosity but a bound
 * on the work a hostile request can ask of a memory-hard hash.
 */
export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export type PasswordRefusal = 'PASSWORD_TOO_SHORT' | 'PASSWORD_TOO_LONG' | 'PASSWORD_NOT_TEXT';

export function checkPassword(raw: unknown): Result<string, PasswordRefusal> {
  if (typeof raw !== 'string') return err('PASSWORD_NOT_TEXT');
  // by characters a person typed, not by UTF-16 units
  const length = [...raw].length;
  if (length < MIN_PASSWORD_LENGTH) return err('PASSWORD_TOO_SHORT');
  if (length > MAX_PASSWORD_LENGTH) return err('PASSWORD_TOO_LONG');
  return ok(raw);
}
