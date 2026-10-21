import { describe, expect, it } from 'vitest';
import { projectResponses, type Projection, type ProjectionOptions } from './projection.js';
import type { ResponseAnswer, ResponseEvent, ResponseEventKind } from './response-event.js';
import { randomEvents, seeded, shuffled } from './testing/generators.js';

const OPTIONS = { intervalCapMs: 60_000 };
let counter = 0;

function ev(kind: ResponseEventKind, sequence: number, extra: { slot?: string; at?: number; answer?: ResponseAnswer; id?: string } = {}): ResponseEvent {
  counter += 1;
  const base = {
    eventId: extra.id ?? `e${counter}`,
    attemptId: 'a1',
    slot: extra.slot ?? 'q1',
    sequence,
    monotonicMs: extra.at ?? sequence * 1000,
  };
  return kind === 'select' || kind === 'change' ? { ...base, kind, answer: extra.answer ?? 'A' } : { ...base, kind };
}

const only = (events: readonly ResponseEvent[], options: ProjectionOptions = OPTIONS) => projectResponses(events, options).slots[0];

describe('current answer', () => {
  it('is nothing when the slot was only visited', () => {
    expect(only([ev('visit', 1)])?.answer).toBeNull();
  });

  it('is the last select or change', () => {
    expect(only([ev('select', 1, { answer: 'A' }), ev('change', 2, { answer: 'B' }), ev('change', 3, { answer: 'C' })])?.answer).toBe('C');
    expect(only([ev('change', 1, { answer: 'B' })])?.answer).toBe('B');
  });

  it('is cleared by a later clear, including after a change', () => {
    expect(only([ev('select', 1), ev('clear', 2)])?.answer).toBeNull();
    expect(only([ev('select', 1), ev('change', 2, { answer: 'B' }), ev('clear', 3)])?.answer).toBeNull();
  });

  it('is restored by a select after a clear', () => {
    expect(only([ev('select', 1), ev('clear', 2), ev('select', 3, { answer: 'D' })])?.answer).toBe('D');
  });

  it('keeps a multi-option answer as given', () => {
    expect(only([ev('select', 1, { answer: ['A', 'C'] })])?.answer).toEqual(['A', 'C']);
  });

  it('is ordered by client sequence, not by position in the input', () => {
    const events = [ev('change', 3, { answer: 'C' }), ev('select', 1, { answer: 'A' }), ev('change', 2, { answer: 'B' })];
    expect(only(events)?.answer).toBe('C');
  });

  it('breaks a sequence tie by event id, the same way whatever the input order', () => {
    const x = ev('select', 1, { answer: 'X', id: 'a' });
    const y = ev('select', 1, { answer: 'Y', id: 'b' });
    expect(only([x, y])?.answer).toBe('Y');
    expect(only([y, x])?.answer).toBe('Y');
  });
});

describe('answer changes', () => {
  it('counts change events and not selects', () => {
    expect(only([ev('select', 1), ev('change', 2), ev('change', 3)])?.answerChanges).toBe(2);
    expect(only([ev('select', 1)])?.answerChanges).toBe(0);
  });

  it('still counts a change that a later clear superseded', () => {
    expect(only([ev('select', 1), ev('change', 2), ev('clear', 3)])?.answerChanges).toBe(1);
  });
});

describe('flag state', () => {
  it('is the last flag or unflag', () => {
    expect(only([ev('flag', 1)])?.flagged).toBe(true);
    expect(only([ev('flag', 1), ev('unflag', 2)])?.flagged).toBe(false);
    expect(only([ev('flag', 1), ev('unflag', 2), ev('flag', 3)])?.flagged).toBe(true);
    expect(only([ev('select', 1)])?.flagged).toBe(false);
  });
});

describe('time on item', () => {
  it('sums visit to leave intervals', () => {
    const events = [ev('visit', 1, { at: 1000 }), ev('leave', 2, { at: 4000 }), ev('visit', 3, { at: 10_000 }), ev('leave', 4, { at: 12_000 })];
    expect(only(events)?.timeOnItemMs).toBe(5000);
  });

  it('caps each interval, so backgrounded time is discarded', () => {
    const events = [ev('visit', 1, { at: 0 }), ev('leave', 2, { at: 600_000 }), ev('visit', 3, { at: 700_000 }), ev('leave', 4, { at: 710_000 })];
    expect(only(events, { intervalCapMs: 60_000 })?.timeOnItemMs).toBe(70_000);
    expect(only(events, { intervalCapMs: 5_000 })?.timeOnItemMs).toBe(10_000);
  });

  it('counts an interval exactly at the cap in full', () => {
    expect(only([ev('visit', 1, { at: 0 }), ev('leave', 2, { at: 60_000 })])?.timeOnItemMs).toBe(60_000);
  });

  it('ignores a leave with no visit', () => {
    expect(only([ev('leave', 1, { at: 5000 })])?.timeOnItemMs).toBe(0);
    expect(only([ev('visit', 1, { at: 0 }), ev('leave', 2, { at: 1000 }), ev('leave', 3, { at: 9000 })])?.timeOnItemMs).toBe(1000);
  });

  it('counts a visit never closed as nothing', () => {
    expect(only([ev('visit', 1, { at: 0 })])?.timeOnItemMs).toBe(0);
  });

  it('drops an unclosed visit when another visit begins, rather than inventing its length', () => {
    const events = [ev('visit', 1, { at: 0 }), ev('visit', 2, { at: 50_000 }), ev('leave', 3, { at: 52_000 })];
    expect(only(events)?.timeOnItemMs).toBe(2000);
  });

  it('never goes negative if monotonic readings are handed in backwards', () => {
    expect(only([ev('visit', 1, { at: 9000 }), ev('leave', 2, { at: 1000 })])?.timeOnItemMs).toBe(0);
  });

  it('is kept per slot: a leave closes only its own slot', () => {
    const events = [ev('visit', 1, { slot: 'q1', at: 0 }), ev('visit', 2, { slot: 'q2', at: 1000 }), ev('leave', 3, { slot: 'q2', at: 3000 }), ev('leave', 4, { slot: 'q1', at: 5000 })];
    const { slots } = projectResponses(events, OPTIONS);
    expect(slots.map((s) => [s.slot, s.timeOnItemMs])).toEqual([['q1', 5000], ['q2', 2000]]);
  });
});

describe('the projection as a whole', () => {
  it('is empty for an empty log', () => {
    expect(projectResponses([], OPTIONS)).toEqual({ slots: [] });
  });

  it('lists every slot mentioned, ordered by slot id', () => {
    const { slots } = projectResponses([ev('select', 1, { slot: 'q2' }), ev('flag', 2, { slot: 'q10' }), ev('visit', 3, { slot: 'q1' })], OPTIONS);
    expect(slots.map((s) => s.slot)).toEqual(['q1', 'q10', 'q2']);
  });

  it('ignores a duplicate event id', () => {
    const e = ev('change', 2);
    expect(only([ev('select', 1), e, e])?.answerChanges).toBe(1);
  });

  it('projects only the included event ids when given a set', () => {
    const a = ev('select', 1, { answer: 'A' });
    const b = ev('change', 2, { answer: 'B' });
    expect(only([a, b], { ...OPTIONS, includeEventIds: new Set([a.eventId]) })?.answer).toBe('A');
    expect(projectResponses([a, b], { ...OPTIONS, includeEventIds: new Set() })).toEqual({ slots: [] });
  });
});

type Projector = (events: readonly ResponseEvent[], options: ProjectionOptions) => Projection;

/** True when every shuffle of every generated log projects identically. */
function isDeterministic(project: Projector): boolean {
  for (let seed = 1; seed <= 200; seed += 1) {
    const random = seeded(seed);
    const events = randomEvents(random, { count: 40 });
    const expected = JSON.stringify(project(events, OPTIONS));
    for (let round = 0; round < 3; round += 1) {
      if (JSON.stringify(project(shuffled(events, random), OPTIONS)) !== expected) return false;
    }
    if (JSON.stringify(project(shuffled([...events, ...events.slice(0, 10)], random), OPTIONS)) !== expected) return false;
  }
  return true;
}

/** Planted violation: trusts the order events arrive in instead of the client sequence. */
const arrivalOrderProjection: Projector = (events) => {
  const answers = new Map<string, ResponseAnswer | null>();
  for (const event of events) {
    if (event.kind === 'select' || event.kind === 'change') answers.set(event.slot, event.answer);
    if (event.kind === 'clear') answers.set(event.slot, null);
  }
  return {
    slots: [...answers.keys()].sort().map((slot) => ({
      slot,
      answer: answers.get(slot) ?? null,
      answerChanges: 0,
      flagged: false,
      timeOnItemMs: 0,
    })),
  };
};

describe('determinism — the load-bearing property', () => {
  it('projects a shuffled but equivalent log to exactly the same answers, over many seeds', () => {
    expect(isDeterministic(projectResponses)).toBe(true);
  });

  it('the check can fail: a projection that trusts arrival order is caught', () => {
    expect(isDeterministic(arrivalOrderProjection)).toBe(false);
  });

  it('is not vacuous: the generated logs really do carry answers, flags and time', () => {
    const projection = projectResponses(randomEvents(seeded(7), { count: 80 }), OPTIONS);
    expect(projection.slots.some((s) => s.answer !== null)).toBe(true);
    expect(projection.slots.some((s) => s.flagged)).toBe(true);
    expect(projection.slots.some((s) => s.timeOnItemMs > 0)).toBe(true);
  });
});
