import { describe, expect, it } from 'vitest';
import { PLATFORM_THRESHOLDS_V2, thresholdsWith } from '../../../testing/learning-thresholds.js';
import type { ConceptEvidence } from './concept-state.js';
import { escalationDue, observationsOf, scheduleOf } from './review-schedule.js';

const REVIEW = PLATFORM_THRESHOLDS_V2.review!;
const CONCEPT = '00000000-0000-4000-8000-00000000c001';
const DAY = 86_400_000;
const t0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const at = (days: number, minutes = 0) => new Date(t0 + days * DAY + minutes * 60_000).toISOString();

let n = 0;
const response = (session: string, outcome: 'correct' | 'incorrect', occurredAt: string, item = `item-${(n += 1)}`): ConceptEvidence => ({
  evidenceId: `e${(n += 1)}`,
  itemVersionRef: item,
  outcome,
  difficultyEstimate: 'moderate',
  occurredAt,
  sessionId: session,
});

/** One sitting on `day`, of `right` correct and `wrong` incorrect responses. */
const sitting = (day: number, right: number, wrong = 0): ConceptEvidence[] => [
  ...Array.from({ length: right }, (_, i) => response(`s${day}`, 'correct', at(day, i))),
  ...Array.from({ length: wrong }, (_, i) => response(`s${day}`, 'incorrect', at(day, right + i))),
];
const schedule = (evidence: ConceptEvidence[], review = REVIEW) => scheduleOf(CONCEPT, evidence, review);

describe('a concept\'s review schedule (M7-47)', () => {
  it('is nothing for a concept with no evidence', () => {
    expect(schedule([])).toBeNull();
  });

  it('after one passing sitting is due the first interval after its last response, with one success and no lapse', () => {
    expect(schedule(sitting(0, 4))).toEqual({ conceptIdentityId: CONCEPT, dueAt: at(REVIEW.firstIntervalDays, 3), intervalDays: REVIEW.firstIntervalDays, consecutiveSuccesses: 1, lapseCount: 0, lastObservedAt: at(0, 3) });
  });

  it('lengthens the interval by the growth factor on each further pass, rounding up', () => {
    const grown = schedule([...sitting(0, 3), ...sitting(2, 3), ...sitting(5, 3), ...sitting(10, 3)]);
    expect(grown).toMatchObject({ intervalDays: REVIEW.firstIntervalDays * REVIEW.growthFactor ** 3, consecutiveSuccesses: 4 });
    const fractional = thresholdsWith({ review: { growthFactor: 1.5, firstIntervalDays: 3, minIntervalDays: 1 } }).review!;
    expect(schedule([...sitting(0, 3), ...sitting(4, 3)], fractional)?.intervalDays).toBe(5);
  });

  it('never lets the interval pass the most', () => {
    const many = Array.from({ length: 12 }, (_, i) => sitting(i * 3, 3)).flat();
    expect(schedule(many)?.intervalDays).toBe(REVIEW.maxIntervalDays);
  });

  it('shortens the interval on a failure, again on a second, and stops at the least', () => {
    const grown = [...sitting(0, 3), ...sitting(2, 3), ...sitting(5, 3)];
    expect(schedule(grown)?.intervalDays).toBe(4);
    expect(schedule([...grown, ...sitting(10, 0, 3)])).toMatchObject({ intervalDays: 2, lapseCount: 1 });
    expect(schedule([...grown, ...sitting(10, 0, 3), ...sitting(12, 0, 3)])).toMatchObject({ intervalDays: 1, lapseCount: 2 });
    expect(schedule([...grown, ...sitting(10, 0, 3), ...sitting(12, 0, 3), ...sitting(14, 0, 3)])).toMatchObject({ intervalDays: REVIEW.minIntervalDays, lapseCount: 3 });
  });

  it('ends the run of successes on a failure, so the next pass starts the intervals again', () => {
    const after = schedule([...sitting(0, 3), ...sitting(2, 3), ...sitting(5, 0, 3), ...sitting(7, 3)]);
    expect(after).toMatchObject({ consecutiveSuccesses: 1, lapseCount: 1, intervalDays: REVIEW.firstIntervalDays });
  });

  it('judges a sitting as a whole: the responses of one sitting are one observation, and the pass line is inclusive', () => {
    const accuracy = REVIEW.passAccuracy;
    const total = 5;
    const right = Math.round(accuracy * total);
    expect(right / total).toBe(accuracy);
    expect(schedule(sitting(0, right, total - right))).toMatchObject({ consecutiveSuccesses: 1, lapseCount: 0 });
    expect(schedule(sitting(0, right - 1, total - right + 1))).toMatchObject({ consecutiveSuccesses: 0, lapseCount: 1 });
    // the same responses spread over separate sittings are not one observation
    expect(observationsOf([...sitting(0, 1), ...sitting(1, 0, 1)])).toHaveLength(2);
    expect(observationsOf([...sitting(0, 1, 1)])).toHaveLength(1);
  });

  it('is due from the last response of the last sitting, not the first', () => {
    expect(schedule(sitting(0, 4))?.lastObservedAt).toBe(at(0, 3));
    expect(schedule([...sitting(0, 3), ...sitting(3, 3)])?.lastObservedAt).toBe(at(3, 2));
  });

  it('gives the same schedule for the same evidence in any order, and one schedule however many items it came from', () => {
    const evidence = [...sitting(0, 3), ...sitting(2, 0, 3), ...sitting(4, 3)];
    expect(schedule([...evidence].reverse())).toEqual(schedule(evidence));
    const oneItem = evidence.map((e) => ({ ...e, itemVersionRef: 'the-same-item' }));
    expect(schedule(oneItem)).toEqual(schedule(evidence));
  });

  it('is keyed by the concept and names nothing of an item', () => {
    expect(Object.keys(schedule(sitting(0, 3))!).sort()).toEqual(['conceptIdentityId', 'consecutiveSuccesses', 'dueAt', 'intervalDays', 'lapseCount', 'lastObservedAt']);
  });
});

describe('escalation is a threshold on the lapse count (M7-48)', () => {
  const lapses = (count: number) => schedule(Array.from({ length: count }, (_, i) => sitting(i * 2, 0, 3)).flat())!;
  const at_ = REVIEW.escalateAtLapses;

  it('does not escalate one lapse below the threshold', () => {
    expect(escalationDue(lapses(at_ - 1), REVIEW)).toBe(false);
  });

  it('escalates at the threshold and past it', () => {
    expect(escalationDue(lapses(at_), REVIEW)).toBe(true);
    expect(escalationDue(lapses(at_ + 1), REVIEW)).toBe(true);
  });

  it('reads the threshold from the rule set it is given', () => {
    const stricter = thresholdsWith({ review: { escalateAtLapses: at_ + 2 } }).review!;
    expect(escalationDue(lapses(at_), stricter)).toBe(false);
  });
});
