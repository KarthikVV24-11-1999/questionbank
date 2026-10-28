import { describe, expect, it } from 'vitest';
import { PLATFORM_THRESHOLDS_V2 } from '../../../testing/learning-thresholds.js';
import { paceAnalytics, paceOf, type PaceSlot } from './pace-analytics.js';

const PACE = PLATFORM_THRESHOLDS_V2.pace!;
const MODERATE_LINE = PACE.slowAboveMs.moderate;
const CONCEPT = '00000000-0000-4000-8000-00000000c001';
const OTHER = '00000000-0000-4000-8000-00000000c002';
const TAXONOMY = '00000000-0000-4000-8000-00000000a001';

const slot = (changes: Partial<PaceSlot> = {}): PaceSlot => ({
  slotRef: 's1',
  conceptIdentityId: CONCEPT,
  taxonomyVersionId: TAXONOMY,
  difficultyEstimate: 'moderate',
  outcome: 'correct',
  timeOnItemMs: 0,
  discardedMs: 0,
  unclosedVisits: 0,
  ...changes,
});
const reading = (changes: Partial<PaceSlot>) => paceOf(slot(changes), PACE).pace;

describe('a response read against the line for its band (M7-46)', () => {
  it('is slow when the time counted is above the line, whatever else was lost', () => {
    expect(reading({ timeOnItemMs: MODERATE_LINE + 1 })).toBe('slow');
    expect(reading({ timeOnItemMs: MODERATE_LINE + 1, discardedMs: 500_000, unclosedVisits: 2 })).toBe('slow');
  });

  it('is fast when nothing was lost and the time is at or under the line: the line itself is not slow', () => {
    expect(reading({ timeOnItemMs: MODERATE_LINE })).toBe('fast');
    expect(reading({ timeOnItemMs: 1_000 })).toBe('fast');
  });

  it('is not known when the time counted is under the line and what the cap threw away could carry it over', () => {
    expect(reading({ timeOnItemMs: MODERATE_LINE - 1_000, discardedMs: 240_000 })).toBe('unknown');
  });

  it('is fast, though truncated, when even the most it can have been is at or under the line', () => {
    expect(reading({ timeOnItemMs: MODERATE_LINE - 10_000, discardedMs: 10_000 })).toBe('fast');
    expect(reading({ timeOnItemMs: MODERATE_LINE - 10_000, discardedMs: 10_001 })).toBe('unknown');
  });

  it('is not known when a visit never closed, however little was thrown away', () => {
    expect(reading({ timeOnItemMs: 1_000, discardedMs: 0, unclosedVisits: 1 })).toBe('unknown');
  });

  it('tells a truncated slot from an untruncated one that read the same time', () => {
    const sameTime = MODERATE_LINE - 1;
    expect(reading({ timeOnItemMs: sameTime, discardedMs: 0 })).toBe('fast');
    expect(reading({ timeOnItemMs: sameTime, discardedMs: 180_000 })).toBe('unknown');
  });

  it('draws the line per authored band: the time that is slow for a foundational question is not for an advanced one', () => {
    const time = PACE.slowAboveMs.foundational + 1;
    expect(reading({ difficultyEstimate: 'foundational', timeOnItemMs: time })).toBe('slow');
    expect(reading({ difficultyEstimate: 'advanced', timeOnItemMs: time })).toBe('fast');
  });

  it('reports the two bounds, and no upper bound at all where a visit never closed', () => {
    expect(paceOf(slot({ timeOnItemMs: 5_000, discardedMs: 7_000 }), PACE)).toMatchObject({ atLeastMs: 5_000, atMostMs: 12_000 });
    expect(paceOf(slot({ timeOnItemMs: 5_000, unclosedVisits: 1 }), PACE).atMostMs).toBeNull();
  });
});

describe('time against outcome, per concept', () => {
  const slow = MODERATE_LINE + 1;
  it('keeps slow-and-correct apart from slow-and-wrong, and both apart from what could not be told', () => {
    const analytics = paceAnalytics(
      [
        slot({ slotRef: 'a', outcome: 'correct', timeOnItemMs: slow }),
        slot({ slotRef: 'b', outcome: 'incorrect', timeOnItemMs: slow }),
        slot({ slotRef: 'c', outcome: 'correct', timeOnItemMs: 1_000 }),
        slot({ slotRef: 'd', outcome: 'incorrect', timeOnItemMs: 1_000 }),
        slot({ slotRef: 'e', outcome: 'correct', timeOnItemMs: 1_000, discardedMs: 300_000 }),
        slot({ slotRef: 'f', outcome: 'incorrect', timeOnItemMs: 1_000, discardedMs: 300_000 }),
      ],
      PACE,
    );
    expect(analytics.concepts).toEqual([{ conceptIdentityId: CONCEPT, taxonomyVersionId: TAXONOMY, slowCorrect: 1, slowWrong: 1, fastCorrect: 1, fastWrong: 1, unknownCorrect: 1, unknownWrong: 1 }]);
  });

  it('counts each concept on its own, in a stable order, and reads every slot once', () => {
    const analytics = paceAnalytics([slot({ slotRef: 'a', conceptIdentityId: OTHER, timeOnItemMs: slow }), slot({ slotRef: 'b', timeOnItemMs: slow }), slot({ slotRef: 'c', timeOnItemMs: slow })], PACE);
    expect(analytics.concepts.map((c) => [c.conceptIdentityId, c.slowCorrect])).toEqual([[CONCEPT, 2], [OTHER, 1]]);
    expect(analytics.slots.map((s) => s.slotRef)).toEqual(['a', 'b', 'c']);
  });
});
