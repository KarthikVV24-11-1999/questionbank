import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import { clearCarriedOver, freshChrome, newProfileDir, waitFor, type RunEnvironment } from './browser-run.js';
import { installCommitTimer, readDeviceRecordInPage } from './device-record.js';
import { readFromDisk, storageListing, waitUntilDurable } from './durable.js';
import type { RunningChrome } from './chrome.js';
import { StubServer } from './stub-server.js';

/**
 * What the adversarial runs say about a browser killed outright, and what a tab reopened during an outage does:
 *
 *   - **D66, closed (M8-15)** — the response log was in `localStorage`, which Chrome commits to disk some seconds after a write and, after the first few commits, about once a minute,
 *     so a browser killed outright (the way an out-of-memory phone kills one) lost up to a minute of answers unless the server had them. The log is in IndexedDB now, where a transaction
 *     completes once its data is on disk. These tests are what closed it: an answer given with the backend unreachable and the browser killed at once, with no wait for anything, is
 *     there on reopening, every time; and the window that is left, between a tap and the commit that holds it, is measured and not asserted away.
 *   - **D67** — a tab reopened while the backend is down resumes from the device, whether the earlier visit was reloaded or not. A reloaded visit is
 *     controlled by the service worker, which caches the package for it; a first visit alone is not, so the page puts the package in the worker's cache
 *     itself once it has rendered. Both are plain tests.
 *
 * The control beside the first (a kill once the write is known to be on disk loses nothing) shows the kill is not what loses an answer.
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
  await clearCarriedOver(chrome.context, server.origin);
  return { server, chrome };
}

/**
 * Answers `option` with the backend down, so that the answer exists on the device and nowhere else. Then lets the device's store finish the write the answer started, unless
 * `settle` is false: a read of the store queues behind a write in flight, so it returns when the write has landed. A test that closes the tab or kills the browser on purpose before that
 * is testing the window (the next describe measures it); one that is about something else does not want to be racing it.
 */
async function answerOffline(chrome: RunningChrome, server: StubServer, option: string, beforeOutage: (page: Page) => Promise<void> = async () => undefined, settle = true) {
  const page = await chrome.context.newPage();
  await page.goto(`${server.origin}${URL_PATH}`);
  await page.getByRole('region', { name: 'Question 1' }).waitFor();
  await beforeOutage(page);
  server.outage = '503'; // nothing can reach the server: what the learner does now exists on the device and nowhere else
  await page.getByRole('radio', { name: new RegExp(`^Option ${option}$`, 'iu') }).check();
  if (settle) await page.evaluate(readDeviceRecordInPage, null);
  return page;
}

const answerOf = async (chrome: RunningChrome, server: StubServer): Promise<string | null> => {
  const page = await chrome.context.newPage();
  await page.goto(`${server.origin}${URL_PATH}`);
  await page.getByRole('region', { name: 'Question 1' }).waitFor();
  for (const option of ['a', 'b', 'c', 'd']) if (await page.getByRole('radio', { name: new RegExp(`^Option ${option}$`, 'iu') }).isChecked()) return option;
  return null;
};

describe('a browser killed outright (D66, closed by M8-15)', () => {
  it('keeps an answer once it is known to be on disk — the kill is not the loss', async () => {
    const { server, chrome } = await sitting();
    const page = await answerOffline(chrome, server, 'c');
    const attemptId = (await page.evaluate(readDeviceRecordInPage, null).then((raw) => JSON.parse(raw!) as { attemptId: string })).attemptId;
    const last = (JSON.parse((await page.evaluate(readDeviceRecordInPage, null))!) as { events: Array<{ eventId: string }> }).events.at(-1)!;
    // durable is read back from what is on disk, not looked for in a file (`durable.ts`)
    await waitUntilDurable({ read: () => readFromDisk(environment.chrome.profileDir, server.origin, attemptId), listing: () => storageListing(environment.chrome.profileDir), eventId: last.eventId });
    await chrome.kill();
    environment.chrome.current = null;
    const reopened = await freshChrome(environment);
    server.outage = 'off';
    expect(await answerOf(reopened, server)).toBe('c');
    await server.stop();
  });

  it('keeps an answer given with the backend unreachable when the browser is killed a quarter of a second later, waiting for nothing to reach the disk: every time', async () => {
    // This is the test the old log failed. It answered, killed with no wait for the disk, and found the answer gone nearly every time: the commit of `localStorage` was seconds to a minute
    // away, so a quarter of a second was well inside the window; the server was down, so nothing else held it. A quarter of a second is some fifteen times what a commit takes now
    // (measured below), and a kill that lands inside the commit itself is that window, which this does not claim to close. It is many kills and not one for the rare slow commit.
    for (const option of ['d', 'a', 'c', 'b', 'd', 'a'] as const) {
      const { server, chrome } = await sitting();
      const page = await answerOffline(chrome, server, option, undefined, false);
      await page.waitForTimeout(250);
      await chrome.kill();
      environment.chrome.current = null;
      const reopened = await freshChrome(environment);
      server.outage = 'off';
      expect(await answerOf(reopened, server), `a kill a quarter of a second after answering ${option}`).toBe(option);
      await server.stop();
    }
  }, 120_000);

  it('leaves a window, and this measures it: from a tap to the commit that holds it, on this machine', async () => {
    // What is still lost is an answer whose transaction has not completed when the browser dies. That is the time below, per tap; it is not zero, and it is the only window left.
    const { server, chrome } = await sitting();
    const page = await chrome.context.newPage();
    await page.addInitScript(installCommitTimer);
    try {
      await page.goto(`${server.origin}${URL_PATH}`);
      await page.getByRole('region', { name: 'Question 1' }).waitFor();
      server.outage = '503';
      for (let tap = 0; tap < 24; tap += 1) {
        await page.getByRole('radio', { name: new RegExp(`^Option ${'abcd'[tap % 4]}$`, 'iu') }).check();
        await page.waitForTimeout(40);
      }
      const timings = await page.evaluate(() => (window as unknown as { __qbCommitMs: number[] }).__qbCommitMs);
      const sorted = [...timings].sort((a, b) => a - b);
      const median = sorted[Math.floor(sorted.length / 2)]!;
      console.info(`D66 window: ${timings.length} commits, median ${median.toFixed(1)} ms, slowest ${sorted.at(-1)!.toFixed(1)} ms (tap to a transaction that completes after the data is on disk)`);
      expect(timings.length).toBeGreaterThanOrEqual(24);
      expect(sorted.at(-1)).toBeLessThan(1_000); // tens of milliseconds, against a minute
    } finally {
      await page.close();
      await server.stop();
    }
  });
});

/** A page that is being reloaded has no context to ask: that is "not yet", not a failure. */
const packageIsCached = (page: Page): Promise<boolean> =>
  page
    .evaluate(async () => {
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) if (/\/package$/u.test(new URL(request.url).pathname)) return true;
      return false;
    })
    .catch(() => false);

/** Reopens the tab with the backend still down, and says what the learner is looking at: the question and the checked option, or what the page said instead. */
async function reopenDuringOutage(chrome: RunningChrome, server: StubServer) {
  const reopened = await chrome.context.newPage();
  await reopened.goto(`${server.origin}${URL_PATH}`);
  try {
    await reopened.getByRole('region', { name: 'Question 1' }).waitFor({ timeout: 4_000 });
  } catch {
    return { question: false as const, shown: await reopened.evaluate(() => document.body.innerText) };
  }
  return { question: true as const, optionB: await reopened.getByRole('radio', { name: /^Option B$/iu }).isChecked() };
}

describe('a tab reopened during an outage (D67)', () => {
  it('resumes the attempt from what the device holds, when the worker has the package from an earlier visit it controlled', async () => {
    const { server, chrome } = await sitting();
    try {
      const page = await answerOffline(chrome, server, 'b', async (visit) => {
        await visit.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
        await visit.reload();
        await visit.getByRole('region', { name: 'Question 1' }).waitFor();
        await waitFor('the worker holds the package', () => packageIsCached(visit));
      });
      await page.close(); // the tab is gone and the backend is still down
      expect(await reopenDuringOutage(chrome, server)).toEqual({ question: true, optionB: true });
    } finally {
      await server.stop();
    }
  });

  it('resumes the attempt after a first visit that was never reloaded: the page put the package in the worker\'s cache itself (DEC-M7-35)', async () => {
    const { server, chrome } = await sitting();
    try {
      const page = await answerOffline(chrome, server, 'b', async (visit) => {
        // The page puts the package in the cache after it renders: this gives that the time to finish, and goes on without it after three seconds.
        await visit.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)).catch(() => undefined);
        await waitFor('the worker holds the package', () => packageIsCached(visit), 3_000).catch(() => undefined);
        await visit.getByRole('region', { name: 'Question 1' }).waitFor(); // a visit that reloaded itself in the meantime is showing the question again
      });
      await page.close();
      // D67's other half: a first visit alone, no reload. It was held open here until the page began to put the package in the cache itself.
      expect(await reopenDuringOutage(chrome, server)).toEqual({ question: true, optionB: true });
    } finally {
      await server.stop();
    }
  });
});
