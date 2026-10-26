import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshChrome, newProfileDir, type RunEnvironment } from './browser-run.js';
import { StubServer } from './stub-server.js';

/**
 * The learner's own screens and what the device keeps (M6-59, F6/F35), in a real browser. The server is made to leak: the signed
 * package carries an answer key and a solution on every item, which the real server never does. The shell must draw none of it and
 * keep none of it on the device — and the same scan must find the leak where it was deliberately left (the cached package), so that an
 * empty result elsewhere is an empty result and not a scan that cannot see.
 */
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
const LEAK = { correctOptionId: 'b', answerKey: { kind: 'SINGLE_CORRECT', optionId: 'b' }, solution: 'WORKED-SOLUTION-TEXT-7731' };
const NEEDLES = ['correctOptionId', 'answerKey', 'WORKED-SOLUTION-TEXT-7731', 'SINGLE_CORRECT"'];
const found = (text: string): string[] => NEEDLES.filter((needle) => text.includes(needle));

beforeAll(async () => {
  await freshChrome(environment);
});
afterAll(async () => {
  await environment.chrome.current?.close();
});

describe('a package that leaks a key is not drawn and not kept (F6, F35)', () => {
  it('shows none of it on any screen, stores none of it on the device, and the scan finds it in what the server sent', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 3_600_000, intervalCapMs: 120_000, packageItemExtra: LEAK });
    await server.start();
    const page = await environment.chrome.current!.context.newPage();
    try {
      await page.goto(`${server.origin}/?form=00000000-0000-4000-8000-0000000000f1&session=2026-01-27/shift-1`);
      await page.getByRole('region', { name: 'Question 1' }).waitFor();
      await page.getByRole('radio', { name: /^Option B$/iu }).check();
      await page.getByRole('button', { name: /^Question 2/u }).click();
      await page.getByRole('button', { name: 'Submit paper' }).click();
      const screens: string[] = [await page.content()];
      await page.getByRole('button', { name: 'Yes, submit' }).click();
      await page.getByRole('heading', { name: 'Submitted' }).waitFor();
      screens.push(await page.content());

      const stored = await page.evaluate(() => JSON.stringify({ ...window.localStorage, session: { ...window.sessionStorage } }));
      expect(screens.flatMap(found)).toEqual([]);
      expect(found(stored)).toEqual([]);

      // non-vacuity: the leak is real, and the same scan sees it in the bytes the server sent
      const served = await (await fetch(`${server.origin}/v1/assessment/forms/00000000-0000-4000-8000-0000000000f1/package`)).text();
      expect(found(served).sort()).toEqual([...NEEDLES].sort());
    } finally {
      await page.close();
      await server.stop();
    }
  });
});
