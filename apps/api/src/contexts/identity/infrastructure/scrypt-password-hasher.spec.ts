import { describe, expect, it } from 'vitest';
import { CURRENT_PASSWORD_PARAMETERS } from '../domain/password-hash.js';
import { ScryptPasswordHasher } from './scrypt-password-hasher.js';

const CHEAP = { algorithm: 'scrypt', n: 1_024, r: 8, p: 1, keyLength: 32 } as const;

describe('the scrypt hasher', () => {
  it('hashes under today\'s parameters by default, with a fresh 16-byte salt each time', async () => {
    const hasher = new ScryptPasswordHasher();
    expect(hasher.parameters).toEqual(CURRENT_PASSWORD_PARAMETERS);
    const [a, b] = [await hasher.hash('a long enough password'), await hasher.hash('a long enough password')];
    expect(a.parameters).toEqual(CURRENT_PASSWORD_PARAMETERS);
    expect(a.salt).toHaveLength(16);
    expect(a.hash).toHaveLength(32);
    expect(Buffer.from(a.salt).equals(Buffer.from(b.salt))).toBe(false);
    expect(Buffer.from(a.hash).equals(Buffer.from(b.hash))).toBe(false);
  });

  it('verifies the right password and not a wrong one, and a wrong one of any length without throwing', async () => {
    const hasher = new ScryptPasswordHasher(CHEAP);
    const stored = await hasher.hash('the right password');
    expect(await hasher.verify('the right password', stored)).toBe(true);
    for (const wrong of ['the wrong password', '', 'x'.repeat(5_000), 'the right passwor']) expect(await hasher.verify(wrong, stored), wrong.slice(0, 10)).toBe(false);
  });

  it('reads the parameters off the credential, so one made under a weaker setting still verifies after the setting is raised', async () => {
    const old = await new ScryptPasswordHasher(CHEAP).hash('made under the cheap setting');
    const raised = new ScryptPasswordHasher({ ...CHEAP, n: 4_096 });
    expect(await raised.verify('made under the cheap setting', old)).toBe(true);
    expect(old.parameters.n).toBe(1_024);
  });

  it('refuses a credential whose hash has been cut short, rather than throwing on the length', async () => {
    const hasher = new ScryptPasswordHasher(CHEAP);
    const stored = await hasher.hash('another password here');
    expect(await hasher.verify('another password here', { ...stored, hash: stored.hash.slice(0, 16) })).toBe(false);
  });

  it('treats the same characters in two unicode forms as one password', async () => {
    const hasher = new ScryptPasswordHasher(CHEAP);
    const composed = 'café au lait please';
    const decomposed = 'café au lait please';
    expect(await hasher.verify(decomposed, await hasher.hash(composed))).toBe(true);
  });

  it('has the memory to hash under a larger N than today\'s: raising it later is a setting, not a change here', async () => {
    const larger = new ScryptPasswordHasher({ ...CURRENT_PASSWORD_PARAMETERS, n: 131_072 });
    const stored = await larger.hash('a password under a larger cost');
    expect(await larger.verify('a password under a larger cost', stored)).toBe(true);
  }, 30_000);
});
