import { clientEnvelopeSchema, type ClientEnvelope } from '@questionbank/contracts/analytics';
import { describe, expect, it } from 'vitest';
import { AnalyticsEdge } from './edge.js';
import { PLATFORM_TENANT, ServerEmitter, type ServerEvent } from './server-emitter.js';
import { MemorySink } from './sink.js';

const gain: ServerEvent = {
  name: 'mastery.gain_verified',
  factKey: 'transition-1',
  occurredAt: '2026-10-04T22:00:00.000Z',
  actor: 'a3b1c2d4-5e6f-4a7b-8c9d-0e1f2a3b4c5d',
  context: { concept_identity_id: 'c1' },
  payload: { concept_identity_id: 'c1', days_to_verify: 3.5, evidence_count: 10 },
};
const rig = (observe?: (envelope: ClientEnvelope) => void) => {
  const sink = new MemorySink();
  const edge = new AnalyticsEdge(sink, () => new Date('2026-10-29T09:00:00.000Z'));
  return { sink, edge, emitter: new ServerEmitter({ edge, appVersion: 'api', ...(observe === undefined ? {} : { observe }) }) };
};

describe('the server\'s emitter', () => {
  it('builds a valid envelope for the server surface, on the platform tenant, with nominal device and network classes', async () => {
    const { sink, emitter } = rig();
    await emitter.emit(gain);
    const { received_at: _stamp, ...built } = sink.events[0]!;
    expect(clientEnvelopeSchema.safeParse(built).success).toBe(true);
    expect(built).toMatchObject({ surface: 'server', tenant_id: PLATFORM_TENANT, device_class: 'high', network_class: 'wifi', event_version: 1, app_version: 'api', actor: { kind: 'human', pseudonymous_id: gain.actor } });
  });

  it('gives the same fact the same event id, and a different fact a different one, so a redelivery is counted once', async () => {
    const { sink, edge, emitter } = rig();
    await emitter.emit(gain);
    await emitter.emit(gain);
    await emitter.emit({ ...gain, factKey: 'transition-2' });
    expect(sink.events).toHaveLength(2);
    expect(new Set(sink.events.map((event) => event.event_id)).size).toBe(2);
    expect(edge.stats().duplicates).toBe(1);
  });

  it('cannot fail the work that produced the fact: an instant it cannot build an id from is swallowed', async () => {
    const { sink, emitter } = rig();
    await expect(emitter.emit({ ...gain, occurredAt: 'not a time' })).resolves.toBeUndefined();
    expect(sink.events).toEqual([]);
  });

  it('shows an observer every envelope it built, including one the edge then refuses', async () => {
    const seen: ClientEnvelope[] = [];
    const { sink, emitter } = rig((envelope) => seen.push(envelope));
    await emitter.emit({ ...gain, actor: 'asha.verma@example.com' });
    expect(seen).toHaveLength(1);
    expect(sink.events).toEqual([]);
  });
});
