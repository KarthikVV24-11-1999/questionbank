import { resolve } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { freshChrome, leveldbHolds, newProfileDir, waitFor, type RunEnvironment } from './browser-run.js';
import type { RunningChrome } from './chrome.js';
import { StubServer } from './stub-server.js';

/**
 * Two things the adversarial runs do not and cannot claim, written down as tests that pass while the gap is there and go red the day it
 * closes, so the register entry that names each (D66, D67) cannot go stale unnoticed.
 *
 *   - **D66** — Chrome keeps a page's `localStorage` writes in memory and commits them to disk some seconds later. A browser killed
 *     outright (the way an out-of-memory phone kills one) inside that window loses what the learner did in it, **unless the server
 *     already has it**. A closed tab, a crashed tab and a browser that quits keep everything; the hundred runs show it.
 *   - **D67** — a tab reopened while the backend is down cannot resume: the app asks the server for the attempt before it carries on.
 *
 * The control beside the first (a kill once the write is on disk loses nothing) shows the loss is the window and not the kill.
 */
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
const URL_PATH = '/?form=00000000-0000-4000-8000-0000000000f1&session=2026-01-27/shift-1';

afterAll(async () => {
  await environment.chrome.current?.close().catch(() => undefined);
});

async function sitting(): Promise<{ server: StubServer; chrome: RunningChrome }> {
  const server = new StubServer({ distDir: environment.distDir, durationMs: 3_600_000, intervalCapMs: 120_000 });
  await server.start();
  const chrome = environment.chrome.current ?? (await freshChrome(environment));
  return { server, chrome };
}

async function answerOffline(chrome: RunningChrome, server: StubServer, option: string) {
  const page = await chrome.context.newPage();
  await page.goto(`${server.origin}${URL_PATH}`);
  await page.getByRole('region', { name: 'Question 1' }).waitFor();
  server.outage = '503'; // nothing can reach the server: what the learner does now exists on the device and nowhere else
  await page.getByRole('radio', { name: new RegExp(`^Option ${option}$`, 'iu') }).check();
  return page;
}

const answerOf = async (chrome: RunningChrome, server: StubServer): Promise<string | null> => {
  const page = await chrome.context.newPage();
  await page.goto(`${server.origin}${URL_PATH}`);
  await page.getByRole('region', { name: 'Question 1' }).waitFor();
  for (const option of ['a', 'b', 'c', 'd']) if (await page.getByRole('radio', { name: new RegExp(`^Option ${option}$`, 'iu') }).isChecked()) return option;
  return null;
};

describe('a browser killed outright (D66)', () => {
  it('keeps an answer once the write is on disk — the kill is not the loss, the window is', async () => {
    const { server, chrome } = await sitting();
    const page = await answerOffline(chrome, server, 'c');
    const record = await page.evaluate(() => window.localStorage.getItem(`qb.attempt.${window.localStorage.getItem('qb.attempt.active')}`));
    const last = (JSON.parse(record!) as { events: Array<{ eventId: string }> }).events.at(-1)!;
    const { readdirSync, readFileSync } = await import('node:fs');
    const dir = `${environment.chrome.profileDir}/Default/Local Storage/leveldb`;
    await waitFor('the answer is in the profile on disk', () => readdirSync(dir).some((file) => readFileSync(`${dir}/${file}`).includes(last.eventId)), 20_000);
    await chrome.kill();
    environment.chrome.current = null;
    const reopened = await freshChrome(environment);
    server.outage = 'off';
    expect(await answerOf(reopened, server)).toBe('c');
    await server.stop();
  });

  it('loses an answer the browser had not yet written to disk when it was killed, with the server unreachable', async () => {
    // Whether a given kill lands inside the window is up to Chrome, so the test looks at the disk after the kill and only counts a kill
    // that left the answer off it. Such a kill happens nearly every time; the loop is for the rare one that does not.
    for (let attempt = 0; attempt < 10; attempt += 1) {
      const { server, chrome } = await sitting();
      const page = await answerOffline(chrome, server, 'd');
      const record = await page.evaluate(() => window.localStorage.getItem(`qb.attempt.${window.localStorage.getItem('qb.attempt.active')}`));
      const last = (JSON.parse(record!) as { events: Array<{ eventId: string }> }).events.at(-1)!;
      await chrome.kill();
      environment.chrome.current = null;
      const onDisk = leveldbHolds(environment.chrome.profileDir, last.eventId);
      const reopened = await freshChrome(environment);
      server.outage = 'off';
      const answer = await answerOf(reopened, server);
      await server.stop();
      if (onDisk) {
        expect(answer, 'what is on disk is what comes back').toBe('d');
        continue;
      }
      // D66: the answer was never on disk, the server never had it, and nothing else holds it. When this goes red, the loss has closed.
      expect(answer).toBeNull();
      return;
    }
    throw new Error('ten kills in a row landed after the write was on disk; the window this test describes could not be found');
  });
});

describe('a tab reopened during an outage (D67)', () => {
  it.fails('resumes the attempt, from what the device holds (it does not: the app asks the server first)', async () => {
    const { server, chrome } = await sitting();
    const page = await answerOffline(chrome, server, 'b');
    await page.close();
    // the tab is gone and the backend is still down
    const reopened = await chrome.context.newPage();
    await reopened.goto(`${server.origin}${URL_PATH}`);
    try {
      await reopened.getByRole('region', { name: 'Question 1' }).waitFor({ timeout: 4_000 });
      expect(await reopened.getByRole('radio', { name: /^Option B$/iu }).isChecked()).toBe(true);
    } finally {
      await server.stop();
    }
  });
});
