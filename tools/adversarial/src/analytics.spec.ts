import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { clientEnvelopeSchema } from '@questionbank/contracts/analytics';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clearCarriedOver, freshChrome, newProfileDir, waitFor, type RunEnvironment } from './browser-run.js';
import { StubServer } from './stub-server.js';

/**
 * The shipped app emits what its tests say its screens emit (M7-62). The components are tested against a rig; `main.tsx` is what joins them to a real device, clock and network (the
 * actor id kept in `localStorage`, the send through the API client, the flush when the network returns, the object the screens are handed), and a wrong prop or a throwing
 * function there would leave every component test green and no event ever leaving a page. This loads the built bundle in a real Chrome, opens the report screen, and looks at
 * what reaches the analytics route.
 */
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
/** A wait for something the app does at once; a mutation that stops it should fail in seconds, not in a minute. */
const WAIT = 15_000;
const REPORT = '/?report=att-1&profile=00000000-0000-4000-8000-0000000000e1&taxonomy=00000000-0000-4000-8000-0000000000d1';

beforeAll(async () => {
  await freshChrome(environment);
});
afterAll(async () => {
  await environment.chrome.current?.close();
});

/** When the conformance run has made its marker, what the browser sent is logged beside what the suites emitted, to be replayed through the edge. */
function logForConformance(events: readonly unknown[]): void {
  const marker = join(tmpdir(), 'qb-event-log.path');
  if (!existsSync(marker)) return;
  const log = readFileSync(marker, 'utf8').trim();
  for (const event of events) appendFileSync(log, `${JSON.stringify({ source: 'browser', event })}\n`);
}

async function opened(down = false) {
  const server = new StubServer({ distDir: environment.distDir, durationMs: 3_600_000, intervalCapMs: 120_000 });
  await server.start();
  server.analyticsDown = down;
  const chrome = environment.chrome.current!;
  await clearCarriedOver(chrome.context, server.origin);
  const page = await chrome.context.newPage();
  await page.goto(`${server.origin}${REPORT}`);
  await page.getByRole('region', { name: 'Findings' }).waitFor();
  return { server, page };
}

const sentEvents = (server: StubServer, status?: number) => server.analytics.filter((request) => status === undefined || request.status === status).flatMap((request) => request.events) as Array<{ event_id: string; event_name: string; actor: { pseudonymous_id: string }; surface: string; context: Record<string, string> }>;

describe('the shipped app, in a real Chrome, opening the report screen', () => {
  it('sends the diagnostic-viewed event to the analytics route as a conforming envelope, with the actor id the device keeps', async () => {
    const { server, page } = await opened();
    try {
      await waitFor('the event reaches the analytics route', () => sentEvents(server, 202).length > 0, WAIT);
      const events = sentEvents(server, 202);
      logForConformance(events);
      for (const event of events) expect(clientEnvelopeSchema.safeParse(event).success, JSON.stringify(event)).toBe(true);
      expect(events.map((event) => event.event_name)).toEqual(['mock.diagnostic_viewed']);
      expect(events[0]).toMatchObject({ surface: 'web', context: { attempt_id: 'att-1' } });
      expect(events[0]!.actor.pseudonymous_id).toBe(await page.evaluate(() => window.localStorage.getItem('qb.analytics.actor')));
      expect(events[0]!.actor.pseudonymous_id).toMatch(/^dev-/u);
    } finally {
      await page.close();
      await server.stop();
    }
  });

  it('keeps what the edge could not take, and sends it again when the network comes back', async () => {
    const { server, page } = await opened(true);
    try {
      await waitFor('the first request is refused', () => sentEvents(server, 503).length > 0, WAIT);
      const [refused] = sentEvents(server, 503);
      expect(JSON.parse((await page.evaluate(() => window.localStorage.getItem('qb.analytics.buffer'))) ?? '[]')).toHaveLength(1);
      server.analyticsDown = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await waitFor('the same event is accepted', () => sentEvents(server, 202).some((event) => event.event_id === refused!.event_id), WAIT);
      await waitFor('the device lets go of it', async () => JSON.parse((await page.evaluate(() => window.localStorage.getItem('qb.analytics.buffer'))) ?? '[]').length === 0, WAIT);
      logForConformance(sentEvents(server, 202));
    } finally {
      await page.close();
      await server.stop();
    }
  });

  it('sends what an earlier page left unsent as soon as the next one starts, though it has nothing to say itself', async () => {
    const { server, page } = await opened(true);
    try {
      await waitFor('the first request is refused', () => sentEvents(server, 503).length > 0, WAIT);
      const [left] = sentEvents(server, 503);
      server.analyticsDown = false;
      // a page that emits nothing of its own (the home screen says nothing when it is viewed), so that only the flush as the app starts can send it
      await page.goto(`${server.origin}/?profile=00000000-0000-4000-8000-0000000000e1`);
      await waitFor('the earlier event is accepted', () => sentEvents(server, 202).some((event) => event.event_id === left!.event_id), WAIT);
      logForConformance(sentEvents(server, 202));
    } finally {
      await page.close();
      await server.stop();
    }
  });
});
