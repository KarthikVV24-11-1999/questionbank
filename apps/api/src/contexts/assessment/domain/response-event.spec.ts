import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, anAttempt, id } from '../../../testing/assessment-fixtures.js';
import { abandonAttempt, startAttempt, submitAttempt, type Attempt } from './attempt.js';
import {
  RESPONSE_EVENT_KINDS,
  acceptResponseEvent,
  scoredEvents,
  type ResponseEventDraft,
  type ResponseEventKind,
} from './response-event.js';

const NOW = '2026-10-21T09:05:00.000Z';
const live = (): Attempt => expectValue(startAttempt(anAttempt(), '2026-10-21T09:00:00.000Z'));

function draft(overrides: Partial<ResponseEventDraft> = {}): ResponseEventDraft {
  return {
    eventId: id(TAG.event, 1),
    attemptId: id(TAG.attempt),
    slotId: id(TAG.slot, 2),
    sequence: 5,
    kind: 'select',
    answer: 'B',
    clientMonotonicMs: 120_000,
    deviceRef: 'phone-1',
    ...overrides,
  };
}

describe('the vocabulary', () => {
  it('is the same closed seven the device engine captures', () => {
    expect([...RESPONSE_EVENT_KINDS]).toEqual(['select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag']);
  });
});

describe('§12 — what is pinned on every response', () => {
  it('pins the item VERSION from the attempt\'s slot, never from the device', () => {
    const event = expectValue(acceptResponseEvent(live(), draft(), NOW));
    expect(event.itemVersionId).toBe(id(TAG.itemVersion, 2));
    expect(event.itemVersionId).not.toBe(id(TAG.item, 2));
  });

  it('a device claiming a different version is not believed: the draft has no such field, and a stray one is ignored', () => {
    const lying = { ...draft(), itemVersionId: id(TAG.itemVersion, 99) } as ResponseEventDraft;
    expect(expectValue(acceptResponseEvent(live(), lying, NOW)).itemVersionId).toBe(id(TAG.itemVersion, 2));
  });

  it('carries the timing, the device and the server\'s receipt time', () => {
    const event = expectValue(acceptResponseEvent(live(), draft(), NOW));
    expect(event.clientMonotonicMs).toBe(120_000);
    expect(event.deviceRef).toBe('phone-1');
    expect(event.serverReceivedAt).toBe(NOW);
    expect(event.slotId).toBe(id(TAG.slot, 2));
    expect(event.sequence).toBe(5);
  });

  it('keeps every change of answer as its own event: nothing collapses a run of edits', () => {
    const events = [1, 2, 3].map((n) =>
      expectValue(acceptResponseEvent(live(), draft({ eventId: id(TAG.event, n), sequence: n, kind: 'change', answer: `opt${n}` }), NOW)),
    );
    expect(events.map((e) => e.answer)).toEqual(['opt1', 'opt2', 'opt3']);
  });

  it('is frozen, including a multi-option answer', () => {
    const event = expectValue(acceptResponseEvent(live(), draft({ answer: ['A', 'C'] }), NOW));
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.answer)).toBe(true);
    expect(event.answer).toEqual(['A', 'C']);
  });
});

describe('which attempts hear a response, and whether it counts', () => {
  const abandoned = () => expectValue(abandonAttempt(anAttempt(), '2026-10-21T12:00:00.000Z', 0));
  const submitted = () => expectValue(submitAttempt(live(), { reason: 'manual', idempotencyKey: 'k' }, NOW));

  it('records and counts an event for an in-progress attempt', () => {
    expect(expectValue(acceptResponseEvent(live(), draft(), NOW)).afterSubmission).toBe(false);
  });

  it('records but flags an event arriving after submission, so scoring can leave it out', () => {
    const event = expectValue(acceptResponseEvent(submitted(), draft(), NOW));
    expect(event.afterSubmission).toBe(true);
  });

  it('refuses an event for a created attempt and for an abandoned one', () => {
    for (const attempt of [anAttempt(), abandoned()]) {
      const error = expectError(acceptResponseEvent(attempt, draft(), NOW));
      expect(error.code).toBe('ATTEMPT_NOT_ACCEPTING_RESPONSES');
      expect(error.kind).toBe('RuleViolation');
    }
  });

  it('scoring sees the events that arrived in time and not the ones that did not', () => {
    const early = expectValue(acceptResponseEvent(live(), draft({ eventId: id(TAG.event, 1) }), NOW));
    const late = expectValue(acceptResponseEvent(submitted(), draft({ eventId: id(TAG.event, 2) }), NOW));
    expect(scoredEvents([early, late]).map((e) => e.eventId)).toEqual([early.eventId]);
    expect([early, late]).toHaveLength(2);
  });
});

describe('refusals', () => {
  const CASES: readonly (readonly [string, Partial<ResponseEventDraft>, string])[] = [
    ['a bad event id', { eventId: 'nope' }, 'EVENT_ID_INVALID'],
    ['an event for another attempt', { attemptId: id(TAG.attempt, 9) }, 'EVENT_ATTEMPT_MISMATCH'],
    ['a slot the attempt does not have', { slotId: id(TAG.slot, 99) }, 'EVENT_SLOT_NOT_IN_ATTEMPT'],
    ['a negative sequence', { sequence: -1 }, 'EVENT_SEQUENCE_INVALID'],
    ['a fractional sequence', { sequence: 1.5 }, 'EVENT_SEQUENCE_INVALID'],
    ['an unknown kind', { kind: 'peek' as ResponseEventKind }, 'EVENT_KIND_INVALID'],
    ['a select with no answer', { answer: null }, 'EVENT_ANSWER_INVALID'],
    ['a select with an empty option list', { answer: [] }, 'EVENT_ANSWER_INVALID'],
    ['a select with a blank answer', { answer: '' }, 'EVENT_ANSWER_INVALID'],
    ['a select with a non-finite number', { answer: Number.NaN }, 'EVENT_ANSWER_INVALID'],
    ['a clear that carries an answer', { kind: 'clear', answer: 'A' }, 'EVENT_ANSWER_INVALID'],
    ['no timing (§12)', { clientMonotonicMs: -5 }, 'EVENT_TIMING_INVALID'],
    ['a fractional timing', { clientMonotonicMs: 0.5 }, 'EVENT_TIMING_INVALID'],
    ['an unnamed device', { deviceRef: '  ' }, 'EVENT_DEVICE_INVALID'],
  ];

  it.each(CASES)('refuses %s', (_name, overrides, code) => {
    expect(expectError(acceptResponseEvent(live(), draft(overrides), NOW)).code).toBe(code);
  });

  it('refuses a malformed receipt time', () => {
    expect(expectError(acceptResponseEvent(live(), draft(), 'now')).code).toBe('EVENT_RECEIVED_AT_INVALID');
  });

  it('accepts a number answer, a multi-option answer, and every answer-free kind', () => {
    expect(expectValue(acceptResponseEvent(live(), draft({ answer: 42 }), NOW)).answer).toBe(42);
    for (const kind of ['clear', 'visit', 'leave', 'flag', 'unflag'] as const) {
      const { answer: _ignored, ...bare } = draft({ kind });
      expect(expectValue(acceptResponseEvent(live(), bare, NOW)).answer).toBeNull();
    }
    expect(expectValue(acceptResponseEvent(live(), draft({ kind: 'clear', answer: null }), NOW)).answer).toBeNull();
  });
});
