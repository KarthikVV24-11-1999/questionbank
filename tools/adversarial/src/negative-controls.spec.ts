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

  it('fails when a durable kill does not wait for durability, and says which events the restored record is missing', async () => {
    // a browser killed in the browser's own write delay loses what it had not yet committed (D66); the gate before a durable kill is what keeps that out of the runs
    const scenario = { seed: 1, steps: [{ t: 'answer', slot: 0, option: 'a' }, { t: 'outage', mode: '503' }, { t: 'answer', slot: 1, option: 'b' }, { t: 'answer', slot: 2, option: 'c' }, { t: 'kill', how: 'sigkill-durable' }] } as const;
    const error = await runScenario(scenario, environment, { sabotage: 'kill-without-durability', waitMs: 4_000, evidence: false }).then(() => null, (thrown: unknown) => thrown as Error);
    const said = /after a sigkill-durable the reopened attempt is not the one that was killed: the device held (\d+) events before it \(the last [0-9a-f-]{36} \(select\)\), the restored record holds (\d+) and is missing (\d+): [0-9a-f-]{36}/u.exec(error?.message ?? '');
    expect(said, error?.message).not.toBeNull();
    const [before, after, missing] = said!.slice(1).map(Number) as [number, number, number];
    // the reopen adds events of its own, so the restored record can hold more than it lost; what matters is that some of what the device held is not in it
    expect(missing).toBeGreaterThan(0);
    expect(missing).toBeLessThanOrEqual(before);
    expect(after).toBeGreaterThanOrEqual(before - missing);
    expect(after).toBeGreaterThan(0); // never an empty record: the reopen writes its own visit
  });

  it('passes the same scenario with the gate in place: the event is durable before the kill, and comes back', async () => {
    const scenario = { seed: 1, steps: [{ t: 'answer', slot: 0, option: 'a' }, { t: 'outage', mode: '503' }, { t: 'answer', slot: 1, option: 'b' }, { t: 'answer', slot: 2, option: 'c' }, { t: 'kill', how: 'sigkill-durable' }] } as const;
    await expect(runScenario(scenario, environment, { waitMs: 4_000, evidence: false })).resolves.toMatchObject({ seed: 1 });
  });

  it('names every planted defect it can plant: none is left without a case', () => {
    const planted: Sabotage[] = ['device-forgets-responses', 'server-drops-events', 'server-restarts-deadline-on-read', 'attempt-requests-are-cached'];
    expect(failures.map(([sabotage]) => sabotage).sort()).toEqual([...planted].sort());
    expect('kill-without-durability' satisfies Sabotage).toBeDefined(); // its case is the test above: it needs a scenario of its own
  });
});
