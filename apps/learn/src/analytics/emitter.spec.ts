import { clientEnvelopeSchema, findPii } from '@questionbank/contracts/analytics';
import { describe, expect, it } from 'vitest';
import { analyticsRig } from '../testing/analytics-rig.js';
import { BUFFER_KEY, MAX_BUFFERED, NO_ANALYTICS } from './emitter.js';

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('the learner app\'s analytics emitter', () => {
  it('builds an envelope the contract accepts, with the offset to the server\'s clock applied to occurred_at', async () => {
    const { analytics, sent } = analyticsRig({ offsetMs: () => 5_000 });
    analytics.emit('mock.diagnostic_viewed', { findings_shown: 2, deepest_drill_level: 0 }, { attempt_id: 'att-1' });
    await settle();
    expect(sent).toHaveLength(1);
    expect(clientEnvelopeSchema.safeParse(sent[0]).success).toBe(true);
    expect(sent[0]).toMatchObject({ event_name: 'mock.diagnostic_viewed', occurred_at: '2026-10-29T08:00:06.000Z', actor: { kind: 'human', pseudonymous_id: 'dev-3f2c9b1a' }, surface: 'web', context: { attempt_id: 'att-1' } });
  });

  it('writes the event to the device before it is sent, and removes it once the edge has answered for it', async () => {
    let release: (value: Array<{ index: number; outcome: string }>) => void = () => undefined;
    const { analytics, data } = analyticsRig({ send: () => new Promise((resolve) => (release = resolve)) });
    analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0 });
    expect(JSON.parse(data.get(BUFFER_KEY)!)).toHaveLength(1);
    release([{ index: 0, outcome: 'accepted' }]);
    await settle();
    expect(JSON.parse(data.get(BUFFER_KEY)!)).toEqual([]);
  });

  it('keeps what could not be sent, and sends it when asked again', async () => {
    let up = false;
    const sent: unknown[] = [];
    const { analytics, data } = analyticsRig({ send: async (events) => (up ? (sent.push(...events), events.map((_, index) => ({ index, outcome: 'accepted' }))) : Promise.reject(new TypeError('Failed to fetch'))) });
    analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0 });
    await settle();
    expect(JSON.parse(data.get(BUFFER_KEY)!)).toHaveLength(1);
    up = true;
    analytics.flush();
    await settle();
    expect(sent).toHaveLength(1);
    expect(JSON.parse(data.get(BUFFER_KEY)!)).toEqual([]);
  });

  it('keeps an event the edge could not write, and lets go of ones it accepted, replayed or quarantined', async () => {
    const answers = [{ index: 0, outcome: 'accepted' }, { index: 1, outcome: 'sink-unavailable' }, { index: 2, outcome: 'quarantined' }, { index: 3, outcome: 'duplicate' }];
    const { analytics, data } = analyticsRig({ send: async () => answers });
    data.set(BUFFER_KEY, JSON.stringify([0, 1, 2, 3].map((n) => ({ event_id: `event-${n}` }))));
    analytics.flush();
    await settle();
    expect(JSON.parse(data.get(BUFFER_KEY)!)).toEqual([{ event_id: 'event-1' }]);
  });

  it('cannot throw into the screen: a device that refuses the write, a send that throws at once, a source of bytes that fails', async () => {
    const refusing = { getItem: () => null, setItem: () => { throw new Error('quota'); }, removeItem: () => undefined };
    expect(() => analyticsRig({ storage: refusing }).analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0 })).not.toThrow();
    expect(() => analyticsRig({ send: () => { throw new Error('sync'); } }).analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0 })).not.toThrow();
    expect(() => analyticsRig({ random: () => { throw new Error('no entropy'); } }).analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0 })).not.toThrow();
    expect(() => NO_ANALYTICS.emit('mock.diagnostic_viewed', {})).not.toThrow();
  });

  it('does not scrub what a screen gives it, so the scan that checks what the screens emit can see a planted name', async () => {
    const { analytics, sent } = analyticsRig({}, undefined, { log: false });
    analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0, label: 'Asha Verma' });
    await settle();
    expect(findPii(sent)).toEqual([{ path: '$[0].payload.label', kind: 'free-text' }]);
  });

  it('keeps to its own key: nothing of the attempt\'s record is read or written, so a response cannot be lost to it', async () => {
    const { analytics, data } = analyticsRig();
    data.set('qb.attempt.active', 'att-1');
    data.set('qb.attempt.att-1', '{"events":[]}');
    analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0 });
    await settle();
    expect([...data.keys()].sort()).toEqual(['qb.analytics.buffer', 'qb.attempt.active', 'qb.attempt.att-1']);
    expect(data.get('qb.attempt.att-1')).toBe('{"events":[]}');
  });

  it('holds at most the last events it was given: a full buffer drops the oldest, not the newest', async () => {
    const { analytics, data } = analyticsRig({ send: () => new Promise(() => undefined) });
    for (let i = 0; i < MAX_BUFFERED + 5; i += 1) analytics.emit('mock.diagnostic_viewed', { findings_shown: i, deepest_drill_level: 0 });
    const held = JSON.parse(data.get(BUFFER_KEY)!) as Array<{ payload: { findings_shown: number } }>;
    expect(held).toHaveLength(MAX_BUFFERED);
    expect(held.at(-1)!.payload.findings_shown).toBe(MAX_BUFFERED + 4);
    expect(held[0]!.payload.findings_shown).toBe(5);
  });

  it('sends one batch at a time: a flush while one is out does nothing', async () => {
    let calls = 0;
    const { analytics } = analyticsRig({ send: () => (calls += 1, new Promise(() => undefined)) });
    analytics.emit('mock.diagnostic_viewed', { findings_shown: 1, deepest_drill_level: 0 });
    analytics.flush();
    analytics.flush();
    expect(calls).toBe(1);
  });
});
