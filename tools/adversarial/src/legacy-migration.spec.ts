import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearCarriedOver, freshChrome, newProfileDir, waitFor, type RunEnvironment } from './browser-run.js';
import { readDeviceRecordInPage } from './device-record.js';
import { StubServer } from './stub-server.js';

/**
 * A learner partway through an attempt when the new shell loads (M8-15). Before it, the response log was in `localStorage`; after it, in IndexedDB. A record left in the old place must be moved
 * to the new one by the shipped app, in a real browser, with nothing lost, and the old keys removed only after. This plays that: an attempt is sat with the current build, its record is
 * rewritten into the old place and the new one is deleted (the state a browser is in the moment the new build first loads), an answer is added that the server has never been sent, and the
 * page is loaded again.
 */
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
const URL_PATH = '/?form=00000000-0000-4000-8000-0000000000f1&session=2026-01-27/shift-1';
const SECOND_SLOT = '00000000-0000-4000-8000-0000000000a2';

beforeAll(async () => {
  await freshChrome(environment);
});
afterAll(async () => {
  await environment.chrome.current?.close();
});

describe('a record an earlier build left in localStorage', () => {
  it('is moved to IndexedDB by the app, with an answer the server never had, and the old keys are gone after', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 3_600_000, intervalCapMs: 120_000 });
    await server.start();
    const chrome = environment.chrome.current!;
    await clearCarriedOver(chrome.context, server.origin);
    try {
      // an attempt, sat with the current build
      const first = await chrome.context.newPage();
      await first.goto(`${server.origin}${URL_PATH}`);
      await first.getByRole('region', { name: 'Question 1' }).waitFor();
      await first.getByRole('radio', { name: /^Option C$/iu }).check();
      await first.evaluate(readDeviceRecordInPage, null); // after the write has landed
      const record = JSON.parse((await first.evaluate(readDeviceRecordInPage, null))!) as { attemptId: string; events: Array<{ sequence: number }>; acknowledgedIds: string[] };
      await first.close();

      // the state the browser was in when it last ran the old build: the record in localStorage, an answer in it that was never sent, and nothing in IndexedDB
      const unsent = { eventId: randomUUID(), attemptId: record.attemptId, slot: SECOND_SLOT, sequence: record.events.at(-1)!.sequence + 1, monotonicMs: 5_000, kind: 'select', answer: 'b' };
      const old = { ...record, events: [...record.events, unsent] };
      const prepare = await chrome.context.newPage();
      await prepare.goto(`${server.origin}/sw.js`);
      await prepare.evaluate(async ([json, id]) => {
        await new Promise<void>((resolveDelete) => {
          const deleting = indexedDB.deleteDatabase('qb-device');
          deleting.onsuccess = () => resolveDelete();
          deleting.onerror = () => resolveDelete();
          deleting.onblocked = () => resolveDelete();
        });
        window.localStorage.setItem(`qb.attempt.${id}`, json!);
        window.localStorage.setItem('qb.attempt.active', id!);
      }, [JSON.stringify(old), record.attemptId]);
      await prepare.close();

      // the new build loads
      const page = await chrome.context.newPage();
      await page.goto(`${server.origin}${URL_PATH}`);
      await page.getByRole('region', { name: 'Question 1' }).waitFor();
      expect(await page.getByRole('radio', { name: /^Option C$/iu }).isChecked()).toBe(true);
      await page.getByRole('button', { name: /^Question 2/u }).click();
      expect(await page.getByRole('radio', { name: /^Option B$/iu }).isChecked()).toBe(true);

      // the old keys are gone, and the new store holds the whole record, including the answer only the old place had
      expect(await page.evaluate(() => Object.keys(window.localStorage).filter((key) => key.startsWith('qb.attempt.')))).toEqual([]);
      const moved = JSON.parse((await page.evaluate(readDeviceRecordInPage, record.attemptId))!) as { events: Array<{ eventId: string }> };
      expect(moved.events.map((event) => event.eventId)).toContain(unsent.eventId);
      expect(moved.events.length).toBeGreaterThanOrEqual(old.events.length);
      // and the server, which had never been sent it, has it now
      await waitFor('the server has the answer that only the old record held', () => server.projection().slots.find((slot) => slot.slot === SECOND_SLOT)?.answer === 'b', 20_000);
      await page.close();
    } finally {
      await server.stop();
    }
  });
});
