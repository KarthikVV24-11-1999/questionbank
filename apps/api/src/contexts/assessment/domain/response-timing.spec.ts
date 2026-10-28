import { describe, expect, it } from 'vitest';
import { TAG, anAttempt, id } from '../../../testing/assessment-fixtures.js';
import { projectLog } from './response-log.js';
import type { ResponseEvent, ResponseEventKind } from './response-event.js';
import { responseTimings } from './response-timing.js';

const attempt = anAttempt();
const [s1, s2, s3] = attempt.slots.map((slot) => slot.slotId) as [string, string, string];

let counter = 0;
function event(slotId: string, sequence: number, kind: ResponseEventKind, receivedAt: string, extra: Partial<ResponseEvent> = {}): ResponseEvent {
  counter += 1;
  const bears = kind === 'select' || kind === 'change';
  return {
    eventId: id(TAG.event, counter),
    attemptId: attempt.attemptId,
    slotId,
    itemVersionId: attempt.slots.find((s) => s.slotId === slotId)!.itemVersionId,
    sequence,
    kind,
    answer: bears ? 'B' : null,
    clientMonotonicMs: sequence * 1000,
    serverReceivedAt: receivedAt,
    deviceRef: 'd',
    afterSubmission: false,
    ...extra,
  };
}

const at = (minute: number) => `2026-10-21T09:${String(minute).padStart(2, '0')}:00.000Z`;

describe('the instant of the response that stands', () => {
  it('is the instant of the last answer-affecting event, per slot, so slots of one attempt differ', () => {
    const timings = responseTimings(attempt, [
      event(s1, 1, 'select', at(5)),
      event(s1, 2, 'change', at(40)),
      event(s2, 3, 'select', at(12)),
    ]);
    expect(timings.map((t) => [t.slotId, t.respondedAt])).toEqual([[s1, at(40)], [s2, at(12)], [s3, null]]);
    // non-vacuity on the field two of D-002's clauses are measured on: more than one distinct instant in one attempt
    expect(new Set(timings.map((t) => t.respondedAt).filter((v) => v !== null)).size).toBeGreaterThan(1);
  });

  it('takes the instant from the server and not from the device\'s clock or the order events arrived in', () => {
    const late = event(s1, 2, 'change', at(50));
    const early = event(s1, 1, 'select', at(10));
    // arrives out of order; the canonical order (sequence, then id) decides which stands
    expect(responseTimings(attempt, [late, early])[0]!.respondedAt).toBe(at(50));
  });

  it('is null when the last answer-affecting event is a clear, or there was none', () => {
    const timings = responseTimings(attempt, [event(s1, 1, 'select', at(5)), event(s1, 2, 'clear', at(6)), event(s2, 3, 'visit', at(7)), event(s2, 4, 'flag', at(8))]);
    expect(timings.map((t) => t.respondedAt)).toEqual([null, null, null]);
  });

  it('ignores a visit, a leave and a flag after the answer, which do not change what stands', () => {
    const timings = responseTimings(attempt, [event(s1, 1, 'select', at(5)), event(s1, 2, 'leave', at(30)), event(s1, 3, 'flag', at(31)), event(s1, 4, 'unflag', at(32))]);
    expect(timings[0]!.respondedAt).toBe(at(5));
  });

  it('does not count an event that reached the server after submission: the response that stands is the one given in time', () => {
    const timings = responseTimings(attempt, [
      event(s1, 1, 'select', at(5)),
      event(s1, 2, 'change', at(59), { afterSubmission: true }),
      event(s2, 3, 'select', at(58), { afterSubmission: true }),
    ]);
    expect(timings.map((t) => t.respondedAt)).toEqual([at(5), null, null]);
  });

  it('dates a give-up by the last skip no answer followed, and only where no response stands (M7-38)', () => {
    const timings = responseTimings(attempt, [
      event(s1, 1, 'skip', at(5)),
      event(s1, 2, 'skip', at(9)),
      event(s2, 3, 'skip', at(6)),
      event(s2, 4, 'select', at(7)),
      event(s3, 5, 'select', at(8)),
      event(s3, 6, 'skip', at(9)),
    ]);
    // s1 gave up (the later skip dates it); s2 skipped and then answered, so it did not; s3 answered and then skipped, so the answer stands
    expect(timings.map((t) => [t.slotId, t.gaveUpAt, t.respondedAt])).toEqual([[s1, at(9), null], [s2, null, at(7)], [s3, null, at(8)]]);
  });

  it('carries the slot\'s time on item under the attempt\'s own cap, and zero for a slot never visited', () => {
    const cap = attempt.intervalCapMs;
    const timings = responseTimings(attempt, [
      event(s1, 1, 'visit', at(1), { clientMonotonicMs: 1_000 }),
      event(s1, 2, 'select', at(2), { clientMonotonicMs: 3_000 }),
      event(s1, 3, 'leave', at(3), { clientMonotonicMs: 1_000 + cap * 10 }),
    ]);
    expect(timings[0]!.timeOnItemMs).toBe(cap);
    expect(timings[1]!.timeOnItemMs).toBe(0);
  });

  it('says what the cap threw away for the slot it threw it from, and for no other (M7-45)', () => {
    const cap = attempt.intervalCapMs;
    const timings = responseTimings(attempt, [
      event(s1, 1, 'visit', at(1), { clientMonotonicMs: 0 }),
      event(s1, 2, 'leave', at(2), { clientMonotonicMs: cap + 9_000 }),
      event(s1, 3, 'visit', at(3), { clientMonotonicMs: cap + 20_000 }),
      event(s2, 4, 'visit', at(4), { clientMonotonicMs: 0 }),
      event(s2, 5, 'leave', at(5), { clientMonotonicMs: 1_000 }),
    ]);
    expect(timings.map((t) => [t.slotId, t.timeOnItemMs, t.truncatedIntervals, t.discardedMs, t.unclosedVisits])).toEqual([[s1, cap, 1, 9_000, 1], [s2, 1_000, 0, 0, 0], [s3, 0, 0, 0, 0]]);
  });

  it('reports every slot of the attempt in paper order, and names only identifiers, instants and durations', () => {
    const timings = responseTimings(attempt, []);
    expect(timings.map((t) => t.slotId)).toEqual(attempt.slots.map((s) => s.slotId));
    expect(Object.keys(timings[0]!).sort()).toEqual(['discardedMs', 'gaveUpAt', 'itemVersionId', 'respondedAt', 'slotId', 'timeOnItemMs', 'truncatedIntervals', 'unclosedVisits']);
    expect(Object.isFrozen(timings[0])).toBe(true);
  });
});

/**
 * Two statements of one rule drift (session rule 5). "Which event stands" is stated here, as the last of select, change and clear; the engine's
 * projection states it by folding every event. Over many generated logs, the two must agree on every slot: a standing select or change when the
 * projection has an answer, a clear or nothing when it has none.
 */
describe('which event stands agrees with the engine\'s projection', () => {
  const KINDS: ResponseEventKind[] = ['select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag', 'skip'];

  function generated(seed: number): ResponseEvent[] {
    // mulberry32: an LCG taken modulo a small number is badly correlated, and that left most logs with no answer at all
    let state = seed >>> 0;
    const next = (n: number) => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
    };
    const out: ResponseEvent[] = [];
    const slots = [s1, s2, s3];
    for (let sequence = 1; sequence <= 40; sequence += 1) {
      const kind = KINDS[next(KINDS.length)]!;
      const answer = next(3) === 0 ? ['A', 'C'] : `opt${next(4)}`;
      out.push(event(slots[next(3)]!, sequence, kind, at(next(59)), { answer: kind === 'select' || kind === 'change' ? answer : null, afterSubmission: next(8) === 0 }));
    }
    return out;
  }

  it('on 200 generated logs, a slot has a response instant exactly when the projection has an answer for it', () => {
    let withAnswer = 0;
    let without = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const events = generated(seed);
      const projected = new Map(projectLog(attempt, events).slots.map((slot) => [slot.slot, slot.answer]));
      for (const timing of responseTimings(attempt, events)) {
        const answer = projected.get(timing.slotId) ?? null;
        expect(timing.respondedAt === null, `seed ${seed} slot ${timing.slotId}`).toBe(answer === null);
        if (answer === null) without += 1;
        else withAnswer += 1;
      }
    }
    // the generator reaches both outcomes, so agreement is not agreement on one value
    expect(withAnswer).toBeGreaterThan(100);
    expect(without).toBeGreaterThan(20);
  });

  it('on the same logs, a slot has a give-up instant exactly when the projection says skipped with no answer standing', () => {
    let gaveUp = 0;
    let stayed = 0;
    for (let seed = 1; seed <= 200; seed += 1) {
      const events = generated(seed);
      const projected = new Map(projectLog(attempt, events).slots.map((slot) => [slot.slot, slot]));
      for (const timing of responseTimings(attempt, events)) {
        const slot = projected.get(timing.slotId);
        const expected = slot !== undefined && slot.skipped && slot.answer === null;
        expect(timing.gaveUpAt !== null, `seed ${seed} slot ${timing.slotId}`).toBe(expected);
        if (expected) gaveUp += 1;
        else stayed += 1;
      }
    }
    expect(gaveUp).toBeGreaterThan(20);
    expect(stayed).toBeGreaterThan(100);
  });
});
