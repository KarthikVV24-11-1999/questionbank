import { describe, expect, it } from 'vitest';
import { MIN_PASSWORD_LENGTH } from '../domain/password-policy.js';
import { normalisePassword } from '../domain/password-normalisation.js';
import { BundledPasswordList } from './bundled-password-list.js';
import { COMMON_PASSWORDS } from './common-passwords.js';

const list = new BundledPasswordList();
const verdict = (password: string) => list.lookup(normalisePassword(password));

describe('the list that ships with the code', () => {
  it('holds only entries the lookup can match: twelve characters or more, lower-case, in the hasher\'s form, each once', () => {
    expect(COMMON_PASSWORDS.length).toBeGreaterThan(200);
    for (const entry of COMMON_PASSWORDS) {
      expect([...entry].length, entry).toBeGreaterThanOrEqual(MIN_PASSWORD_LENGTH);
      expect(entry, entry).toBe(entry.toLowerCase());
      expect(entry, entry).toBe(normalisePassword(entry));
    }
    expect(new Set(COMMON_PASSWORDS).size).toBe(COMMON_PASSWORDS.length);
  });

  it('refuses every entry it holds', async () => {
    for (const entry of COMMON_PASSWORDS) expect(await verdict(entry), entry).toBe('breached');
  });
});

describe('looking a password up', () => {
  it('finds a listed password in any case, since a guessing run mangles case first', async () => {
    expect(await verdict('password1234')).toBe('breached');
    expect(await verdict('Password1234')).toBe('breached');
    expect(await verdict('PASSWORD1234')).toBe('breached');
  });

  it('finds the same password written in another unicode form, once it is in the hasher\'s form', async () => {
    expect(await verdict('ｐａｓｓｗｏｒｄ１２３４')).toBe('breached');
  });

  it('matches the whole password: a listed one with something added, or a listed one inside a longer phrase, is not it', async () => {
    expect(await verdict('password1234x')).toBe('not_found');
    expect(await verdict('xpassword1234')).toBe('not_found');
    expect(await verdict('my password1234 is long')).toBe('not_found');
  });

  it('finds a short unit repeated, up to four characters, and not five, and not one that is broken by a different character', async () => {
    for (const repeated of ['aaaaaaaaaaaa', 'abababababab', 'abcabcabcabc', 'wxyzwxyzwxyz', '🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑🔑']) expect(await verdict(repeated), repeated).toBe('breached');
    expect(await verdict('qwertqwertqwert')).toBe('not_found');
    // ending mid-unit is still a repeat; a different character is not
    expect(await verdict('abababababa')).toBe('breached');
    expect(await verdict('abababababac')).toBe('not_found');
  });

  it('finds a run that steps one character up or down all the way, and not one that steps by two or turns back', async () => {
    for (const run of ['abcdefghijkl', 'lkjihgfedcba', 'mnopqrstuvwx', '98765432109876'.slice(0, 9) + 'abc']) {
      // the last of these is not a run: it turns at the join, which is the point of the check below
      if (run.endsWith('abc')) expect(await verdict(run), run).toBe('not_found');
      else expect(await verdict(run), run).toBe('breached');
    }
    expect(await verdict('acegikmoqsuw')).toBe('not_found');
    expect(await verdict('abcdefghijkji')).toBe('not_found');
    expect(await verdict('abcdefghijkz')).toBe('not_found');
    expect(await verdict('zabcdefghijk')).toBe('not_found');
  });

  it('does not find an ordinary passphrase, nor one that merely starts a run', async () => {
    expect(await verdict('correct horse battery staple')).toBe('not_found');
    expect(await verdict('x7#vQ2!mLp9$wZ')).toBe('not_found');
    expect(await verdict('abcdefgh-strong-tail')).toBe('not_found');
  });
});
