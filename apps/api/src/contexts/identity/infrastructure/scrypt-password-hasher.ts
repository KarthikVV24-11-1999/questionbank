import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { CURRENT_PASSWORD_PARAMETERS, SALT_LENGTH, type PasswordParameters, type StoredCredential } from '../domain/password-hash.js';
import { normalisePassword } from '../domain/password-normalisation.js';
import type { PasswordHasher } from '../application/ports.js';

/**
 * scrypt from `node:crypto`, no dependency (M8-02). Node's default `maxmem` (32 MB) is below what N=2^16, r=8 needs (about 64 MB), so it is raised in the call and N is not
 * lowered to fit; the limit is a multiple of what the parameters need, so a credential made under a later, larger N still verifies here without a change to this file.
 *
 * The password is normalised before it is hashed (`normalisePassword`, the one form the check against known passwords reads too), so the same characters typed on two keyboards are one password. Verification reads the parameters off the credential,
 * compares in constant time, and checks the length first because `timingSafeEqual` throws on a mismatch rather than answering.
 */
function derive(password: string, salt: Uint8Array, parameters: PasswordParameters): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(normalisePassword(password), salt, parameters.keyLength, { N: parameters.n, r: parameters.r, p: parameters.p, maxmem: 256 * parameters.n * parameters.r }, (error, key) => (error === null ? resolve(key) : reject(error)));
  });
}

export class ScryptPasswordHasher implements PasswordHasher {
  constructor(readonly parameters: PasswordParameters = CURRENT_PASSWORD_PARAMETERS) {}

  async hash(password: string): Promise<StoredCredential> {
    const salt = randomBytes(SALT_LENGTH);
    return { parameters: this.parameters, salt, hash: await derive(password, salt, this.parameters) };
  }

  async verify(password: string, stored: StoredCredential): Promise<boolean> {
    const candidate = await derive(password, stored.salt, stored.parameters);
    return candidate.length === stored.hash.length && timingSafeEqual(candidate, stored.hash);
  }
}
