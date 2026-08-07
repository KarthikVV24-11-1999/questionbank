import type { AggregationSpecData } from './aggregation-data.js';
import type { ItemOutcome } from './item-outcome.js';
import {
  addRational,
  compareRational,
  isNegative,
  roundToDecimalPlaces,
  subtractRational,
  ZERO,
  type Rational,
} from './numeric/decimal.js';

/**
 * Sectional then total aggregation — the third and fourth steps of
 * ASSESSMENT-ENGINE §3's fixed execution order.
 *
 * The total is the sum of the section scores and is **never** recomputed
 * independently from the outcomes. Two paths to the same number are two
 * opportunities for them to disagree, and a total that disagrees with its own
 * sections is a result nobody can defend.
 */

export interface SectionScore {
  readonly sectionOrdinal: number;
  readonly raw: Rational;
  readonly maxAvailable: Rational;
  readonly attemptedCount: number;
  readonly correctCount: number;
  readonly incorrectCount: number;
  /** The magnitude of the marks deducted, reported positive. */
  readonly negativeMarksIncurred: Rational;
}

export interface TotalScore {
  readonly raw: Rational;
  readonly maxAvailable: Rational;
  readonly attemptedCount: number;
  readonly correctCount: number;
  readonly incorrectCount: number;
  readonly negativeMarksIncurred: Rational;
}

export interface SectionOutcomes {
  readonly sectionOrdinal: number;
  /** In slot order. Order decides `bestOf` ties and nothing else. */
  readonly outcomes: readonly ItemOutcome[];
}

/**
 * Which outcomes count toward the section, once `bestOf` has had its say.
 *
 * Highest marks first, ties broken by the earlier slot. Both halves matter:
 * highest-first is the rule an exam board states, and the ordinal tie-break is
 * what makes it deterministic rather than dependent on sort stability.
 */
function selectCounted(outcomes: readonly ItemOutcome[], countScored: number): readonly ItemOutcome[] {
  const ranked = outcomes
    .map((outcome, index) => ({ outcome, index }))
    .sort((left, right) => {
      const byMarks = compareRational(right.outcome.marksAwarded, left.outcome.marksAwarded);
      return byMarks === 0 ? left.index - right.index : byMarks;
    })
    .slice(0, countScored);

  // Restore slot order, so the surviving outcomes read as the paper does.
  return ranked.sort((left, right) => left.index - right.index).map((entry) => entry.outcome);
}

function bestOfFor(spec: AggregationSpecData, sectionOrdinal: number): number | undefined {
  return spec.bestOf?.find((entry) => entry.sectionOrdinal === sectionOrdinal)?.countScored;
}

function round(value: Rational, spec: AggregationSpecData): Rational {
  return spec.rounding.mode === 'HALF_UP' ? roundToDecimalPlaces(value, spec.rounding.decimalPlaces) : value;
}

export function aggregateSection(section: SectionOutcomes, spec: AggregationSpecData): SectionScore {
  const countScored = bestOfFor(spec, section.sectionOrdinal);
  const counted =
    countScored === undefined ? section.outcomes : selectCounted(section.outcomes, countScored);

  let raw = ZERO;
  let maxAvailable = ZERO;
  let negative = ZERO;
  let attemptedCount = 0;
  let correctCount = 0;
  let incorrectCount = 0;

  for (const outcome of counted) {
    raw = addRational(raw, outcome.marksAwarded);
    // A dropped slot carries zero available, so it leaves the denominator
    // without any special case here (§2.5).
    maxAvailable = addRational(maxAvailable, outcome.marksAvailable);
    if (isNegative(outcome.marksAwarded)) negative = subtractRational(negative, outcome.marksAwarded);
    if (outcome.responseSnapshot !== undefined) attemptedCount += 1;
    if (outcome.correctness === 'correct') correctCount += 1;
    if (outcome.correctness === 'incorrect') incorrectCount += 1;
  }

  return Object.freeze({
    sectionOrdinal: section.sectionOrdinal,
    raw: round(raw, spec),
    maxAvailable,
    attemptedCount,
    correctCount,
    incorrectCount,
    negativeMarksIncurred: negative,
  });
}

export function aggregateTotal(sections: readonly SectionScore[], spec: AggregationSpecData): TotalScore {
  let raw = ZERO;
  let maxAvailable = ZERO;
  let negative = ZERO;
  let attemptedCount = 0;
  let correctCount = 0;
  let incorrectCount = 0;

  for (const section of sections) {
    raw = addRational(raw, section.raw);
    maxAvailable = addRational(maxAvailable, section.maxAvailable);
    negative = addRational(negative, section.negativeMarksIncurred);
    attemptedCount += section.attemptedCount;
    correctCount += section.correctCount;
    incorrectCount += section.incorrectCount;
  }

  const rounded = round(raw, spec);
  // Clamping is opt-in. JEE Main and NEET both permit a negative total, and
  // silently raising one to zero would award marks the candidate did not earn.
  const floored = spec.floorAtZero && isNegative(rounded) ? ZERO : rounded;

  return Object.freeze({
    raw: floored,
    maxAvailable,
    attemptedCount,
    correctCount,
    incorrectCount,
    negativeMarksIncurred: negative,
  });
}
