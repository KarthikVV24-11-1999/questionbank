import { resolve } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearCarriedOver, freshChrome, newProfileDir, stepBudgetMs, waitFor, type RunEnvironment } from './browser-run.js';
import { readDeviceRecordInPage } from './device-record.js';
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
      'timed out waiting for event c to be durable: after 7 restores from what is on disk, the last held 2 events, the last b',
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

  /** Writes a record the way the app's store does (`idb-record-store.ts`): one transaction over the three stores, strict durability, resolved on `complete`. */
  const writeInPage = (page: Page, ids: string[], states: Record<string, string> = {}) =>
    page.evaluate(async ([eventIds, stateOf]) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open('qb-device', 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('attempts', { keyPath: 'attemptId' });
          request.result.createObjectStore('events', { keyPath: ['attemptId', 'eventId'] }).createIndex('byAttempt', 'attemptId');
          request.result.createObjectStore('device');
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const transaction = db.transaction(['attempts', 'events', 'device'], 'readwrite', { durability: 'strict' });
      const done = new Promise<void>((resolve) => (transaction.oncomplete = () => resolve()));
      transaction.objectStore('attempts').put({ attemptId: 'probe', version: 1 });
      (eventIds as string[]).forEach((eventId, index) => transaction.objectStore('events').put({ attemptId: 'probe', eventId, sequence: index + 1, state: (stateOf as Record<string, string>)[eventId] ?? 'open', event: { eventId, sequence: index + 1, slot: 's', kind: 'visit' } }));
      transaction.objectStore('device').put('probe', 'active');
      await done;
      db.close();
    }, [ids, states] as const);

  it('reads nothing before a write, and reads a write the moment its transaction has completed: acknowledged is durable', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 1, intervalCapMs: 1 });
    await server.start();
    const chrome = environment.chrome.current!;
    await clearCarriedOver(chrome.context, server.origin);
    const page = await chrome.context.newPage();
    try {
      await page.goto(`${server.origin}/sw.js`);
      expect(await readFromDisk(environment.chrome.profileDir, server.origin, 'probe')).toBeNull();
      await writeInPage(page, ['first']);
      // no wait: a browser started from the disk reads it as soon as the page has been told it is written, where `localStorage` was read a minute later
      expect(recordHolds(await readFromDisk(environment.chrome.profileDir, server.origin, 'probe'), 'first')).toBe(true);
      await waitUntilDurable({ read: () => readFromDisk(environment.chrome.profileDir, server.origin, 'probe'), listing: () => storageListing(environment.chrome.profileDir), eventId: 'first', timeoutMs: 20_000 });
    } finally {
      await page.close();
      await server.stop();
    }
  });

  it('reads which events the server has and which it refused, as the app wrote them', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 1, intervalCapMs: 1 });
    await server.start();
    const chrome = environment.chrome.current!;
    await clearCarriedOver(chrome.context, server.origin);
    const page = await chrome.context.newPage();
    try {
      await page.goto(`${server.origin}/sw.js`);
      await writeInPage(page, ['sent', 'refused', 'waiting'], { sent: 'acknowledged', refused: 'rejected' });
      const record = JSON.parse((await readFromDisk(environment.chrome.profileDir, server.origin, 'probe'))!) as { acknowledgedIds: string[]; rejectedIds: string[]; events: unknown[] };
      expect([record.acknowledgedIds, record.rejectedIds, record.events.length]).toEqual([['sent'], ['refused'], 3]);
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
      await writeInPage(page, ['one']);
      await waitFor('the browser has written its store', () => storageListing(environment.chrome.profileDir) !== 'unreadable' && storageListing(environment.chrome.profileDir).includes('.log:'), 10_000);
      const before = storageListing(environment.chrome.profileDir);
      await page.evaluate(async () => {
        const request = indexedDB.open('qb-device');
        const db = await new Promise<IDBDatabase>((resolve) => (request.onsuccess = () => resolve(request.result)));
        const transaction = db.transaction('events', 'readwrite', { durability: 'strict' });
        for (let n = 0; n < 40; n += 1) transaction.objectStore('events').put({ attemptId: 'probe', eventId: `more-${n}`, sequence: 10 + n, state: 'open', event: { eventId: `more-${n}`, padding: 'x'.repeat(400) } });
        await new Promise<void>((resolve) => (transaction.oncomplete = () => resolve()));
        db.close();
      });
      await waitFor('the listing changes', () => storageListing(environment.chrome.profileDir) !== before, 10_000);
      expect(storageListing('/no/such/profile')).toBe('unreadable');
    } finally {
      await page.close();
      await server.stop();
    }
  });

  it('leaves the browser it is looking at as it was: the page still holds what it wrote', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 1, intervalCapMs: 1 });
    await server.start();
    const chrome = environment.chrome.current!;
    await clearCarriedOver(chrome.context, server.origin);
    const page = await chrome.context.newPage();
    try {
      await page.goto(`${server.origin}/sw.js`);
      await writeInPage(page, ['kept']);
      await readFromDisk(environment.chrome.profileDir, server.origin, 'probe');
      expect(recordHolds(await page.evaluate(readDeviceRecordInPage, 'probe'), 'kept')).toBe(true);
    } finally {
      await page.close();
      await server.stop();
    }
  });
});
