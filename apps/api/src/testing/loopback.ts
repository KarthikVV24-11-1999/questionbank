import type { INestApplication } from '@nestjs/common';

/**
 * Starts a Nest application for supertest on `127.0.0.1` and nowhere else (M7-21, D73, DEC-M7-11).
 *
 * supertest, given a server that is not listening, starts it on an ephemeral port with `listen(0)` — which binds the **wildcard** address — and then connects
 * to `127.0.0.1:<port>`. A wildcard listener and a listener on one specific address may hold the same port number at once, and a connection to the specific
 * address goes to the specific listener. So whenever the operating system handed out a port that something else on the machine already held on loopback, the
 * request never reached the application: it was answered by that other process, with whatever it answers an unknown path with. That was the intermittent
 * `404` this suite saw (a headless browser's debugging port, left running by an earlier run, answers `404` with an empty body). Bound to `127.0.0.1` itself,
 * the application takes a port nothing else holds there, and keeps it for as long as it runs.
 */
export async function serveOnLoopback(app: INestApplication): Promise<void> {
  await app.listen(0, '127.0.0.1');
}
