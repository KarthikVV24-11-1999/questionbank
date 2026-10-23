/*
 * The service worker (M6-51). Plain JavaScript on purpose: the file the browser runs is the file the spec runs.
 *
 * WHAT IT CACHES
 *   - The shell: the page and its hashed assets (`/assets/…`), so the app opens with no network. Pages are fetched network-first (a new
 *     shell arrives as soon as there is a connection) and fall back to the cached page; hashed assets never change, so they are cache-first.
 *   - The form package and the public key that verifies it, network-first, falling back to the last copy when the network is down or the
 *     server is failing (5xx). The cached bytes keep their signature headers, and the app verifies them every time it opens them, from the
 *     cache as from the network: this worker never decides a package is good.
 *
 * WHAT IT NEVER CACHES, and never serves from a cache
 *   - Anything under `/v1/assessment/attempts` — creating, starting, reading, the events, the submission, the result — for any method. The
 *     worker does not even answer these: it does not call `respondWith`, so the browser goes to the network and a failure is a failure,
 *     which is what the app's own queue is for. An event served from a cache would be an event the server never heard.
 *   - Every request that is not a GET.
 *   - Every other API path.
 *
 * THE SHELL AND THE PACKAGE CAN DISAGREE. This worker never takes over a page that is already open (no `skipWaiting`, no `clients.claim`):
 * a new shell waits until the tabs of the old one close, so an attempt in progress is never swapped under the learner. A package in a
 * format the open shell does not understand is refused by the app, which says to reload and asks the registration to look for a new shell.
 */
const SHELL_CACHE = 'qb-shell-v1';
const PACKAGE_CACHE = 'qb-package-v1';
const CURRENT_CACHES = [SHELL_CACHE, PACKAGE_CACHE];

const NEVER_CACHED = /^\/v1\/assessment\/attempts(\/|$)/u;
const PACKAGE_ROUTE = /^\/v1\/assessment\/forms\/[^/]+\/package$/u;
const KEY_ROUTE = /^\/v1\/assessment\/package-signing-key$/u;
const ASSET = /^\/assets\//u;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(['/'])));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => Promise.all(names.filter((name) => name.startsWith('qb-') && !CURRENT_CACHES.includes(name)).map((name) => caches.delete(name)))),
  );
});

async function networkFirst(request, cacheName, fallbackKey) {
  const cache = await caches.open(cacheName);
  const key = fallbackKey === undefined ? request.url : fallbackKey;
  let response;
  try {
    response = await fetch(request);
  } catch (error) {
    const cached = await cache.match(key);
    if (cached !== undefined) return cached;
    throw error;
  }
  if (response.ok) {
    await cache.put(key, response.clone());
    return response;
  }
  if (response.status >= 500) {
    const cached = await cache.match(key);
    if (cached !== undefined) return cached;
  }
  return response;
}

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request.url);
  if (cached !== undefined) return cached;
  const response = await fetch(request);
  if (response.ok) await cache.put(request.url, response.clone());
  return response;
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (NEVER_CACHED.test(url.pathname)) return;
  if (request.method !== 'GET') return;

  if (PACKAGE_ROUTE.test(url.pathname) || KEY_ROUTE.test(url.pathname)) {
    event.respondWith(networkFirst(request, PACKAGE_CACHE));
  } else if (request.mode === 'navigate') {
    event.respondWith(networkFirst(request, SHELL_CACHE, '/'));
  } else if (ASSET.test(url.pathname)) {
    event.respondWith(cacheFirst(request, SHELL_CACHE));
  }
});
