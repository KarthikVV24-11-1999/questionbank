import { describe, expect, it } from 'vitest';
import { RESPONSE_EVENT_KINDS, compareEvents, sameEvent, type ResponseEvent } from './response-event.js';

const base = { attemptId: 'a1', slot: 'q1', monotonicMs: 0 } as const;
const ev = (eventId: string, sequence: number): ResponseEvent => ({ ...base, eventId, sequence, kind: 'clear' });

describe('the event vocabulary', () => {
  it('is exactly the seven kinds the design names', () => {
    expect([...RESPONSE_EVENT_KINDS]).toEqual(['select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag']);
  });
});

describe('compareEvents', () => {
  it('orders by sequence first', () => {
    expect(compareEvents(ev('z', 1), ev('a', 2))).toBeLessThan(0);
    expect(compareEvents(ev('a', 2), ev('z', 1))).toBeGreaterThan(0);
  });

  it('breaks a sequence tie on event id, so the order is total', () => {
    expect(compareEvents(ev('a', 1), ev('b', 1))).toBeLessThan(0);
    expect(compareEvents(ev('b', 1), ev('a', 1))).toBeGreaterThan(0);
    expect(compareEvents(ev('a', 1), ev('a', 1))).toBe(0);
  });
});

describe('sameEvent', () => {
  it('is true for the same content however the keys are ordered', () => {
    const a = { ...base, eventId: 'e', sequence: 1, kind: 'select', answer: ['x', 'y'] } as const;
    const b = { answer: ['x', 'y'], kind: 'select', sequence: 1, eventId: 'e', monotonicMs: 0, slot: 'q1', attemptId: 'a1' } as const;
    expect(sameEvent(a, b)).toBe(true);
  });

  it('is false when any field differs, including inside an array answer', () => {
    const a = { ...base, eventId: 'e', sequence: 1, kind: 'select', answer: ['x', 'y'] } as const;
    const b = { ...a, answer: ['x', 'z'] } as const;
    expect(sameEvent(a, b)).toBe(false);
    expect(sameEvent(ev('e', 1), ev('e', 2))).toBe(false);
  });
});
