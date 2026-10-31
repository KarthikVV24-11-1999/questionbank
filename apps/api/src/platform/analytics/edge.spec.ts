import { describe, expect, it } from 'vitest';
import { aServerEnvelope, anEnvelope, PLANTED_PII } from '../../testing/analytics-fixtures.js';
import { AnalyticsEdge, type Quarantined } from './edge.js';
import { MemorySink } from './sink.js';

const NOW = new Date('2026-10-29T09:30:00.000Z');
const edgeOver = (sink = new MemorySink()) => {
  const alerts: Quarantined[] = [];
  return { sink, alerts, edge: new AnalyticsEdge(sink, () => NOW, (entry) => alerts.push(entry)) };
};

describe('the ingestion edge admits an event with a complete valid envelope and a catalog name', () => {
  it('writes it with the moment of ingestion stamped, and counts it', async () => {
    const { sink, edge } = edgeOver();
    const event = anEnvelope();
    const result = await edge.admit(event);
    expect(result.outcome).toBe('accepted');
    expect(sink.events).toEqual([{ ...event, received_at: '2026-10-29T09:30:00.000Z' }]);
    expect(edge.stats()).toMatchObject({ received: 1, accepted: 1, duplicates: 0, sinkFailures: 0 });
  });

  it('does not write an event it has admitted before: the second is a duplicate, counted and not stored', async () => {
    const { sink, edge } = edgeOver();
    const event = anEnvelope();
    await edge.admit(event);
    expect((await edge.admit(event)).outcome).toBe('duplicate');
    expect(sink.events).toHaveLength(1);
    expect(edge.stats()).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it('says so when it could not write, counts it, and admits the same event when it is sent again', async () => {
    let down = true;
    const sink = new MemorySink();
    const edge = new AnalyticsEdge({ write: async (event) => (down ? Promise.reject(new Error('disk')) : sink.write(event)) }, () => NOW);
    const event = anEnvelope();
    expect((await edge.admit(event)).outcome).toBe('sink-unavailable');
    down = false;
    expect((await edge.admit(event)).outcome).toBe('accepted');
    expect(edge.stats()).toMatchObject({ sinkFailures: 1, accepted: 1, duplicates: 0 });
  });
});

describe('the ingestion edge holds the device and network classes to the surface (§1)', () => {
  it('admits a server or worker envelope with neither class, and a device envelope with both', async () => {
    const { sink, edge } = edgeOver();
    for (const event of [aServerEnvelope(), aServerEnvelope({ surface: 'worker' }), anEnvelope(), anEnvelope({ surface: 'android' })]) expect((await edge.admit(event)).outcome).toBe('accepted');
    expect(sink.events).toHaveLength(4);
  });

  it.each([
    ['server', 'device_class', 'low'],
    ['server', 'network_class', 'offline'],
    ['worker', 'device_class', 'high'],
  ] as const)('refuses a %s envelope that carries a %s, because a server has neither and a value would be false', async (surface, field, value) => {
    const { sink, edge } = edgeOver();
    expect(await edge.admit({ ...aServerEnvelope({ surface }), [field]: value })).toEqual({ outcome: 'quarantined', reason: 'INVALID_ENVELOPE' });
    expect(sink.events).toEqual([]);
  });

  it.each(['device_class', 'network_class'] as const)('refuses a device envelope with no %s: the event cannot be placed in a segment', async (field) => {
    const { sink, edge } = edgeOver();
    const event = { ...anEnvelope() } as Record<string, unknown>;
    delete event[field];
    expect(await edge.admit(event)).toEqual({ outcome: 'quarantined', reason: 'INVALID_ENVELOPE' });
    expect(sink.events).toEqual([]);
  });
});

describe('the ingestion edge remembers the events it has admitted, for a while', () => {
  it('forgets the oldest id once its window is full, so a very old retry is admitted again and a recent one is still a duplicate', async () => {
    const edge = new AnalyticsEdge(new MemorySink(), () => NOW, () => undefined, 2);
    const [first, second, third] = [anEnvelope(), anEnvelope(), anEnvelope()];
    for (const event of [first, second, third]) await edge.admit(event);
    expect((await edge.admit(third)).outcome).toBe('duplicate');
    expect((await edge.admit(first)).outcome).toBe('accepted');
  });
});

describe('the ingestion edge quarantines what it refuses, with the reason, and never drops it silently (§1 rule 3)', () => {
  it('refuses a name that is not in the catalog', async () => {
    const { sink, edge, alerts } = edgeOver();
    const result = await edge.admit({ ...anEnvelope(), event_name: 'ad_hoc.thing_clicked' });
    expect(result).toEqual({ outcome: 'quarantined', reason: 'UNKNOWN_EVENT_NAME' });
    expect(sink.events).toEqual([]);
    expect(edge.stats().quarantined).toEqual({ UNKNOWN_EVENT_NAME: 1, INVALID_ENVELOPE: 0, PII: 0 });
    expect(alerts).toMatchObject([{ reason: 'UNKNOWN_EVENT_NAME', eventName: null }]);
  });

  it.each([
    ['a field missing', (e: Record<string, unknown>) => delete e['session_id']],
    ['an event id that is not a UUIDv7', (e: Record<string, unknown>) => (e['event_id'] = '123e4567-e89b-42d3-a456-426614174000')],
    ['a surface that does not exist', (e: Record<string, unknown>) => (e['surface'] = 'toaster')],
    ['a field the envelope does not have', (e: Record<string, unknown>) => (e['colour'] = 'red')],
    ['a time that is not a time', (e: Record<string, unknown>) => (e['occurred_at'] = 'yesterday')],
    ['an actor with no pseudonymous id', (e: Record<string, unknown>) => (e['actor'] = { kind: 'human' })],
  ])('refuses an envelope with %s', async (_label, damage) => {
    const { sink, edge } = edgeOver();
    const event = { ...anEnvelope() } as Record<string, unknown>;
    damage(event);
    expect(await edge.admit(event)).toEqual({ outcome: 'quarantined', reason: 'INVALID_ENVELOPE' });
    expect(sink.events).toEqual([]);
    expect(edge.quarantined()).toHaveLength(1);
    expect(edge.quarantined()[0]!.issues.length).toBeGreaterThan(0);
  });

  it('refuses what is not an object at all, and counts it', async () => {
    const { edge } = edgeOver();
    for (const raw of [null, 'event', 42, []]) expect((await edge.admit(raw)).outcome).toBe('quarantined');
    expect(edge.stats().quarantined.INVALID_ENVELOPE).toBe(4);
  });

  it('refuses personal data in any field, and keeps the path and the kind of what it found but not the value', async () => {
    const { sink, edge } = edgeOver();
    const planted = anEnvelope({ payload: { findings_shown: 1, contact: PLANTED_PII.email } });
    expect(await edge.admit(planted)).toEqual({ outcome: 'quarantined', reason: 'PII' });
    expect(sink.events).toEqual([]);
    const kept = JSON.stringify(edge.quarantined());
    expect(kept).toContain('$.payload.contact: email');
    expect(kept).not.toContain(PLANTED_PII.email);
  });
});
