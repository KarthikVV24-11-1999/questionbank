import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
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
 *   - **D67** — a tab reopened while the backend is down resumes from the device **only if the service worker already holds the package**, which it
 *     does after a visit it controlled (a reload, or a second visit) and does not after a first visit alone: that page was loaded before the worker
 *     controlled anything, so its package request went straight to the network and nothing was kept. The reopen then has no paper to verify, and the
 *     app says the server failed. The first half is a test that passes; the second is the gap, held open.
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

async function answerOffline(chrome: RunningChrome, server: StubServer, option: string, beforeOutage: (page: Page) => Promise<void> = async () => undefined) {
  const page = await chrome.context.newPage();
  await page.goto(`${server.origin}${URL_PATH}`);
  await page.getByRole('region', { name: 'Question 1' }).waitFor();
  await beforeOutage(page);
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

  it.fails('resumes the attempt after a first visit that was never reloaded (it does not: the package was never cached, so the reopen has no paper to verify)', async () => {
    const { server, chrome } = await sitting();
    try {
      const page = await answerOffline(chrome, server, 'b', async (visit) => {
        // Whatever would put the package in the cache has the time to: this waits for it, and goes on without it after three seconds.
        await visit.evaluate(() => navigator.serviceWorker.ready.then(() => undefined)).catch(() => undefined);
        await waitFor('the worker holds the package', () => packageIsCached(visit), 3_000).catch(() => undefined);
        await visit.getByRole('region', { name: 'Question 1' }).waitFor(); // a visit that reloaded itself in the meantime is showing the question again
      });
      await page.close();
      // D67, the open half. When this goes red, a first visit leaves the package behind.
      expect(await reopenDuringOutage(chrome, server)).toEqual({ question: true, optionB: true });
    } finally {
      await server.stop();
    }
  });
});
