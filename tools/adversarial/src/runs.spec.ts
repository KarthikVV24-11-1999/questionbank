import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { freshChrome, newProfileDir, runScenario, type RunEnvironment, type RunReport } from './browser-run.js';
import { generateScenario } from './scenario.js';

/**
 * The adversarial runs (M6-57): a hundred seeded scenarios, each played against the real learner build in a real Chrome. Seeds are
 * `FIRST_SEED … FIRST_SEED + 99`; `QB_ADVERSARIAL_SEED=<n>` replays one, and prints its scenario, which is all a failure needs.
 */
const FIRST_SEED = 20_261_026;
const RUNS = Number(process.env['QB_ADVERSARIAL_RUNS'] ?? 100);
const only = process.env['QB_ADVERSARIAL_SEED'];
const seeds = only === undefined ? Array.from({ length: RUNS }, (_, index) => FIRST_SEED + index) : [Number(only)];

/**
 * Runs share a few browsers, one scenario at a time in each: a seed is a function of its seed alone, so which browser plays it, and
 * what else is playing beside it, changes nothing about what it does. (A browser killed by one run is replaced before the next.)
 */
const WORKERS = Math.max(1, Math.min(Number(process.env['QB_ADVERSARIAL_WORKERS'] ?? 4), availableParallelism()));
const distDir = resolve(import.meta.dirname, '../../../apps/learn/dist');
const pool: RunEnvironment[] = Array.from({ length: WORKERS }, () => ({ distDir, chrome: { current: null, profileDir: newProfileDir() } }));
const free = [...pool];
const waiting: Array<(environment: RunEnvironment) => void> = [];
const acquire = (): Promise<RunEnvironment> => {
  const environment = free.pop();
  return environment === undefined ? new Promise((resolveNext) => waiting.push(resolveNext)) : Promise.resolve(environment);
};
const release = (environment: RunEnvironment): void => {
  const next = waiting.shift();
  if (next === undefined) free.push(environment);
  else next(environment);
};
const reports: RunReport[] = [];

describe('adversarial runs in a real browser (M6-54, M6-55, M6-56, M6-57)', () => {
  it('has a real Chrome to play them in', async () => {
    const environment = await acquire();
    try {
      await freshChrome(environment);
      expect(environment.chrome.current?.process.pid).toBeGreaterThan(0);
    } finally {
      release(environment);
    }
  });

  describe.concurrent('the seeds', () => {
    for (const seed of seeds) {
      it(`seed ${seed}: loses no response`, async () => {
        const scenario = generateScenario(seed);
        const environment = await acquire();
        try {
          environment.chrome.current ??= await freshChrome(environment);
          reports.push(await runScenario(scenario, environment));
        } catch (error) {
          throw new Error(`replay with QB_ADVERSARIAL_SEED=${seed}\nscenario: ${JSON.stringify(scenario.steps)}\n${error instanceof Error ? error.message : String(error)}`, { cause: error });
        } finally {
          release(environment);
        }
      });
    }
  });

  it('exercised every dimension, in enough runs that passing says something', () => {
    expect(reports).toHaveLength(seeds.length);
    if (only !== undefined) return;
    const count = (predicate: (report: RunReport) => boolean) => reports.filter(predicate).length;
    const kills = reports.flatMap((report) => report.kills);
    const summary = {
      runs: reports.length,
      kills: kills.length,
      byKill: Object.fromEntries(['tab-crash', 'tab-close', 'quit', 'sigkill-durable'].map((how) => [how, kills.filter((kill) => kill.how === how).length])),
      byPoint: { 'mid-sync': kills.filter((kill) => kill.point === 'mid-sync').length, 'between-batches': kills.filter((kill) => kill.point === 'between-batches').length },
      killedWithQuestionOpen: kills.filter((kill) => kill.questionOpen).length,
      runsWithOutage503: count((report) => report.outages.includes('503')),
      runsWithConnectionReset: count((report) => report.outages.includes('reset')),
      runsWithWallClockSkew: count((report) => report.wallSkewsMs.length > 0),
      runsWithWallClockBack: count((report) => report.wallSkewsMs.some((ms) => ms < 0)),
      runsWithWallClockForward: count((report) => report.wallSkewsMs.some((ms) => ms > 0)),
      responsesGiven: reports.reduce((sum, report) => sum + report.given.answers + report.given.clears + report.given.flags, 0),
      eventsOnServer: reports.reduce((sum, report) => sum + report.eventsOnServer, 0),
    };
    console.log(`ADVERSARIAL SUMMARY ${JSON.stringify(summary)}`);
    // The set, not the loop: every dimension was exercised, in enough runs that a pass says something.
    expect(Object.entries(summary.byKill).filter(([, n]) => n >= 10).map(([how]) => how)).toEqual(['tab-crash', 'tab-close', 'quit', 'sigkill-durable']);
    expect(summary.byPoint['mid-sync']).toBeGreaterThanOrEqual(10);
    expect(summary.byPoint['between-batches']).toBeGreaterThanOrEqual(10);
    expect(summary.killedWithQuestionOpen).toBeGreaterThanOrEqual(30);
    expect(summary.runsWithOutage503).toBeGreaterThanOrEqual(15);
    expect(summary.runsWithConnectionReset).toBeGreaterThanOrEqual(15);
    expect(summary.runsWithWallClockBack).toBeGreaterThanOrEqual(15);
    expect(summary.runsWithWallClockForward).toBeGreaterThanOrEqual(15);
    expect(reports.every((report) => report.deadlineUnmoved && report.cachedAttemptRequests === 0 && report.cachesInspected > 0)).toBe(true);
  });

  it('closes the browsers', async () => {
    for (const environment of pool) await environment.chrome.current?.close();
  });
});
