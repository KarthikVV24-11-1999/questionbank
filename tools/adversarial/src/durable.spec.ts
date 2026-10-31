import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearCarriedOver, freshChrome, newProfileDir, stepBudgetMs, waitFor, type RunEnvironment } from './browser-run.js';
import { DURABLE_WAIT_MS } from './durable.js';
import { describeRecord, readFromDisk, recordHolds, storageListing, waitUntilDurable } from './durable.js';
import { StubServer } from './stub-server.js';

/**
 * Durable is a fact about what a browser started from the disk reads, and the gate that waits for it must not say so early, must say so when it is so, and must say what it saw
 * when it never is. The first half is over fakes (the clock, the files and the read are the test's); the second is a real Chrome, because "on disk" is Chrome's.
 */
const record = (...ids: string[]) => JSON.stringify({ events: ids.map((eventId) => ({ eventId })) });

function fakeClock() {
  let at = 0;
  return { now: () => at, sleep: async (ms: number) => void (at += ms) };
}

describe('waiting until a record is durable, over fakes', () => {
  it('resolves when a read from disk holds the event, and not before: a record without it is not durable', async () => {
    const reads = [null, record('a', 'b'), record('a', 'b', 'c')];
    const clock = fakeClock();
    let listing = 0;
    await waitUntilDurable({ read: async () => reads.shift() ?? null, listing: () => `v${(listing += 1)}`, eventId: 'c', ...clock });
    expect(reads).toEqual([]);
  });

  it('asks again when the files change and not otherwise, until its interval is up, whatever the files say', async () => {
    const clock = fakeClock();
    const asked: number[] = [];
    await waitUntilDurable({
      read: async () => (asked.push(clock.now()), asked.length < 4 ? record('a') : record('a', 'c')),
      listing: () => 'unchanging',
      eventId: 'c',
      probeAtLeastEveryMs: 10_000,
      pollMs: 1_000,
      ...clock,
    });
    expect(asked).toEqual([0, 10_000, 20_000, 30_000]);
  });

  it('asks as soon as the files change', async () => {
    const clock = fakeClock();
    const asked: number[] = [];
    await waitUntilDurable({
      read: async () => (asked.push(clock.now()), asked.length < 3 ? record('a') : record('a', 'c')),
      listing: () => (clock.now() < 3_000 ? 'before' : clock.now() < 7_000 ? 'after' : 'later'),
      eventId: 'c',
      probeAtLeastEveryMs: 60_000,
      pollMs: 1_000,
      ...clock,
    });
    expect(asked).toEqual([0, 3_000, 7_000]);
  });

  it('rejects when it never is, naming the event and what the last read from disk held', async () => {
    const clock = fakeClock();
    await expect(waitUntilDurable({ read: async () => record('a', 'b'), listing: () => 'same', eventId: 'c', timeoutMs: 30_000, ...clock })).rejects.toThrow(
      'timed out waiting for event c to be durable: after 3 restores from what is on disk, the last held 2 events, the last b',
    );
  });

  it('says so when there was nothing to read, and when what it read was not a record', async () => {
    for (const [read, said] of [[null, 'no record at all'], ['not json', 'a record that does not parse']] as const) {
      await expect(waitUntilDurable({ read: async () => read, listing: () => 'same', eventId: 'c', timeoutMs: 1_000, ...fakeClock() })).rejects.toThrow(said);
    }
  });

  it('takes a record that turns up on the last look, at the deadline', async () => {
    const clock = fakeClock();
    const reads = [record('a'), record('a'), record('a', 'c')];
    await waitUntilDurable({ read: async () => reads.shift() ?? null, listing: () => 'same', eventId: 'c', timeoutMs: 20_000, probeAtLeastEveryMs: 10_000, pollMs: 1_000, ...clock });
    expect(reads).toEqual([]);
  });

  it('describes a record by its length and its last event, and holds only what holds the event', () => {
    expect(describeRecord(record('a', 'b'))).toBe('2 events, the last b');
    expect(describeRecord(record())).toBe('0 events, the last none');
    expect(recordHolds(record('a', 'b'), 'a')).toBe(true);
    expect(recordHolds(record('a', 'b'), 'z')).toBe(false);
    expect(recordHolds('{', 'a')).toBe(false);
    expect(recordHolds(null, 'a')).toBe(false);
  });
});

describe('how long a step may take', () => {
  it('allows a kill that waits for durability the browser\'s own commit on top of the usual two waits, and nothing else more than two waits', () => {
    expect(stepBudgetMs({ t: 'kill', how: 'sigkill-durable' }, 30_000)).toBe(60_000 + DURABLE_WAIT_MS);
    for (const step of [{ t: 'kill', how: 'quit' }, { t: 'kill', how: 'tab-close' }, { t: 'settle' }, { t: 'visit', slot: 0 }] as const) expect(stepBudgetMs(step, 30_000)).toBe(60_000);
  });
});

describe('what a browser started from the disk reads, in a real Chrome', () => {
  const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
  beforeAll(async () => {
    await freshChrome(environment);
  });
  afterAll(async () => {
    await environment.chrome.current?.close();
  });

  it('does not read a write the browser has not committed, and reads it once the browser has', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 1, intervalCapMs: 1 });
    await server.start();
    const chrome = environment.chrome.current!;
    await clearCarriedOver(chrome.context, server.origin);
    const page = await chrome.context.newPage();
    try {
      await page.goto(`${server.origin}/sw.js`);
      await page.evaluate((value) => window.localStorage.setItem('qb.attempt.probe', value), record('first'));
      // the page reads it back at once; a browser started from the disk does not, because Chrome has not written it yet
      expect(await page.evaluate(() => window.localStorage.getItem('qb.attempt.probe'))).toContain('first');
      expect(await readFromDisk(environment.chrome.profileDir, server.origin, 'qb.attempt.probe')).toBeNull();
      await waitUntilDurable({ read: () => readFromDisk(environment.chrome.profileDir, server.origin, 'qb.attempt.probe'), listing: () => storageListing(environment.chrome.profileDir), eventId: 'first', timeoutMs: 60_000 });
      expect(recordHolds(await readFromDisk(environment.chrome.profileDir, server.origin, 'qb.attempt.probe'), 'first')).toBe(true);
    } finally {
      await page.close();
      await server.stop();
    }
  });

  it('changes the listing it offers as a reason to look when the browser writes, and calls an unreadable profile unreadable', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 1, intervalCapMs: 1 });
    await server.start();
    const chrome = environment.chrome.current!;
    await clearCarriedOver(chrome.context, server.origin);
    const page = await chrome.context.newPage();
    try {
      await page.goto(`${server.origin}/sw.js`);
      await page.evaluate(() => window.localStorage.setItem('listed', 'x'.repeat(200)));
      await waitFor('the browser commits its first write', () => storageListing(environment.chrome.profileDir).includes('.log:') && !storageListing(environment.chrome.profileDir).includes('.log:0'), 30_000);
      const before = storageListing(environment.chrome.profileDir);
      await page.evaluate(() => window.localStorage.setItem('listed-again', 'y'.repeat(300)));
      // the browser's next commit may be a minute away, and this is the wait for it
      await waitFor('the listing changes', () => storageListing(environment.chrome.profileDir) !== before, 90_000);
      expect(storageListing('/no/such/profile')).toBe('unreadable');
    } finally {
      await page.close();
      await server.stop();
    }
  }, 120_000);

  it('leaves the browser it is looking at as it was: the page still holds what it wrote', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 1, intervalCapMs: 1 });
    await server.start();
    const chrome = environment.chrome.current!;
    await clearCarriedOver(chrome.context, server.origin);
    const page = await chrome.context.newPage();
    try {
      await page.goto(`${server.origin}/sw.js`);
      await page.evaluate(() => window.localStorage.setItem('kept', 'still here'));
      await readFromDisk(environment.chrome.profileDir, server.origin, 'kept');
      expect(await page.evaluate(() => window.localStorage.getItem('kept'))).toBe('still here');
    } finally {
      await page.close();
      await server.stop();
    }
  });
});
