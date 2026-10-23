import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { describe, expect, it } from 'vitest';
import { RESPONSE_EVENT_KINDS, type ResponseEvent } from './response-event.js';
import { mergeIncoming, projectLog, toEngineEvent } from './response-log.js';

const ATTEMPT = '00000000-0000-4000-8000-0000000000aa';
const OTHER = '00000000-0000-4000-8000-0000000000ab';
const SLOT = '00000000-0000-4000-8000-0000000000bb';

const make = (n: number, kind: ResponseEvent['kind'], answer: ResponseEvent['answer'] = null, overrides: Partial<ResponseEvent> = {}): ResponseEvent => ({
  eventId: `${(n + 0x2000).toString(16)}-0000-4000-8000-000000000001`,
  attemptId: ATTEMPT,
  slotId: SLOT,
  itemVersionId: '00000000-0000-4000-8000-0000000000cc',
  sequence: n,
  kind,
  answer,
  clientMonotonicMs: n * 1_000,
  serverReceivedAt: '2026-10-21T08:30:00.000Z',
  deviceRef: 'd',
  afterSubmission: false,
  ...overrides,
});

describe('the mapping to the engine\'s event', () => {
  it('maps every kind in the closed vocabulary, answers where the kind carries one and nowhere else', () => {
    for (const kind of RESPONSE_EVENT_KINDS) {
      const answered = kind === 'select' || kind === 'change';
      const mapped = toEngineEvent(make(3, kind, answered ? ['a', 'b'] : null));
      expect(mapped).toMatchObject({ kind, slot: SLOT, sequence: 3, monotonicMs: 3_000, attemptId: ATTEMPT });
      expect('answer' in mapped).toBe(answered);
    }
  });

  it('leaves out what only the server knows: the pin, when it heard, whether it counted, which device', () => {
    const mapped = toEngineEvent(make(1, 'select', 'a')) as unknown as Record<string, unknown>;
    for (const field of ['itemVersionId', 'serverReceivedAt', 'afterSubmission', 'deviceRef', 'slotId', 'clientMonotonicMs']) expect(field in mapped, field).toBe(false);
  });
});

describe('merging what arrived into what is stored', () => {
  it('is an empty union for nothing stored and nothing sent', () => {
    expect(mergeIncoming(ATTEMPT, [], [])).toMatchObject({ ok: true, value: { fresh: [], unionIds: [] } });
  });

  it('refuses an id sent twice in one batch with different content, naming it', () => {
    const a = make(1, 'visit');
    const b = make(1, 'leave', null, { eventId: a.eventId });
    expect(mergeIncoming(ATTEMPT, [], [a, b])).toMatchObject({ ok: false, error: { eventId: a.eventId } });
  });

  it('refuses a stored log that does not hold together, as a conflict on the id it names', () => {
    const a = make(1, 'visit');
    expect(mergeIncoming(ATTEMPT, [a, make(1, 'leave', null, { eventId: a.eventId })], [])).toMatchObject({ ok: false, error: { code: 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT' } });
  });

  it('refuses events of another attempt, naming the attempt when no event is to blame', () => {
    const stray = make(1, 'visit', null, { attemptId: OTHER });
    const merged = mergeIncoming(ATTEMPT, [], [stray]);
    expect(merged).toMatchObject({ ok: false, error: { eventId: stray.eventId, message: `event ${stray.eventId} belongs to another attempt` } });
    // a stored event of another attempt makes the whole merge fail on identity rather than on an event
    const second = mergeIncoming(ATTEMPT, [make(2, 'visit')], [make(3, 'visit')]);
    expect(second.ok).toBe(true);
  });

  it('keeps the first copy of an id sent twice and calls the second a replay', () => {
    const a = make(1, 'visit');
    const merged = mergeIncoming(ATTEMPT, [], [a, { ...a }]);
    expect(merged).toMatchObject({ ok: true, value: { fresh: [a], unionIds: [a.eventId] } });
    if (merged.ok) expect(merged.value.replayedIds.size).toBe(0);
  });

  it('is frozen', () => {
    const merged = mergeIncoming(ATTEMPT, [], [make(1, 'visit')]);
    expect(merged.ok && Object.isFrozen(merged.value) && Object.isFrozen(merged.value.fresh) && Object.isFrozen(merged.value.unionIds)).toBe(true);
  });
});

describe('projecting a log', () => {
  const attempt = { attemptId: ATTEMPT, intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS };

  it('derives what the learner did from the events that counted, and leaves late ones out', () => {
    const events = [
      make(1, 'visit'),
      make(2, 'select', 'a'),
      make(3, 'change', 'b'),
      make(4, 'leave'),
      make(5, 'flag'),
      make(6, 'change', 'z', { afterSubmission: true }),
    ];
    const projection = projectLog(attempt, events);
    expect(projection.slots).toEqual([{ slot: SLOT, answer: 'b', answerChanges: 1, flagged: true, timeOnItemMs: 3_000 }]);
  });

  it('reads the cap from the attempt: the same log projects differently under a different cap, and the server has no other source', () => {
    const events = [make(1, 'visit'), make(100, 'leave')];
    const under = (intervalCapMs: number) => projectLog({ attemptId: ATTEMPT, intervalCapMs }, events).slots[0]?.timeOnItemMs;
    expect(under(5_000)).toBe(5_000);
    expect(under(500_000)).toBe(99_000);
    expect(projectLog.length).toBe(2);
  });

  it('gives nothing for a log with nothing that counts', () => {
    expect(projectLog(attempt, []).slots).toEqual([]);
    expect(projectLog(attempt, [make(1, 'select', 'a', { afterSubmission: true })]).slots).toEqual([]);
  });

  it('projects nothing, rather than guess, from a stored log that contradicts itself', () => {
    const a = make(1, 'select', 'a');
    expect(projectLog(attempt, [a, make(1, 'select', 'b', { eventId: a.eventId })]).slots).toEqual([]);
  });
});
