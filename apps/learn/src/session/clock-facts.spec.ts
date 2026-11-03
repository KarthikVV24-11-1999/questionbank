import { describe, expect, it } from 'vitest';
import { createClockFacts } from './clock-facts.js';
import type { SessionRecord } from './persistence.js';

const record = (serverOffsetMs: number | null): SessionRecord => ({ version: 1, attemptId: 'a', deviceRef: 'd', intervalCapMs: 1, deadline: 'x', formId: null, serverOffsetMs, submissionReason: null, events: [], acknowledgedIds: [], rejectedIds: [] });

describe('the offset to the server\'s clock that analytics events are stamped with (M8-15)', () => {
  it('starts from what the last session left, or from nothing', () => {
    expect(createClockFacts(record(-300_000)).offsetMs()).toBe(-300_000);
    expect(createClockFacts(record(null)).offsetMs()).toBe(0);
    expect(createClockFacts(null).offsetMs()).toBe(0);
  });

  it('moves when the session takes a fresher one, and keeps the last when a record has none', () => {
    const facts = createClockFacts(null);
    facts.observe(record(42));
    expect(facts.offsetMs()).toBe(42);
    facts.observe(record(null));
    expect(facts.offsetMs()).toBe(42);
    facts.observe(record(-7));
    expect(facts.offsetMs()).toBe(-7);
  });
});
