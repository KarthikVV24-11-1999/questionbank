import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshChrome, newProfileDir, waitFor, type RunEnvironment } from './browser-run.js';
import { StubServer } from './stub-server.js';

/**
 * The service worker in the browser that will run it (M6-51, which was only ever run in a `vm`): registered, in control of the page
 * after a reload, holding the shell and the package, serving the package when the server is failing — and never answering an attempt
 * request from a cache, whatever the server is doing.
 */
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
const FORM = '00000000-0000-4000-8000-0000000000f1';

beforeAll(async () => {
  await freshChrome(environment);
});
afterAll(async () => {
  await environment.chrome.current?.close();
});

describe('the service worker, in Chrome', () => {
  it('controls the page after a reload, caches the shell and the package, and never an attempt request', async () => {
    const server = new StubServer({ distDir: environment.distDir, durationMs: 3_600_000, intervalCapMs: 120_000 });
    await server.start();
    const page = await environment.chrome.current!.context.newPage();
    try {
      await page.goto(`${server.origin}/?form=${FORM}&session=2026-01-27/shift-1`);
      await page.getByRole('region', { name: 'Question 1' }).waitFor();
      await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
      await page.getByRole('radio', { name: /^Option A$/iu }).check();

      await page.reload();
      await page.getByRole('region', { name: 'Question 1' }).waitFor();
      expect(await page.evaluate(() => navigator.serviceWorker.controller !== null)).toBe(true);

      const cachedPaths = async (): Promise<string[]> =>
        page.evaluate(async () => {
          const urls: string[] = [];
          for (const name of await caches.keys()) for (const request of await (await caches.open(name)).keys()) urls.push(new URL(request.url).pathname);
          return urls;
        });
      await waitFor('the package and its key are cached', async () => {
        const paths = await cachedPaths();
        return paths.includes(`/v1/assessment/forms/${FORM}/package`) && paths.includes('/v1/assessment/package-signing-key') && paths.includes('/');
      });

      // the server is failing: the package still comes, with its signature headers; an attempt request is the server's failure, not a copy
      server.outage = '503';
      const answers = await page.evaluate(async (form) => {
        const pkg = await fetch(`/v1/assessment/forms/${form}/package`);
        const events = await fetch('/v1/assessment/attempts/anything/events', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"deviceRef":"d","events":[]}' });
        const attempt = await fetch('/v1/assessment/attempts/anything');
        return { pkg: pkg.status, signature: pkg.headers.get('x-package-signature') !== null, events: events.status, attempt: attempt.status };
      }, FORM);
      expect(answers).toEqual({ pkg: 200, signature: true, events: 503, attempt: 503 });
      expect((await cachedPaths()).filter((path) => path.startsWith('/v1/assessment/attempts'))).toEqual([]);
    } finally {
      await page.close();
      await server.stop();
    }
  });
});
