import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PACKAGE_CACHE, warmPackageCache, type WarmPorts } from './warm-package.js';

const FORM = 'form-1';
const ORIGIN = 'https://learn.example';

function aCache() {
  const entries = new Map<string, Response>();
  return { entries, store: { open: async () => ({ put: async (url: string, response: Response) => void entries.set(url, response) }) as unknown as Cache } };
}
const ports = (over: Partial<WarmPorts> = {}): WarmPorts => ({
  controlledAtLoad: false,
  origin: ORIGIN,
  cacheStorage: aCache().store,
  request: async () => ({ bytes: new Uint8Array([1, 2, 3]), headers: new Headers({ 'x-package-signature': 'sig' }) }),
  ...over,
});

describe('warming the package cache on a first visit', () => {
  it('writes the package and the key under the keys the worker looks them up by, with the signature headers intact', async () => {
    const cache = aCache();
    await warmPackageCache(ports({ cacheStorage: cache.store }), FORM);
    expect([...cache.entries.keys()]).toEqual([`${ORIGIN}/v1/assessment/forms/${FORM}/package`, `${ORIGIN}/v1/assessment/package-signing-key`]);
    const stored = cache.entries.get(`${ORIGIN}/v1/assessment/forms/${FORM}/package`)!;
    expect(stored.headers.get('x-package-signature')).toBe('sig');
    expect([...new Uint8Array(await stored.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it('does nothing when a worker already controlled the page: its own requests went through the worker', async () => {
    const cache = aCache();
    let asked = 0;
    await warmPackageCache(ports({ controlledAtLoad: true, cacheStorage: cache.store, request: async () => (asked += 1, { bytes: new Uint8Array(), headers: new Headers() }) }), FORM);
    expect(asked).toBe(0);
    expect(cache.entries.size).toBe(0);
  });

  it('swallows a failed request and keeps nothing half-written for the package that failed', async () => {
    const cache = aCache();
    await expect(warmPackageCache(ports({ cacheStorage: cache.store, request: async () => Promise.reject(new TypeError('Failed to fetch')) }), FORM)).resolves.toBeUndefined();
    expect(cache.entries.size).toBe(0);
  });

  it('writes into the cache the worker reads from: the names are the same', () => {
    const worker = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../public/sw.js'), 'utf8');
    expect(worker).toContain(`const PACKAGE_CACHE = '${PACKAGE_CACHE}';`);
  });
});
