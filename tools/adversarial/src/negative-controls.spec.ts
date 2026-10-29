import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshChrome, newProfileDir, runScenario, type RunEnvironment, type Sabotage } from './browser-run.js';
import { generateScenario } from './scenario.js';

/**
 * A harness that has never been seen to fail proves nothing by passing. Each case here plays a real seeded scenario against the real
 * build in a real Chrome with one defect planted — a device that does not write its responses down, a server that drops what it is
 * sent, a server that restarts the deadline when the attempt is read, a cache that holds attempt requests — and expects the run to
 * fail, and to say what it found.
 */
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
const SEED = 20_261_026;

beforeAll(async () => {
  await freshChrome(environment);
});
afterAll(async () => {
  await environment.chrome.current?.close();
});

const failures: ReadonlyArray<readonly [Sabotage, RegExp]> = [
  ['device-forgets-responses', /timed out waiting for: the answer is on the device/u],
  ['server-drops-events', /on the server is .*the learner gave/u],
  ['server-restarts-deadline-on-read', /(the server's deadline moved|showed \d+ ms left)/u],
  ['attempt-requests-are-cached', /attempt requests found in a cache/u],
];

describe('the adversarial harness is red when something is wrong', () => {
  it('passes the same scenario with nothing planted', async () => {
    await expect(runScenario(generateScenario(SEED), environment)).resolves.toMatchObject({ seed: SEED, deadlineUnmoved: true });
  });

  it.each(failures)('fails with %s planted, and says what it found', async (sabotage, message) => {
    await expect(runScenario(generateScenario(SEED), environment, { sabotage, waitMs: 4_000, evidence: false })).rejects.toThrow(message);
  });

  it('names every planted defect it can plant: none is left without a case', () => {
    const planted: Sabotage[] = ['device-forgets-responses', 'server-drops-events', 'server-restarts-deadline-on-read', 'attempt-requests-are-cached'];
    expect(failures.map(([sabotage]) => sabotage).sort()).toEqual([...planted].sort());
  });
});
