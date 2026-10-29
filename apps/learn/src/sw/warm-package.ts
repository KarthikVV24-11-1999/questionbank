/**
 * Puts the form package and its key in the service worker's cache on a first visit (D67, DEC-M7-35).
 *
 * The worker caches them only for a page it controls, and it never takes over the page that installed it (no `skipWaiting`, no `clients.claim`: a new
 * shell must not be swapped under an attempt), so on a first visit the page's own requests went straight to the network and nothing was kept. The reopen of
 * that tab during an outage then had no paper to verify. The page knows its form; so it asks for the package once more and writes the answer into the
 * worker's cache itself, under the key the worker would have used. Nothing is verified or trusted here: the app verifies the package every time it opens
 * one, from the cache as from the network.
 *
 * Best effort and off the render path: a failure is swallowed, and nothing the learner sees depends on it.
 */
export const PACKAGE_CACHE = 'qb-package-v1';

export interface WarmPorts {
  /** Whether a worker already controlled this page when it loaded: then its own requests went through the worker and there is nothing to do. */
  readonly controlledAtLoad: boolean;
  readonly origin: string;
  readonly cacheStorage: Pick<CacheStorage, 'open'> | undefined;
  /** The page's own request, with its credentials. */
  readonly request: (path: string) => Promise<{ readonly bytes: Uint8Array; readonly headers: Headers }>;
}

export async function warmPackageCache(ports: WarmPorts, formId: string): Promise<void> {
  if (ports.controlledAtLoad || ports.cacheStorage === undefined) return;
  try {
    const cache = await ports.cacheStorage.open(PACKAGE_CACHE);
    for (const path of [`/v1/assessment/forms/${encodeURIComponent(formId)}/package`, '/v1/assessment/package-signing-key']) {
      const { bytes, headers } = await ports.request(path);
      await cache.put(new URL(path, ports.origin).href, new Response(bytes.slice().buffer as ArrayBuffer, { status: 200, headers }));
    }
  } catch {
    // best effort: the package is simply not there for an outage that comes before the next visit
  }
}
