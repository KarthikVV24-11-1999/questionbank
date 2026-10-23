import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

/**
 * The service worker, run as the browser would run it: `public/sw.js` itself, in a context with a fake `self`, a fake cache store and a
 * fetch the test controls. Nothing here is a copy of its logic, so what passes is what ships.
 */
const SOURCE = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../public/sw.js'), 'utf8');
const ORIGIN = 'https://learn.example';

class FakeCache {
  readonly entries = new Map<string, Response>();
  /** The real Cache resolves a key against the worker's own location, so '/' and 'https://learn.example/' are one key. */
  private static keyOf(key: string): string {
    return new URL(key, ORIGIN).toString();
  }
  async match(key: string): Promise<Response | undefined> {
    return this.entries.get(FakeCache.keyOf(key))?.clone();
  }
  async put(key: string, response: Response): Promise<void> {
    this.entries.set(FakeCache.keyOf(key), response);
  }
  async addAll(urls: string[]): Promise<void> {
    for (const url of urls) this.entries.set(new URL(url, ORIGIN).toString(), new Response('<html>shell</html>'));
  }
}

class FakeCaches {
  readonly stores = new Map<string, FakeCache>();
  async open(name: string): Promise<FakeCache> {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache());
    return this.stores.get(name) as FakeCache;
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()];
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name);
  }
}

/** A request whose `mode` is what a browser would set; the property is a getter on the real class. */
function withMode(request: Request, mode: string): Request {
  Object.defineProperty(request, 'mode', { value: mode });
  return request;
}

function install() {
  const handlers = new Map<string, (event: unknown) => void>();
  const caches = new FakeCaches();
  const network = { online: true, status: 200, body: 'from the network', calls: [] as string[], headers: {} as Record<string, string> };
  const fetchImpl = async (request: Request): Promise<Response> => {
    network.calls.push(`${request.method} ${new URL(request.url).pathname}`);
    if (!network.online) throw new TypeError('network unreachable');
    return new Response(network.body, { status: network.status, headers: network.headers });
  };
  runInNewContext(SOURCE, { self: { addEventListener: (type: string, fn: (event: unknown) => void) => handlers.set(type, fn), location: { origin: ORIGIN } }, caches, fetch: fetchImpl, URL, Response });

  /** Offers a request to the worker: whether it chose to answer, and with what. */
  async function offer(path: string, init: { method?: string; mode?: string } = {}) {
    const request = withMode(new Request(new URL(path, ORIGIN), { method: init.method ?? 'GET' }), init.mode ?? 'cors');
    let answered: Promise<Response> | undefined;
    handlers.get('fetch')?.({ request, respondWith: (promise: Promise<Response>) => (answered = promise) });
    return answered === undefined ? { handled: false as const } : { handled: true as const, response: await answered };
  }
  const lifecycle = async (type: 'install' | 'activate') => {
    let waited: Promise<unknown> | undefined;
    handlers.get(type)?.({ waitUntil: (promise: Promise<unknown>) => (waited = promise) });
    await waited;
  };
  return { caches, network, offer, lifecycle, handlers };
}

const everythingCached = (caches: FakeCaches): string[] => [...caches.stores.values()].flatMap((cache) => [...cache.entries.keys()]);

describe('what the service worker never caches (M6-51)', () => {
  const ATTEMPT_PATHS = [
    '/v1/assessment/attempts',
    '/v1/assessment/attempts/att-1',
    '/v1/assessment/attempts/att-1/start',
    '/v1/assessment/attempts/att-1/events',
    '/v1/assessment/attempts/att-1/submission',
    '/v1/assessment/attempts/att-1/result',
  ];

  it('does not answer, and so never caches or serves, anything under the attempts — for any method', async () => {
    const worker = install();
    for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
      for (const path of ATTEMPT_PATHS) {
        const outcome = await worker.offer(path, { method });
        expect(outcome.handled, `${method} ${path}`).toBe(false);
      }
    }
    expect(everythingCached(worker.caches)).toEqual([]);
  });

  it('never serves an event from a cache, even when a copy of that very URL is sitting in one', async () => {
    const worker = install();
    const cache = await worker.caches.open('qb-package-v1');
    await cache.put(`${ORIGIN}/v1/assessment/attempts/att-1/events`, new Response('a stale answer'));
    const shell = await worker.caches.open('qb-shell-v1');
    await shell.put(`${ORIGIN}/v1/assessment/attempts/att-1/events`, new Response('a stale answer'));
    expect((await worker.offer('/v1/assessment/attempts/att-1/events', { method: 'POST' })).handled).toBe(false);
    expect((await worker.offer('/v1/assessment/attempts/att-1/events')).handled).toBe(false);
  });

  it('does not answer any other write, nor any other API path, nor another origin', async () => {
    const worker = install();
    expect((await worker.offer('/v1/assessment/forms/f1/package', { method: 'POST' })).handled).toBe(false);
    expect((await worker.offer('/v1/authoring/items/x')).handled).toBe(false);
    expect((await worker.offer('/v1/scoring/anything')).handled).toBe(false);
    expect((await worker.offer('/robots.txt')).handled).toBe(false);
    const foreign = withMode(new Request('https://elsewhere.example/assets/x.js'), 'cors');
    let answered = false;
    worker.handlers.get('fetch')?.({ request: foreign, respondWith: () => (answered = true) });
    expect(answered).toBe(false);
  });
});

describe('what it caches', () => {
  it('serves the package from the network when it can, keeping a copy with its signature headers', async () => {
    const worker = install();
    worker.network.body = 'package bytes';
    worker.network.headers = { 'x-package-signature': 'sig', 'x-package-digest': 'sha256=abc' };
    const outcome = await worker.offer('/v1/assessment/forms/f1/package');
    expect(outcome.handled && (await outcome.response.text())).toBe('package bytes');
    const stored = await (await worker.caches.open('qb-package-v1')).match(`${ORIGIN}/v1/assessment/forms/f1/package`);
    expect(stored?.headers.get('x-package-signature')).toBe('sig');
    expect(await stored?.text()).toBe('package bytes');
  });

  it('serves the last copy of a package when the network is down, or the server is failing — and says nothing is good: the app verifies it', async () => {
    const worker = install();
    worker.network.body = 'package bytes';
    await worker.offer('/v1/assessment/forms/f1/package');
    worker.network.online = false;
    const offline = await worker.offer('/v1/assessment/forms/f1/package');
    expect(offline.handled && (await offline.response.text())).toBe('package bytes');
    worker.network.online = true;
    worker.network.status = 503;
    worker.network.body = 'unavailable';
    const failing = await worker.offer('/v1/assessment/forms/f1/package');
    expect(failing.handled && (await failing.response.text())).toBe('package bytes');
  });

  it('does not hide a refusal behind a stale copy: a 4xx is the answer, and is not cached', async () => {
    const worker = install();
    worker.network.body = 'package bytes';
    await worker.offer('/v1/assessment/forms/f1/package');
    worker.network.status = 412;
    worker.network.body = 'not active';
    const refused = await worker.offer('/v1/assessment/forms/f1/package');
    expect(refused.handled && refused.response.status).toBe(412);
    expect(await (await (await worker.caches.open('qb-package-v1')).match(`${ORIGIN}/v1/assessment/forms/f1/package`))?.text()).toBe('package bytes');
  });

  it('has nothing to serve for a package it never saw, offline or failing: the failure stands', async () => {
    const worker = install();
    worker.network.online = false;
    const outcome = worker.offer('/v1/assessment/forms/f1/package');
    await expect(outcome).rejects.toThrow('network unreachable');
    worker.network.online = true;
    worker.network.status = 500;
    const failing = await worker.offer('/v1/assessment/forms/f2/package');
    expect(failing.handled && failing.response.status).toBe(500);
  });

  it('treats the public key like the package it vouches for', async () => {
    const worker = install();
    worker.network.body = '{"keyId":"k"}';
    await worker.offer('/v1/assessment/package-signing-key');
    worker.network.online = false;
    const offline = await worker.offer('/v1/assessment/package-signing-key');
    expect(offline.handled && (await offline.response.text())).toBe('{"keyId":"k"}');
  });

  it('opens the shell with no network: pages network-first, falling back to the cached page; assets cache-first', async () => {
    const worker = install();
    await worker.lifecycle('install');
    worker.network.online = false;
    const page = await worker.offer('/exam/anything', { mode: 'navigate' });
    expect(page.handled && (await page.response.text())).toBe('<html>shell</html>');

    worker.network.online = true;
    worker.network.body = 'asset v1';
    const first = await worker.offer('/assets/app-abc123.js');
    expect(first.handled && (await first.response.text())).toBe('asset v1');
    worker.network.body = 'asset v2';
    const second = await worker.offer('/assets/app-abc123.js');
    expect(second.handled && (await second.response.text())).toBe('asset v1');
    expect(worker.network.calls.filter((call) => call.endsWith('/assets/app-abc123.js'))).toHaveLength(1);
    worker.network.status = 404;
    const missing = await worker.offer('/assets/other.js');
    expect(missing.handled && missing.response.status).toBe(404);
  });

  it('takes a new shell as soon as there is a connection', async () => {
    const worker = install();
    await worker.lifecycle('install');
    worker.network.body = '<html>shell v2</html>';
    const page = await worker.offer('/', { mode: 'navigate' });
    expect(page.handled && (await page.response.text())).toBe('<html>shell v2</html>');
    worker.network.online = false;
    const offline = await worker.offer('/', { mode: 'navigate' });
    expect(offline.handled && (await offline.response.text())).toBe('<html>shell v2</html>');
  });
});

describe('a stale shell against a newer package, and the worker\'s own updates', () => {
  it('never swaps itself in under an open page: no skipWaiting, no clients.claim', () => {
    const code = SOURCE.replace(/\/\*[\s\S]*?\*\//gu, '');
    expect(code).not.toMatch(/skipWaiting|clients\.claim/u);
    expect(code).toContain('install');
  });

  it('removes its own old caches on activation and leaves other applications\' alone', async () => {
    const worker = install();
    for (const name of ['qb-shell-v0', 'qb-package-v0', 'qb-shell-v1', 'qb-package-v1', 'someone-elses']) await worker.caches.open(name);
    await worker.lifecycle('activate');
    expect([...worker.caches.stores.keys()].sort()).toEqual(['qb-package-v1', 'qb-shell-v1', 'someone-elses']);
  });
});
