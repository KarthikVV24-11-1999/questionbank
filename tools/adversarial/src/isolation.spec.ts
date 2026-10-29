import { createServer } from 'node:net';
import { resolve } from 'node:path';
import type { BrowserContext } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshChrome, newProfileDir, runScenario, type RunEnvironment } from './browser-run.js';
import { generateScenario } from './scenario.js';

/**
 * A seed is a function of its seed alone (D80). That was written in a comment for a long time and was not so: scenarios in one browser share a profile, a
 * profile keeps `localStorage`, Cache Storage and service workers per origin, and a scenario whose server came up on a port an earlier one had used began
 * on that scenario's device record and warm worker. This runs one scenario, then another on the same browser and the same origin, and looks at what the
 * second one's first page is born with.
 */
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };

beforeAll(async () => {
  await freshChrome(environment);
});
afterAll(async () => {
  await environment.chrome.current?.close();
});

const freePort = (): Promise<number> =>
  new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolvePort(port));
    });
  });

interface FirstLoad {
  readonly attemptKeys: string[];
  readonly controlled: boolean;
  readonly cachedPaths: string[];
}

/** What each page the context opens holds when its document starts, before the app has run: recorded by a script the browser runs ahead of the page's own. */
async function watchFirstLoads(context: BrowserContext): Promise<FirstLoad[]> {
  const seen: FirstLoad[] = [];
  await context.exposeBinding('__qbFirstLoad', (_source, load: FirstLoad) => void seen.push(load));
  await context.addInitScript(() => {
    if (window.top !== window || window.location.protocol !== 'http:' || sessionStorage.getItem('__qbSeen') !== null) return;
    sessionStorage.setItem('__qbSeen', '1');
    const attemptKeys = Object.keys(localStorage).filter((key) => key.startsWith('qb.attempt.'));
    const controlled = navigator.serviceWorker?.controller != null;
    void (async () => {
      const cachedPaths: string[] = [];
      for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) cachedPaths.push(new URL(request.url).pathname);
      await (window as unknown as { __qbFirstLoad: (load: unknown) => Promise<void> }).__qbFirstLoad({ attemptKeys, controlled, cachedPaths });
    })();
  });
  return seen;
}

describe('a scenario begins as a first visit, whatever the one before it left in the browser', () => {
  it('leaves a device record, a cached package and a worker behind, and the next scenario on the same origin starts with none of them', async () => {
    const port = await freePort();
    await runScenario(generateScenario(20_261_026), environment, { port, evidence: false });

    const first = await watchFirstLoads(environment.chrome.current!.context);
    await runScenario(generateScenario(20_261_027), environment, { port, evidence: false });

    // later entries are the scenario's own reopens after its kills, which are not first visits; the first is
    expect(first.length).toBeGreaterThan(0);
    expect(first[0]).toEqual({ attemptKeys: [], controlled: false, cachedPaths: [] });
  });
});
