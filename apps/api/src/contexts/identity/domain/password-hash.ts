/**
 * How a password is stored so it can be strengthened later without a reset (M8-02, ADR-0056).
 *
 * A credential carries the parameters it was hashed under. Verification reads them from the credential, not from today's settings, so raising `N` changes
 * what is written next and breaks nothing already written; a login that finds a credential under older parameters than today's rewrites it, and in time every active
 * user has moved. Pure: the hash itself is infrastructure's.
 */
export interface PasswordParameters {
  readonly algorithm: 'scrypt';
  /** CPU/memory cost: a power of two. About 128 · N · r bytes per hash, so 64 MB at the current values. */
  readonly n: number;
  readonly r: number;
  readonly p: number;
  readonly keyLength: number;
}

/**
 * OWASP-acceptable, and deliberately not 2^17: at 128 MB a hash, concurrent logins become a memory problem before they become a security win.
 * Changing this is how the hash is strengthened; nothing else in the repository names these numbers.
 */
export const CURRENT_PASSWORD_PARAMETERS: PasswordParameters = Object.freeze({ algorithm: 'scrypt', n: 65_536, r: 8, p: 1, keyLength: 32 });
export const SALT_LENGTH = 16;

export interface StoredCredential {
  readonly parameters: PasswordParameters;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

/** Whether a stored credential was made under anything but the parameters in force, in which case a successful login rewrites it. */
export function needsRehash(stored: PasswordParameters, current: PasswordParameters = CURRENT_PASSWORD_PARAMETERS): boolean {
  return stored.algorithm !== current.algorithm || stored.n !== current.n || stored.r !== current.r || stored.p !== current.p || stored.keyLength !== current.keyLength;
}
