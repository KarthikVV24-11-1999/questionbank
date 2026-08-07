import { describe, expect, it } from 'vitest';
import type { AggregationSpecData as BarrelAggregationSpecData } from '../../curriculum/public/index.js';
import { DEFAULT_AGGREGATION, type AggregationSpecData } from './aggregation-data.js';
import { aggregateSection, aggregateTotal, type SectionOutcomes } from './aggregate-scores.js';
import type { ItemOutcome } from './item-outcome.js';
import { parseRational, rationalToDecimalString, type Rational } from './numeric/decimal.js';
import { expectValue } from '../../../testing/expect-result.js';

const marks = (text: string): Rational => expectValue(parseRational(text));
const text = (value: Rational): string => rationalToDecimalString(value);

function outcome(
  slotId: string,
  awarded: string,
  available: string,
  correctness: ItemOutcome['correctness'] = 'correct',
  attempted = true,
): ItemOutcome {
  return {
    slotId,
    sectionOrdinal: 1,
    slotOrdinal: 1,
    itemVersionId: `iv-${slotId}`,
    ...(attempted ? { responseSnapshot: { kind: 'OPTION_SELECTION' as const, optionIds: ['B'] } } : {}),
    correctness,
    marksAwarded: marks(awarded),
    marksAvailable: marks(available),
    ruleApplied: { ruleId: 'r', explanation: 'e' },
  };
}

const section = (sectionOrdinal: number, outcomes: readonly ItemOutcome[]): SectionOutcomes => ({
  sectionOrdinal,
  outcomes,
});

const spec = (overrides: Partial<AggregationSpecData> = {}): AggregationSpecData => ({
  ...DEFAULT_AGGREGATION,
  ...overrides,
});

describe('sectional aggregation', () => {
  const mixed = section(1, [
    outcome('a', '4', '4', 'correct'),
    outcome('b', '-1', '4', 'incorrect'),
    outcome('c', '0', '4', 'unattempted', false),
  ]);

  it('sums the awarded marks', () => {
    expect(text(aggregateSection(mixed, spec()).raw)).toBe('3');
  });

  it('sums the available marks', () => {
    expect(text(aggregateSection(mixed, spec()).maxAvailable)).toBe('12');
  });

  it('counts attempts by the presence of a response', () => {
    expect(aggregateSection(mixed, spec()).attemptedCount).toBe(2);
  });

  it('counts correct and incorrect outcomes separately', () => {
    const score = aggregateSection(mixed, spec());
    expect(score.correctCount).toBe(1);
    expect(score.incorrectCount).toBe(1);
  });

  it('does not count an indeterminate outcome as either', () => {
    const withIndeterminate = section(1, [outcome('a', '0', '4', 'indeterminate')]);
    const score = aggregateSection(withIndeterminate, spec());
    expect(score.correctCount).toBe(0);
    expect(score.incorrectCount).toBe(0);
  });

  it('reports the deducted marks as a positive magnitude', () => {
    const penalised = section(1, [outcome('a', '-1', '4', 'incorrect'), outcome('b', '-1', '4', 'incorrect')]);
    expect(text(aggregateSection(penalised, spec()).negativeMarksIncurred)).toBe('2');
  });

  it('carries the section ordinal through', () => {
    expect(aggregateSection(section(3, [outcome('a', '4', '4')]), spec()).sectionOrdinal).toBe(3);
  });

  it('aggregates an empty section to zero', () => {
    const empty = aggregateSection(section(1, []), spec());
    expect(text(empty.raw)).toBe('0');
    expect(text(empty.maxAvailable)).toBe('0');
    expect(empty.attemptedCount).toBe(0);
  });

  it('is invariant under outcome order', () => {
    const outcomes = [
      outcome('a', '4', '4', 'correct'),
      outcome('b', '-1', '4', 'incorrect'),
      outcome('c', '4', '4', 'correct'),
      outcome('d', '0', '4', 'unattempted', false),
    ];
    const reference = aggregateSection(section(1, outcomes), spec());
    for (let shuffle = 0; shuffle < 100; shuffle += 1) {
      const shuffled = [...outcomes].sort(() => (shuffle % 3) - 1);
      const score = aggregateSection(section(1, shuffled), spec());
      expect(text(score.raw)).toBe(text(reference.raw));
      expect(score.correctCount).toBe(reference.correctCount);
    }
  });
});

describe('a dropped slot', () => {
  it('reduces the available marks', () => {
    const withDrop = section(1, [outcome('a', '4', '4'), outcome('b', '0', '0', 'dropped')]);
    expect(text(aggregateSection(withDrop, spec()).maxAvailable)).toBe('4');
  });

  it('contributes nothing to the raw score', () => {
    const withDrop = section(1, [outcome('a', '4', '4'), outcome('b', '0', '0', 'dropped')]);
    expect(text(aggregateSection(withDrop, spec()).raw)).toBe('4');
  });
});

describe('a bonus slot', () => {
  it('leaves the available marks intact and pays', () => {
    const withBonus = section(1, [outcome('a', '4', '4'), outcome('b', '4', '4', 'bonus', false)]);
    const score = aggregateSection(withBonus, spec());
    expect(text(score.maxAvailable)).toBe('8');
    expect(text(score.raw)).toBe('8');
  });
});

describe('bestOf — NEET Section B scores the best 10 of 15', () => {
  const fifteen = section(
    2,
    Array.from({ length: 15 }, (_unused, index) =>
      outcome(`s${index}`, index < 10 ? '4' : '-1', '4', index < 10 ? 'correct' : 'incorrect'),
    ),
  );
  const bestTen = spec({ bestOf: [{ sectionOrdinal: 2, countScored: 10 }] });

  it('scores only the best ten', () => {
    expect(text(aggregateSection(fifteen, bestTen).raw)).toBe('40');
  });

  it('leaves the discarded slots out of the available marks', () => {
    expect(text(aggregateSection(fifteen, bestTen).maxAvailable)).toBe('40');
  });

  it('counts only the surviving outcomes', () => {
    const score = aggregateSection(fifteen, bestTen);
    expect(score.correctCount).toBe(10);
    expect(score.incorrectCount).toBe(0);
  });

  it('breaks a tie on the earlier slot, deterministically', () => {
    const allEqual = section(2, [outcome('a', '4', '4'), outcome('b', '4', '4'), outcome('c', '4', '4')]);
    const bestTwo = spec({ bestOf: [{ sectionOrdinal: 2, countScored: 2 }] });
    const runs = Array.from({ length: 50 }, () => aggregateSection(allEqual, bestTwo));
    expect(new Set(runs.map((run) => text(run.raw))).size).toBe(1);
    expect(text(runs[0]?.raw as Rational)).toBe('8');
  });

  it('applies only to the section it names', () => {
    const other = section(1, Array.from({ length: 3 }, (_unused, index) => outcome(`s${index}`, '4', '4')));
    expect(text(aggregateSection(other, bestTen).raw)).toBe('12');
  });

  it('scores every outcome when the section is shorter than the count', () => {
    const two = section(2, [outcome('a', '4', '4'), outcome('b', '4', '4')]);
    expect(text(aggregateSection(two, bestTen).raw)).toBe('8');
  });

  it('keeps the best answers rather than the first ones', () => {
    const worstFirst = section(2, [outcome('a', '-1', '4', 'incorrect'), outcome('b', '4', '4', 'correct')]);
    const bestOne = spec({ bestOf: [{ sectionOrdinal: 2, countScored: 1 }] });
    expect(text(aggregateSection(worstFirst, bestOne).raw)).toBe('4');
  });
});

describe('rounding', () => {
  const thirds = section(1, [outcome('a', '1/3', '4'), outcome('b', '1/3', '4')]);

  it('leaves the value exact when the mode is NONE', () => {
    expect(text(aggregateSection(thirds, spec()).raw)).toBe('0.666667');
  });

  it('rounds half up to the stated places', () => {
    const rounded = spec({ rounding: { mode: 'HALF_UP', decimalPlaces: 2 } });
    expect(text(aggregateSection(thirds, rounded).raw)).toBe('0.67');
  });

  it('rounds to whole marks when asked', () => {
    const rounded = spec({ rounding: { mode: 'HALF_UP', decimalPlaces: 0 } });
    expect(text(aggregateSection(thirds, rounded).raw)).toBe('1');
  });
});

describe('total aggregation', () => {
  const sections = [
    aggregateSection(section(1, [outcome('a', '4', '4'), outcome('b', '-1', '4', 'incorrect')]), spec()),
    aggregateSection(section(2, [outcome('c', '4', '4')]), spec()),
  ];

  it('is the sum of the section scores', () => {
    expect(text(aggregateTotal(sections, spec()).raw)).toBe('7');
  });

  it('sums the available marks across sections', () => {
    expect(text(aggregateTotal(sections, spec()).maxAvailable)).toBe('12');
  });

  it('sums the counts across sections', () => {
    const total = aggregateTotal(sections, spec());
    expect(total.attemptedCount).toBe(3);
    expect(total.correctCount).toBe(2);
    expect(total.incorrectCount).toBe(1);
  });

  it('sums the deducted marks across sections', () => {
    expect(text(aggregateTotal(sections, spec()).negativeMarksIncurred)).toBe('1');
  });

  it('is zero for no sections', () => {
    expect(text(aggregateTotal([], spec()).raw)).toBe('0');
  });

  it('permits a negative total by default', () => {
    const negative = [aggregateSection(section(1, [outcome('a', '-1', '4', 'incorrect')]), spec())];
    expect(text(aggregateTotal(negative, spec()).raw)).toBe('-1');
  });

  it('clamps at zero only when the profile asks', () => {
    const negative = [aggregateSection(section(1, [outcome('a', '-1', '4', 'incorrect')]), spec())];
    expect(text(aggregateTotal(negative, spec({ floorAtZero: true })).raw)).toBe('0');
  });

  it('does not raise a positive total when clamping is on', () => {
    const positive = [aggregateSection(section(1, [outcome('a', '4', '4')]), spec())];
    expect(text(aggregateTotal(positive, spec({ floorAtZero: true })).raw)).toBe('4');
  });

  it('rounds the total when asked', () => {
    const thirds = [aggregateSection(section(1, [outcome('a', '1/3', '4')]), spec())];
    const rounded = spec({ rounding: { mode: 'HALF_UP', decimalPlaces: 1 } });
    expect(text(aggregateTotal(thirds, rounded).raw)).toBe('0.3');
  });

  it('is invariant under section order', () => {
    expect(text(aggregateTotal([...sections].reverse(), spec()).raw)).toBe(
      text(aggregateTotal(sections, spec()).raw),
    );
  });
});

describe('the curriculum barrel type', () => {
  it('remains assignable to the mirrored shape', () => {
    const fromBarrel: BarrelAggregationSpecData = {
      sectionAggregation: 'SUM',
      totalAggregation: 'SUM_OF_SECTIONS',
      bestOf: [{ sectionOrdinal: 2, countScored: 10 }],
      rounding: { mode: 'HALF_UP', decimalPlaces: 2 },
      floorAtZero: false,
    };
    const asScoring: AggregationSpecData = fromBarrel;
    expect(asScoring.bestOf?.[0]?.countScored).toBe(10);
  });

  it('declares the same default as curriculum', () => {
    expect(DEFAULT_AGGREGATION).toEqual({
      sectionAggregation: 'SUM',
      totalAggregation: 'SUM_OF_SECTIONS',
      rounding: { mode: 'NONE', decimalPlaces: 0 },
      floorAtZero: false,
    });
  });
});
