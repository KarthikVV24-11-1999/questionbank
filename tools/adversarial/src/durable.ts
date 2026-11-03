import { cpSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { launchChrome } from './chrome.js';
import { readDeviceRecordInPage } from './device-record.js';
import { newProfileDir } from './profiles.js';

/**
 * Whether a value is **durable**, established by reading it back from what is on disk, and not by looking for its bytes.
 *
 * A `sigkill-durable` kill exists to test restoring what a browser durably wrote. The first version of the precondition (D93) searched the profile's LevelDB files for the event's id as
 * text. That is a claim about bytes, and the bytes are not the fact: the value can be durable and not spelled out in a file (LevelDB keeps recent writes in a write-ahead log and later
 * rewrites them into compressed table files), and a gate on the bytes failed on a runner when nothing about the app's durability had changed.
 *
 * What is true is that a browser started from nothing but the profile's files reads the value. So the gate asks exactly that: it copies the storage directory, starts a second Chrome
 * on the copy, and reads the record. The copy is of what Chrome has written *so far*, which is the point; the browser being tested is not disturbed.
 *
 * **What is read, and why the wait is short now (M8-16).** The response log is in IndexedDB (M8-15), whose transactions complete once their data is on disk, so a record the app has
 * acknowledged is a record a browser started from the disk reads, and the first look finds it. The wait it used to be (two minutes, for Chrome's own commit of `localStorage`, which
 * it made at most a few times and then about once a minute) is gone with the thing it waited for. What is left is a bound for a disk that is slow, or an app that has not yet written,
 * and the run that plants a slow disk (`device-record.ts`) is what shows the gate waiting for it.
 */
export const DURABLE_WAIT_MS = 30_000;
const PROBE_AT_LEAST_EVERY_MS = 5_000;
const POLL_MS = 250;

const storageDir = (profileDir: string): string => join(profileDir, 'Default', 'IndexedDB');

function sizesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? sizesUnder(path).map((inner) => `${name}/${inner}`) : [`${name}:${statSync(path).size}`];
  });
}

/** What the storage directory holds, as names and sizes: a change means Chrome wrote something, which is when it is worth asking. Never the verdict. */
export function storageListing(profileDir: string): string {
  try {
    return sizesUnder(storageDir(profileDir)).join(' ');
  } catch {
    return 'unreadable';
  }
}

/** The record of `attemptId` as a browser started from a copy of the profile's storage reads it, as JSON; `null` where it holds none or the copy could not be read. */
export async function readFromDisk(profileDir: string, origin: string, attemptId: string | null): Promise<string | null> {
  const snapshot = newProfileDir();
  try {
    cpSync(storageDir(profileDir), storageDir(snapshot), { recursive: true, filter: (source) => !source.endsWith('/LOCK') });
    const chrome = await launchChrome(snapshot);
    try {
      const page = await chrome.context.newPage();
      await page.goto(`${origin}/sw.js`);
      return await page.evaluate(readDeviceRecordInPage, attemptId);
    } finally {
      await chrome.close().catch(() => undefined);
    }
  } catch {
    return null;
  } finally {
    rmSync(snapshot, { recursive: true, force: true });
  }
}

export interface DurableWait {
  /** What a browser started from the disk reads of the record. */
  readonly read: () => Promise<string | null>;
  readonly listing: () => string;
  /** The event the record must hold. */
  readonly eventId: string;
  readonly timeoutMs?: number;
  readonly probeAtLeastEveryMs?: number;
  readonly pollMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** What a restored record says, for a message that states a fact: how many events, and the last. */
export function describeRecord(raw: string | null): string {
  if (raw === null) return 'no record at all (the copy held nothing under that key, or could not be read)';
  try {
    const events = (JSON.parse(raw) as { events?: Array<{ eventId?: string }> }).events ?? [];
    return `${events.length} events, the last ${events.at(-1)?.eventId ?? 'none'}`;
  } catch {
    return 'a record that does not parse';
  }
}

export function recordHolds(raw: string | null, eventId: string): boolean {
  if (raw === null) return false;
  try {
    return ((JSON.parse(raw) as { events?: Array<{ eventId?: string }> }).events ?? []).some((event) => event.eventId === eventId);
  } catch {
    return false;
  }
}

/** Resolves once a browser started from the disk reads a record holding `eventId`; rejects, saying what was expected and what the last such read held. */
export async function waitUntilDurable(wait: DurableWait): Promise<void> {
  const now = wait.now ?? (() => performance.now());
  const sleep = wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = now() + (wait.timeoutMs ?? DURABLE_WAIT_MS);
  let lastRead: string | null = null;
  let probes = 0;
  for (;;) {
    const seen = wait.listing();
    lastRead = await wait.read();
    probes += 1;
    if (recordHolds(lastRead, wait.eventId)) return;
    // ask again when Chrome has written something, or after a while whatever the files say: the files only say when to look
    const probedAt = now();
    while (now() < deadline && wait.listing() === seen && now() - probedAt < (wait.probeAtLeastEveryMs ?? PROBE_AT_LEAST_EVERY_MS)) await sleep(wait.pollMs ?? POLL_MS);
    if (now() >= deadline) {
      lastRead = await wait.read();
      probes += 1;
      if (recordHolds(lastRead, wait.eventId)) return;
      throw new Error(`timed out waiting for event ${wait.eventId} to be durable: after ${probes} restores from what is on disk, the last held ${describeRecord(lastRead)}`);
    }
  }
}
