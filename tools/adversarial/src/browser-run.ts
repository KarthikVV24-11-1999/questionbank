import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { projectResponses, type ResponseEvent } from '@questionbank/attempt-engine';
import type { Page } from 'playwright-core';
import { launchChrome, type RunningChrome } from './chrome.js';
import type { Interruption, Option, Scenario, SlotIndex, Step } from './scenario.js';
import { StubServer } from './stub-server.js';

/**
 * One adversarial run, in a real Chrome (M6-54, M6-55, M6-56, M6-57): the learner app is loaded from its build, a seeded scenario is
 * played against it through the page's own controls, and the browser is killed — and the run says, for each kill, what was in flight.
 *
 * **What counts as a loss.** The page's own record on the device is the thing the learner is told is safe, so a response is *given*
 * once the page has written it down (the run waits for that, as a condition), and from then on it must never be missing: not after a
 * kill and reopen, and not on the server once the backend is back. The oracle is a plain map of what was done — it shares nothing with
 * the engine it is checking.
 *
 * Time is never slept through. Every wait is for a condition (a record holding an event, a status saying all is sent, a file holding
 * the bytes); the only clock is the timeout that turns a condition that never comes true into a failure.
 */
export interface KillReport {
  readonly how: Interruption;
  readonly afterStep: number;
  /** Events the device held that the server had not acknowledged when the browser died. */
  readonly unsentAtKill: number;
  /** `mid-sync` if any were unsent, `between-batches` if everything had been acknowledged. */
  readonly point: 'mid-sync' | 'between-batches';
  /** Whether a question was open (the app was killed mid-visit). */
  readonly questionOpen: boolean;
  readonly projectionEqual: boolean;
  readonly logIsPrefixOfReopened: boolean;
  /** What the page said was left on reopening, and what the server's clock says is left. The first must not exceed the second. */
  readonly remainingOnReopenMs: number;
  readonly serverRemainingMs: number;
}

export interface RunReport {
  readonly seed: number;
  readonly steps: number;
  readonly kills: readonly KillReport[];
  readonly outages: readonly string[];
  readonly wallSkewsMs: readonly number[];
  readonly given: { readonly answers: number; readonly clears: number; readonly flags: number; readonly visits: number };
  readonly eventsOnDevice: number;
  readonly eventsOnServer: number;
  readonly deadlineUnmoved: boolean;
  readonly cachedAttemptRequests: number;
  readonly cachesInspected: number;
}

interface Oracle {
  readonly answers: Array<Option | null>;
  readonly flags: boolean[];
}

interface DeviceRecord {
  readonly events: ResponseEvent[];
  readonly acknowledgedIds: string[];
  readonly rejectedIds: string[];
}

const SLOT_IDS = ['00000000-0000-4000-8000-0000000000a1', '00000000-0000-4000-8000-0000000000a2', '00000000-0000-4000-8000-0000000000a3'] as const;
const PAGE_URL = (origin: string) => `${origin}/?form=00000000-0000-4000-8000-0000000000f1&session=2026-01-27/shift-1`;
const DURATION_MS = 3_600_000;
const INTERVAL_CAP_MS = 120_000;
const WAIT_MS = process.env['CI'] === undefined ? 30_000 : 60_000;

export interface RunEnvironment {
  readonly distDir: string;
  /** A Chrome shared between runs, and replaced whenever a run killed it. */
  readonly chrome: { current: RunningChrome | null; profileDir: string };
}

export async function waitFor(label: string, condition: () => Promise<boolean> | boolean, timeoutMs = WAIT_MS): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (await condition()) return;
    if (performance.now() > deadline) throw new Error(`timed out waiting for: ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const skewScript = (offsetMs: number) => `(() => {
  const Real = window.__qbRealDate ?? (window.__qbRealDate = Date);
  const shifted = ${offsetMs};
  window.Date = class extends Real {
    constructor(...args) { if (args.length === 0) super(Real.now() + shifted); else super(...args); }
    static now() { return Real.now() + shifted; }
  };
})();`;

export async function freshChrome(environment: RunEnvironment): Promise<RunningChrome> {
  environment.chrome.current = await launchChrome(environment.chrome.profileDir);
  return environment.chrome.current;
}

async function readRecord(page: Page): Promise<DeviceRecord | null> {
  return page.evaluate(() => {
    const id = window.localStorage.getItem('qb.attempt.active');
    const raw = id === null ? null : window.localStorage.getItem(`qb.attempt.${id}`);
    return raw === null ? null : (JSON.parse(raw) as never);
  });
}

export function leveldbHolds(profileDir: string, needle: string): boolean {
  const dir = join(profileDir, 'Default', 'Local Storage', 'leveldb');
  try {
    return readdirSync(dir).some((file) => readFileSync(join(dir, file)).includes(needle));
  } catch {
    return false;
  }
}

function lastKindFor(record: DeviceRecord | null, slot: string, kinds: readonly string[]): ResponseEvent | undefined {
  return [...(record?.events ?? [])].reverse().find((event) => event.slot === slot && kinds.includes(event.kind));
}

const unsentOf = (record: DeviceRecord): number => record.events.filter((event) => !record.acknowledgedIds.includes(event.eventId) && !record.rejectedIds.includes(event.eventId)).length;

function projectionOf(record: DeviceRecord) {
  return projectResponses(record.events, { intervalCapMs: INTERVAL_CAP_MS });
}

/**
 * Whether a reopened attempt is the one that was killed. Everything the projection says must be unchanged except the count of visits that never closed: a
 * reopen starts a new visit, so the one the kill left open is now an overwritten one, and the count rises by exactly the visits the kill orphaned (M7-45).
 * It may rise and may not fall, which is held here, so a restore that dropped a lost visit would still fail.
 */
function restoredProjection(before: DeviceRecord, after: DeviceRecord): boolean {
  const unchanged = (record: DeviceRecord) => projectionOf(record).slots.map(({ unclosedVisits: _lost, ...rest }) => rest);
  const lost = (record: DeviceRecord) => projectionOf(record).slots.map((slot) => slot.unclosedVisits);
  const kept = JSON.stringify(unchanged(before)) === JSON.stringify(unchanged(after));
  const afterLost = lost(after);
  return kept && lost(before).every((count, i) => (afterLost[i] ?? 0) >= count);
}

function parseRemaining(text: string): number {
  const parts = text.trim().split(':').map(Number);
  const [h, m, s] = parts.length === 3 ? parts : [0, ...parts];
  return ((h ?? 0) * 3600 + (m ?? 0) * 60 + (s ?? 0)) * 1000;
}

/**
 * A defect planted so that the harness can be shown to fail. Each is a thing the harness claims to catch; `negative-controls.spec.ts`
 * runs a scenario with each and expects the run to throw. A harness that cannot be made to fail proves nothing by passing.
 */
export type Sabotage = 'device-forgets-responses' | 'server-drops-events' | 'server-restarts-deadline-on-read' | 'attempt-requests-are-cached';

export interface RunOptions {
  readonly sabotage?: Sabotage;
  /** How long a condition may take to come true before the run fails. */
  readonly waitMs?: number;
}

export async function runScenario(scenario: Scenario, environment: RunEnvironment, options: RunOptions = {}): Promise<RunReport> {
  const waitMs = options.waitMs ?? WAIT_MS;
  const until = (label: string, condition: () => Promise<boolean> | boolean, timeoutMs = waitMs) => waitFor(label, condition, timeoutMs);
  const server = new StubServer({
    distDir: environment.distDir,
    durationMs: DURATION_MS,
    intervalCapMs: INTERVAL_CAP_MS,
    ...(options.sabotage === 'server-drops-events' ? { dropEvents: true } : {}),
    ...(options.sabotage === 'server-restarts-deadline-on-read' ? { restartDeadlineOnRead: true } : {}),
  });
  await server.start();
  const oracle: Oracle = { answers: [null, null, null], flags: [false, false, false] };
  const given = { answers: 0, clears: 0, flags: 0, visits: 0 };
  const kills: KillReport[] = [];
  const outages = new Set<string>();
  const skews: number[] = [];
  let wallSkewMs = 0;
  let deadline0: number | null = null;
  let chrome = environment.chrome.current ?? (await freshChrome(environment));
  let page = null as Page | null;

  const open = async (): Promise<Page> => {
    const opened = await chrome.context.newPage();
    if (options.sabotage === 'device-forgets-responses') {
      await opened.addInitScript(() => {
        const real = Storage.prototype.setItem;
        Storage.prototype.setItem = function (key: string, value: string) {
          if (!key.startsWith('qb.attempt.')) real.call(this, key, value);
        };
      });
    }
    if (options.sabotage === 'attempt-requests-are-cached') {
      await opened.addInitScript(() => {
        const realFetch = window.fetch.bind(window);
        window.fetch = async (input, init) => {
          const response = await realFetch(input, init);
          if (String(input instanceof Request ? input.url : input).includes('/v1/assessment/attempts')) await (await caches.open('planted')).put(String(input), response.clone());
          return response;
        };
      });
    }
    if (wallSkewMs !== 0) await opened.addInitScript(skewScript(wallSkewMs));
    await opened.goto(PAGE_URL(server.origin));
    // On a CI runner one seed in a run has timed out here without a cause being found (D80).
    await opened.getByRole('region', { name: /^Question \d/u }).waitFor({ timeout: WAIT_MS });
    page = opened;
    return opened;
  };

  const goTo = async (slot: SlotIndex): Promise<void> => {
    const current = page!;
    await current.getByRole('button', { name: new RegExp(`^Question ${slot + 1}(,|$)`, 'u') }).click();
    await current.getByRole('region', { name: `Question ${slot + 1}` }).waitFor();
  };

  const settle = async (): Promise<void> => {
    await until('every captured event acknowledged', async () => {
      // what the browser does when the network is back: say so, so the back-off is forgotten
      await page!.evaluate(() => window.dispatchEvent(new Event('online')));
      const record = await readRecord(page!);
      return record !== null && unsentOf(record) === 0;
    });
  };

  const applyStep = async (step: Step, index: number): Promise<void> => {
    switch (step.t) {
      case 'answer': {
        await goTo(step.slot);
        await page!.getByRole('radio', { name: new RegExp(`^Option ${step.option.toUpperCase()}$`, 'iu') }).check();
        oracle.answers[step.slot] = step.option;
        given.answers += 1;
        await until('the answer is on the device', async () => {
          const last = lastKindFor(await readRecord(page!), SLOT_IDS[step.slot], ['select', 'change', 'clear']);
          return last !== undefined && last.kind !== 'clear' && (last as { answer?: unknown }).answer === step.option;
        });
        return;
      }
      case 'clear': {
        await goTo(step.slot);
        if (oracle.answers[step.slot] === null) return;
        await page!.getByRole('button', { name: 'Clear my answer' }).click();
        oracle.answers[step.slot] = null;
        given.clears += 1;
        await until('the clear is on the device', async () => lastKindFor(await readRecord(page!), SLOT_IDS[step.slot], ['select', 'change', 'clear'])?.kind === 'clear');
        return;
      }
      case 'flag': {
        await goTo(step.slot);
        if (oracle.flags[step.slot] === step.on) return;
        await page!.getByRole('button', { name: step.on ? 'Flag for review' : 'Remove flag' }).click();
        oracle.flags[step.slot] = step.on;
        given.flags += 1;
        await until('the flag is on the device', async () => lastKindFor(await readRecord(page!), SLOT_IDS[step.slot], ['flag', 'unflag'])?.kind === (step.on ? 'flag' : 'unflag'));
        return;
      }
      case 'visit':
        await goTo(step.slot);
        given.visits += 1;
        return;
      case 'outage':
        server.outage = step.mode;
        outages.add(step.mode);
        return;
      case 'wall-skew':
        wallSkewMs += step.ms;
        skews.push(step.ms);
        await page!.evaluate(skewScript(wallSkewMs));
        return;
      case 'settle':
        await settle();
        return;
      case 'kill':
        await kill(step.how, index);
        return;
    }
  };

  const deviceRecord = async (from: Page = page!): Promise<DeviceRecord> => {
    const record = await readRecord(from);
    if (record === null) throw new Error(`seed ${scenario.seed}: the device holds no record of the attempt`);
    return record;
  };

  const kill = async (how: Interruption, afterStep: number): Promise<void> => {
    const before = await deviceRecord();
    const questionOpen = (() => {
      for (let i = before.events.length - 1; i >= 0; i -= 1) {
        const event = before.events[i]!;
        if (event.kind === 'leave') return false;
        if (event.kind === 'visit') return true;
      }
      return false;
    })();
    const unsentAtKill = unsentOf(before);
    const last = before.events.at(-1);

    if (how === 'tab-crash') {
      // The renderer is crashed, not closed: the tab dies the way an out-of-memory tab does, with no unload and no goodbye. The command
      // is never answered (the process that would answer it is gone), so what is awaited is the page saying it crashed.
      const session = await chrome.context.newCDPSession(page!);
      const crashed = new Promise<void>((resolve) => page!.once('crash', () => resolve()));
      void session.send('Page.crash').catch(() => undefined);
      await crashed;
      await Promise.race([page!.close({ runBeforeUnload: false }).catch(() => undefined), new Promise((resolve) => setTimeout(resolve, 5_000))]);
    } else if (how === 'tab-close') {
      await page!.close({ runBeforeUnload: false });
    } else if (how === 'quit') {
      await chrome.close();
      chrome = await freshChrome(environment);
    } else {
      // The browser is killed outright, but only once the bytes are on disk: what is being exercised is restoring from a killed
      // browser's profile. A kill that does not wait is `process-kill.spec.ts`, which says what it loses.
      if (last !== undefined) await until('the last event is in the profile on disk', () => leveldbHolds(environment.chrome.profileDir, last.eventId), Math.max(20_000, waitMs));
      await chrome.kill();
      chrome = await freshChrome(environment);
    }
    page = null;

    // The backend comes back for the reopen: reopening during an outage is a separate, recorded gap (see `offline-reopen.spec.ts`).
    server.outage = 'off';
    const reopened = await open();
    const after = await deviceRecord(reopened);
    const remainingText = await reopened.getByRole('timer').innerText();
    const remainingOnReopenMs = parseRemaining(remainingText);
    const serverRemainingMs = server.attempt!.deadline - Date.now();
    kills.push({
      how,
      afterStep,
      unsentAtKill,
      point: unsentAtKill > 0 ? 'mid-sync' : 'between-batches',
      questionOpen,
      projectionEqual: restoredProjection(before, after),
      logIsPrefixOfReopened: before.events.every((event, i) => JSON.stringify(after.events[i]) === JSON.stringify(event)),
      remainingOnReopenMs,
      serverRemainingMs,
    });
  };

  try {
    await open();
    deadline0 = server.attempt!.deadline;
    for (const [index, step] of scenario.steps.entries()) {
      if (process.env['QB_ADVERSARIAL_TRACE'] !== undefined) console.log(`[${scenario.seed}] step ${index}`, JSON.stringify(step));
      // A step that never finishes is reported as that step, not as a test that ran out of time somewhere.
      let watchdog: ReturnType<typeof setTimeout> | undefined;
      const stuck = new Promise<never>((_, reject) => {
        watchdog = setTimeout(() => reject(new Error(`seed ${scenario.seed}: step ${index} ${JSON.stringify(step)} did not finish within ${waitMs * 2} ms`)), waitMs * 2);
      });
      try {
        await Promise.race([applyStep(step, index), stuck]);
      } finally {
        clearTimeout(watchdog);
      }
    }

    server.outage = 'off';
    await settle();
    const finalRecord = await deviceRecord();
    const cacheInfo = await page!.evaluate(async () => {
      const urls: string[] = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
      return { names: (await caches.keys()).length, urls };
    });
    const serverProjection = server.projection();
    const deviceProjection = projectionOf(finalRecord);
    const answerOf = (projection: typeof serverProjection, slot: string) => projection.slots.find((entry) => entry.slot === slot);
    for (const [index, slotId] of SLOT_IDS.entries()) {
      for (const [where, projection] of [['device', deviceProjection], ['server', serverProjection]] as const) {
        const got = answerOf(projection, slotId);
        const expectedAnswer = oracle.answers[index] ?? null;
        if ((got?.answer ?? null) !== expectedAnswer || (got?.flagged ?? false) !== oracle.flags[index]) {
          throw new Error(`seed ${scenario.seed}: slot ${index + 1} on the ${where} is ${JSON.stringify(got)}; the learner gave answer ${expectedAnswer}, flag ${oracle.flags[index]}`);
        }
      }
    }
    const serverIds = new Set(server.events.keys());
    const missing = finalRecord.events.filter((event) => !serverIds.has(event.eventId));
    if (missing.length > 0) throw new Error(`seed ${scenario.seed}: ${missing.length} events on the device never reached the server`);
    for (const kill of kills) {
      if (!kill.projectionEqual || !kill.logIsPrefixOfReopened) throw new Error(`seed ${scenario.seed}: after a ${kill.how} the reopened attempt is not the one that was killed`);
      if (kill.remainingOnReopenMs > kill.serverRemainingMs + 2_000) throw new Error(`seed ${scenario.seed}: after a ${kill.how} the page showed ${kill.remainingOnReopenMs} ms left; the server's deadline leaves ${kill.serverRemainingMs}`);
    }
    const deadlineUnmoved = server.attempt!.deadline === deadline0;
    if (!deadlineUnmoved) throw new Error(`seed ${scenario.seed}: the server's deadline moved`);
    const cachedAttemptRequests = cacheInfo.urls.filter((path: string) => path.startsWith('/v1/assessment/attempts')).length;
    if (cachedAttemptRequests > 0) throw new Error(`seed ${scenario.seed}: attempt requests found in a cache: ${cacheInfo.urls.join(', ')}`);

    return {
      seed: scenario.seed,
      steps: scenario.steps.length,
      kills,
      outages: [...outages].sort(),
      wallSkewsMs: skews,
      given,
      eventsOnDevice: finalRecord.events.length,
      eventsOnServer: server.events.size,
      deadlineUnmoved,
      cachedAttemptRequests,
      cachesInspected: cacheInfo.names,
    };
  } finally {
    await page?.close({ runBeforeUnload: false }).catch(() => undefined);
    await server.stop();
  }
}

export { newProfileDir } from './profiles.js';
