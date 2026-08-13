import { get } from 'node:http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DATABASE_URL } from './testing/database.js';

/**
 * A keep-alive-free GET — `fetch`'s default agent reuses the TCP connection,
 * which leaves it open after the response and would block Node's own
 * `server.close()` (which waits for every open connection, idle or not)
 * forever. `Connection: close` is what lets the server's drain-then-close
 * actually complete once this one in-flight request finishes.
 */
function getWithoutKeepAlive(url: string): Promise<{ readonly status: number }> {
  return new Promise((resolvePromise, reject) => {
    const req = get(url, { headers: { Connection: 'close' } }, (res) => {
      res.resume();
      res.on('end', () => resolvePromise({ status: res.statusCode ?? 0 }));
    });
    req.on('error', reject);
  });
}

/**
 * The real process wiring, against real Postgres and a real listening
 * socket — `main()` is exercised exactly as `node dist/main.js` would call
 * it, with `process.exit` the only thing stubbed (a real exit would end the
 * test worker). `SIGTERM` is delivered with `process.emit`, not
 * `process.kill` — this triggers the same listener `process.once` registered
 * without touching the OS or this worker's own lifecycle, the standard way
 * to test a Node signal handler in-process.
 */
const PORT = 34_567;

let originalEnv: NodeJS.ProcessEnv;

beforeEach(() => {
  originalEnv = { ...process.env };
  process.env['DATABASE_URL'] = DATABASE_URL;
  process.env['AUTH_SIGNING_KEY'] = 'a'.repeat(32);
  process.env['PORT'] = String(PORT);
  process.env['NODE_ENV'] = 'test';
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
  vi.resetModules();
});

describe('main() — boot and graceful shutdown', () => {
  it('listens, serves a real request, and SIGTERM drains it before exiting 0', async () => {
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);

    const { main } = await import('./main.js');
    await main();

    // /readyz does a real round trip to Postgres — enough of an async gap
    // that the in-flight request is still open when SIGTERM is delivered a
    // tick later, which is exactly the ordering this test exists to prove.
    const responsePromise = getWithoutKeepAlive(`http://127.0.0.1:${PORT}/readyz`);
    // Lets the connection actually get accepted before shutdown begins —
    // otherwise SIGTERM can race the OS-level handshake, which would refuse
    // the connection outright rather than draining an in-flight request.
    await new Promise((r) => setTimeout(r, 20));
    process.emit('SIGTERM');

    const response = await responsePromise;
    expect(response.status).toBe(200);

    await vi.waitFor(() => {
      expect(exitSpy).toHaveBeenCalledWith(0);
    });
  });
});
