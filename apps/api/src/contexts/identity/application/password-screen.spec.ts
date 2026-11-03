import { describe, expect, it } from 'vitest';
import type { BreachCheckLog, BreachedPasswords, BreachVerdict } from './ports.js';
import { describeRefusal, PasswordScreen } from './password-screen.js';

const CONTEXT = { action: 'register', correlationId: 'corr-1' };

function sourceAnswering(answer: BreachVerdict | Error) {
  const asked: string[] = [];
  const source: BreachedPasswords = {
    lookup: (normalised) => {
      asked.push(normalised);
      return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
    },
  };
  return { source, asked };
}

function recordingLog() {
  const entries: Array<Parameters<BreachCheckLog['unavailable']>[0]> = [];
  return { log: { unavailable: (entry: Parameters<BreachCheckLog['unavailable']>[0]) => void entries.push(entry) } satisfies BreachCheckLog, entries };
}

describe('whether a password may be set', () => {
  it('accepts one the source does not know, and returns it as it was given', async () => {
    const { source } = sourceAnswering('not_found');
    expect(await new PasswordScreen({ source }).check('a passphrase nobody has', CONTEXT)).toEqual({ ok: true, value: 'a passphrase nobody has' });
  });

  it('refuses one the source knows', async () => {
    const { source } = sourceAnswering('breached');
    expect(await new PasswordScreen({ source }).check('a passphrase nobody has', CONTEXT)).toEqual({ ok: false, error: 'PASSWORD_BREACHED' });
  });

  it('returns the password as it was given, not in the form it was looked up in: the hasher normalises it itself', async () => {
    const given = 'ｃｏｒｒｅｃｔ ｈｏｒｓｅ ｂａｔｔｅｒｙ';
    const { source } = sourceAnswering('not_found');
    expect(await new PasswordScreen({ source }).check(given, CONTEXT)).toEqual({ ok: true, value: given });
  });

  it('applies the length rules first, and does not ask the source about a password that cannot be set anyway', async () => {
    const { source, asked } = sourceAnswering('breached');
    const screen = new PasswordScreen({ source });
    expect(await screen.check('short', CONTEXT)).toEqual({ ok: false, error: 'PASSWORD_TOO_SHORT' });
    expect(await screen.check('x'.repeat(257), CONTEXT)).toEqual({ ok: false, error: 'PASSWORD_TOO_LONG' });
    expect(await screen.check(42, CONTEXT)).toEqual({ ok: false, error: 'PASSWORD_NOT_TEXT' });
    expect(asked).toEqual([]);
  });

  it('asks the source in the one form the hasher derives from, so a match the hash would have made is not missed', async () => {
    const { source, asked } = sourceAnswering('not_found');
    await new PasswordScreen({ source }).check('ｐａｓｓｗｏｒｄ１２３４', CONTEXT);
    expect(asked).toEqual(['password1234']);
  });

  it('writes no record when the source answers, whatever the answer', async () => {
    for (const answer of ['breached', 'not_found'] as const) {
      const { log, entries } = recordingLog();
      await new PasswordScreen({ source: sourceAnswering(answer).source, log }).check('a passphrase nobody has', CONTEXT);
      expect(entries, answer).toEqual([]);
    }
  });
});

describe('when the source cannot answer', () => {
  it('accepts the password, and leaves one record saying the source said so', async () => {
    const { log, entries } = recordingLog();
    const result = await new PasswordScreen({ source: sourceAnswering('unavailable').source, log }).check('a passphrase nobody has', CONTEXT);
    expect(result).toEqual({ ok: true, value: 'a passphrase nobody has' });
    expect(entries).toEqual([{ ...CONTEXT, reason: 'source_unavailable' }]);
  });

  it('accepts the password, and leaves one record saying the source threw', async () => {
    const { log, entries } = recordingLog();
    const result = await new PasswordScreen({ source: sourceAnswering(new Error('connect ETIMEDOUT')).source, log }).check('a passphrase nobody has', { ...CONTEXT, action: 'reset' });
    expect(result).toEqual({ ok: true, value: 'a passphrase nobody has' });
    expect(entries).toEqual([{ action: 'reset', correlationId: 'corr-1', reason: 'source_error' }]);
  });

  it('records nothing the thrown error said, since it may name a host or a prefix', async () => {
    const { log, entries } = recordingLog();
    await new PasswordScreen({ source: sourceAnswering(new Error('GET https://api.example/range/5BAA6 failed')).source, log }).check('a passphrase nobody has', CONTEXT);
    expect(JSON.stringify(entries)).not.toMatch(/range|5BAA6|example/u);
  });

  it('works with no log at all', async () => {
    expect((await new PasswordScreen({ source: sourceAnswering('unavailable').source }).check('a passphrase nobody has', CONTEXT)).ok).toBe(true);
    expect((await new PasswordScreen({ source: sourceAnswering(new Error('x')).source }).check('a passphrase nobody has', CONTEXT)).ok).toBe(true);
  });
});

describe('what a refusal says', () => {
  it('is about the password and never about whose it is', () => {
    expect(describeRefusal('PASSWORD_BREACHED')).toBe('That password is too common or has appeared in a data breach. Choose a different one.');
    for (const code of ['PASSWORD_TOO_SHORT', 'PASSWORD_TOO_LONG', 'PASSWORD_NOT_TEXT'] as const) expect(describeRefusal(code)).toBe('That password is not acceptable: use at least 12 characters.');
  });
});
