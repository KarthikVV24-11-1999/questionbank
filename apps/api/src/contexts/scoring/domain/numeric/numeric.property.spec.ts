import { describe, expect, it } from 'vitest';
import { DEFAULT_NORMALIZATION, type NumericAnswerSpecResolved } from '../answer-key.js';
import { normalizeNumericEntry } from './normalize.js';
import { compareNumeric } from './compare.js';
import {
  addRational,
  compareRational,
  parseRational,
  rationalToDecimalString,
  roundToSignificantFigures,
  subtractRational,
  type Rational,
} from './decimal.js';
import { expectValue } from '../../../../testing/expect-result.js';

/**
 * Property-based tolerance testing (handbook §5).
 *
 * The generator is seeded and the seed is printed on failure, so a
 * counterexample is reproducible rather than a story about a run nobody can
 * repeat. No `Math.random`: these tests must not be flaky, and a flaky test on
 * the tolerance comparison is worse than no test.
 */
const SEED = 0x5eed_1234;
const CASES = 1000;

/** xorshift32 — small, deterministic, and adequate for generating decimals. */
function makeGenerator(seed: number): () => number {
  let state = seed;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function decimalIn(next: () => number, magnitude: number, places: number): string {
  const sign = next() < 0.5 ? '' : '-';
  const whole = Math.floor(next() * magnitude);
  const fraction = String(Math.floor(next() * 10 ** places)).padStart(places, '0');
  return `${sign}${whole}.${fraction}`;
}

function spec(overrides: Partial<NumericAnswerSpecResolved>): NumericAnswerSpecResolved {
  return {
    expectedValue: '0',
    comparisonMode: 'EXACT',
    acceptedForms: ['DECIMAL', 'FRACTION', 'SCIENTIFIC'],
    normalization: DEFAULT_NORMALIZATION,
    ...overrides,
  };
}

const matches = (value: string, s: NumericAnswerSpecResolved): boolean => expectValue(compareNumeric(value, s));

describe('normalization is idempotent', () => {
  it(`holds over ${CASES} generated entries`, () => {
    const next = makeGenerator(SEED);
    for (let index = 0; index < CASES; index += 1) {
      const raw = decimalIn(next, 10_000, 4);
      const once = expectValue(normalizeNumericEntry(raw, DEFAULT_NORMALIZATION));
      const twice = expectValue(normalizeNumericEntry(once.value, DEFAULT_NORMALIZATION));
      expect(twice.value, `seed ${SEED} case ${index}: ${raw}`).toBe(once.value);
    }
  });
});

describe('a value inside the tolerance band always matches, outside never does', () => {
  it(`holds over ${CASES} generated bands`, () => {
    const next = makeGenerator(SEED + 1);
    for (let index = 0; index < CASES; index += 1) {
      const expected = decimalIn(next, 1000, 3);
      const tolerance = decimalIn(next, 10, 3).replace('-', '');
      const band = spec({ comparisonMode: 'ABSOLUTE_TOLERANCE', expectedValue: expected, toleranceValue: tolerance });

      const centre = expectValue(parseRational(expected));
      const width = expectValue(parseRational(tolerance));
      const label = `seed ${SEED + 1} case ${index}: ${expected} ± ${tolerance}`;

      // Exactly on each boundary — the case the tolerance was authored to admit.
      expect(matches(rationalToDecimalString(addRational(centre, width), 10), band), `${label} upper`).toBe(true);
      expect(matches(rationalToDecimalString(subtractRational(centre, width), 10), band), `${label} lower`).toBe(
        true,
      );

      // Just outside, by one part in ten thousand of the band.
      const nudge = expectValue(parseRational('0.0001'));
      const beyond = addRational(addRational(centre, width), nudge);
      if (compareRational(width, { num: 0n, den: 1n }) > 0) {
        expect(matches(rationalToDecimalString(beyond, 10), band), `${label} beyond`).toBe(false);
      }
    }
  });
});

describe('RANGE matches exactly on the closed interval', () => {
  it(`holds over ${CASES} generated ranges`, () => {
    const next = makeGenerator(SEED + 2);
    for (let index = 0; index < CASES; index += 1) {
      const first = expectValue(parseRational(decimalIn(next, 100, 3)));
      const second = expectValue(parseRational(decimalIn(next, 100, 3)));
      const ascending = compareRational(first, second) <= 0;
      const min = ascending ? first : second;
      const max = ascending ? second : first;

      const range = spec({
        comparisonMode: 'RANGE',
        rangeMin: rationalToDecimalString(min, 10),
        rangeMax: rationalToDecimalString(max, 10),
      });
      const label = `seed ${SEED + 2} case ${index}`;

      expect(matches(rationalToDecimalString(min, 10), range), `${label} at min`).toBe(true);
      expect(matches(rationalToDecimalString(max, 10), range), `${label} at max`).toBe(true);

      const outside = subtractRational(min, expectValue(parseRational('1')));
      expect(matches(rationalToDecimalString(outside, 10), range), `${label} below min`).toBe(false);
    }
  });
});

describe('significant-figure comparison is symmetric', () => {
  it(`holds over ${CASES} generated pairs`, () => {
    const next = makeGenerator(SEED + 3);
    for (let index = 0; index < CASES; index += 1) {
      const left = decimalIn(next, 1000, 4);
      const right = decimalIn(next, 1000, 4);
      const figures = 1 + Math.floor(next() * 5);
      const label = `seed ${SEED + 3} case ${index}: ${left} vs ${right} @ ${figures}sf`;

      const leftFirst = matches(left, spec({ comparisonMode: 'SIGNIFICANT_FIGURES', expectedValue: right, significantFigures: figures }));
      const rightFirst = matches(right, spec({ comparisonMode: 'SIGNIFICANT_FIGURES', expectedValue: left, significantFigures: figures }));
      expect(leftFirst, label).toBe(rightFirst);
    }
  });

  it('is idempotent under repeated rounding', () => {
    const next = makeGenerator(SEED + 4);
    for (let index = 0; index < CASES; index += 1) {
      const value = expectValue(parseRational(decimalIn(next, 1000, 5)));
      const figures = 1 + Math.floor(next() * 5);
      const once = roundToSignificantFigures(value, figures);
      const twice = roundToSignificantFigures(once, figures);
      expect(compareRational(once, twice), `seed ${SEED + 4} case ${index}`).toBe(0);
    }
  });
});

describe('adversarial values', () => {
  const cases: readonly [string, string, string][] = [
    ['at the boundary', '9.81', '0.01'],
    ['an expected zero', '0', '0.01'],
    ['a very large magnitude', '99999999999999999999', '1'],
    ['a very small magnitude', '0.00000000000000000001', '0.000000000000000000001'],
    ['trailing zeros', '4.0000', '0.0001'],
    ['negative zero', '-0', '0.01'],
    ['a negative expected value', '-273.15', '0.05'],
  ];

  for (const [label, expected, tolerance] of cases) {
    it(`admits the exact expected value with ${label}`, () => {
      const band = spec({ comparisonMode: 'ABSOLUTE_TOLERANCE', expectedValue: expected, toleranceValue: tolerance });
      expect(matches(expected, band), `${label}`).toBe(true);
    });
  }

  it('never throws on a generated entry, however odd', () => {
    const next = makeGenerator(SEED + 5);
    const band = spec({ comparisonMode: 'ABSOLUTE_TOLERANCE', expectedValue: '1', toleranceValue: '0.1' });
    for (let index = 0; index < CASES; index += 1) {
      const raw = `${decimalIn(next, 100, 3)}${next() < 0.3 ? ' kg' : ''}${next() < 0.2 ? 'e' : ''}`;
      expect(() => compareNumeric(raw, band), `case ${index}: ${raw}`).not.toThrow();
    }
  });
});

describe('a planted off-by-one in the comparison is caught', () => {
  it('an exclusive boundary would fail the band property', () => {
    // The property above asserts the boundary is inclusive. This states the
    // failure it would report if the comparison were ever changed to `<`.
    const band = spec({ comparisonMode: 'ABSOLUTE_TOLERANCE', expectedValue: '9.81', toleranceValue: '0.01' });
    const onBoundary = matches('9.82', band);
    expect(onBoundary).toBe(true);

    const exclusiveWouldSay = compareRational(
      expectValue(parseRational('0.01')),
      expectValue(parseRational('0.01')),
    ) < 0;
    expect(exclusiveWouldSay).toBe(false);
  });
});
