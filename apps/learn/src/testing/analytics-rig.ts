import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clientEnvelopeSchema, type ClientEnvelope } from '@questionbank/contracts/analytics';
import { expect } from 'vitest';
import { createAnalytics, type AnalyticsPorts } from '../analytics/emitter.js';

/**
 * A real emitter over a device that is a map, with every event it sends kept. When `qb-event-log.path` exists in the temp directory and names a file (the conformance run makes it), each event is also appended to it, one line of
 * JSON: that is how the conformance measurement (M7-63) learns what was emitted in a real run of this suite, to replay it through the API's edge.
 */
/** Every event is a complete valid envelope of a catalog name: what the ingestion edge will admit. */
export function expectConforming(events: readonly ClientEnvelope[]): void {
  for (const event of events) expect(clientEnvelopeSchema.safeParse(event).success, event.event_name).toBe(true);
}

/** `log: false` for a test that plants a bad event on purpose: it is a test input made to be refused, not something the app emitted, and does not belong in the denominator. */
export function analyticsRig(over: Partial<AnalyticsPorts> = {}, startAt = '2026-10-29T08:00:00.000Z', options: { readonly log?: boolean } = {}) {
  const data = new Map<string, string>();
  const sent: ClientEnvelope[] = [];
  let tick = 0;
  let bytes = 0;
  const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => void data.set(key, value), removeItem: (key: string) => void data.delete(key) };
  const analytics = createAnalytics({
    storage,
    nowMs: () => Date.parse(startAt) + (tick += 1000),
    offsetMs: () => 0,
    random: () => new Uint8Array(10).fill((bytes += 1) % 256),
    send: async (events) => {
      sent.push(...events);
      const marker = join(tmpdir(), 'qb-event-log.path');
      const log = existsSync(marker) ? readFileSync(marker, 'utf8').trim() : undefined;
      if (log !== undefined && options.log !== false) for (const event of events) appendFileSync(log, `${JSON.stringify({ source: 'learn', event })}\n`);
      return events.map((_, index) => ({ index, outcome: 'accepted' }));
    },
    identity: { pseudonymousId: 'dev-3f2c9b1a', sessionId: 'ses-9c1d4e7f', appVersion: '0.7.0', tenantId: '00000000-0000-0000-0000-000000000000', surface: 'web', deviceClass: () => 'mid', networkClass: () => '4g' },
    ...over,
  });
  return { analytics, sent, data, storage };
}

/** One complete valid envelope, for a test that needs something to send. */
export function anEnvelopeForTest(): ClientEnvelope {
  return {
    event_id: '0192a000-0000-7000-8000-000000000001',
    event_name: 'mock.diagnostic_viewed',
    event_version: 1,
    occurred_at: '2026-10-29T08:00:00.000Z',
    actor: { kind: 'human', pseudonymous_id: 'dev-3f2c9b1a' },
    session_id: 'ses-9c1d4e7f',
    surface: 'web',
    app_version: '0.7.0',
    device_class: 'mid',
    network_class: '4g',
    tenant_id: '00000000-0000-0000-0000-000000000000',
    context: {},
    payload: { findings_shown: 1, deepest_drill_level: 0 },
  };
}
