import { describe, expect, it } from 'vitest';
import { DEFAULT_NORMALIZATION, type NumericAnswerSpecResolved } from '../answer-key.js';
import { compareNumeric } from './compare.js';
import { multiplyRational, parseRational } from './decimal.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

function spec(overrides: Partial<NumericAnswerSpecResolved>): NumericAnswerSpecResolved {
  return {
    expectedValue: '10',
    comparisonMode: 'EXACT',
    acceptedForms: ['DECIMAL', 'FRACTION', 'SCIENTIFIC'],
    normalization: DEFAULT_NORMALIZATION,
    ...overrides,
  };
}

const matches = (value: string, s: NumericAnswerSpecResolved): boolean =>
  expectValue(compareNumeric(value, s));

describe('EXACT', () => {
  const exact = spec({ comparisonMode: 'EXACT', expectedValue: '9.81' });

  it('matches an identical value', () => {
    expect(matches('9.81', exact)).toBe(true);
  });

  it('matches the same value written with trailing zeros', () => {
    expect(matches('9.810', exact)).toBe(true);
  });

  it('matches the same value written in another accepted form', () => {
    expect(matches('981e-2', exact)).toBe(true);
  });

  it('does not match a different value', () => {
    expect(matches('9.82', exact)).toBe(false);
  });

  it('does not match on the smallest representable difference', () => {
    expect(matches('9.8100000000000000001', exact)).toBe(false);
  });

  it('is not fooled by binary floating point', () => {
    const third = spec({ comparisonMode: 'EXACT', expectedValue: '0.3' });
    expect(matches('0.3', third)).toBe(true);
    expect(matches('0.30', third)).toBe(true);
  });

  it('matches a fraction against its decimal equivalent', () => {
    expect(matches('1/2', spec({ comparisonMode: 'EXACT', expectedValue: '0.5' }))).toBe(true);
  });

  it('does not match a repeating fraction against a truncated decimal', () => {
    expect(matches('2/3', spec({ comparisonMode: 'EXACT', expectedValue: '0.667' }))).toBe(false);
  });
});

describe('ABSOLUTE_TOLERANCE', () => {
  const absolute = spec({
    comparisonMode: 'ABSOLUTE_TOLERANCE',
    expectedValue: '9.81',
    toleranceValue: '0.01',
  });

  it('matches at the centre', () => {
    expect(matches('9.81', absolute)).toBe(true);
  });

  it('matches exactly on the upper boundary', () => {
    expect(matches('9.82', absolute)).toBe(true);
  });

  it('matches exactly on the lower boundary', () => {
    expect(matches('9.80', absolute)).toBe(true);
  });

  it('does not match just outside the upper boundary', () => {
    expect(matches('9.8201', absolute)).toBe(false);
  });

  it('does not match just outside the lower boundary', () => {
    expect(matches('9.7999', absolute)).toBe(false);
  });

  it('matches inside the band on both sides', () => {
    expect(matches('9.815', absolute)).toBe(true);
    expect(matches('9.805', absolute)).toBe(true);
  });

  it('treats a negative tolerance as its magnitude', () => {
    const negative = spec({
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      expectedValue: '9.81',
      toleranceValue: '-0.01',
    });
    expect(matches('9.82', negative)).toBe(true);
  });

  it('with a zero tolerance behaves as EXACT', () => {
    const zero = spec({ comparisonMode: 'ABSOLUTE_TOLERANCE', expectedValue: '5', toleranceValue: '0' });
    expect(matches('5', zero)).toBe(true);
    expect(matches('5.0001', zero)).toBe(false);
  });

  it('works around a negative expected value', () => {
    const negative = spec({
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      expectedValue: '-273.15',
      toleranceValue: '0.05',
    });
    expect(matches('-273.20', negative)).toBe(true);
    expect(matches('-273.10', negative)).toBe(true);
    expect(matches('-273.21', negative)).toBe(false);
  });

  it('reports an unreadable tolerance rather than guessing', () => {
    const broken = spec({
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      expectedValue: '9.81',
      toleranceValue: 'wide',
    });
    expect(expectError(compareNumeric('9.81', broken)).code).toBe('TOLERANCE_UNPARSEABLE');
  });
});

describe('RELATIVE_TOLERANCE', () => {
  const relative = spec({
    comparisonMode: 'RELATIVE_TOLERANCE',
    expectedValue: '200',
    toleranceValue: '0.01',
  });

  it('matches at the centre', () => {
    expect(matches('200', relative)).toBe(true);
  });

  it('matches exactly on the boundary — one per cent of two hundred is two', () => {
    expect(matches('202', relative)).toBe(true);
    expect(matches('198', relative)).toBe(true);
  });

  it('does not match just outside the boundary', () => {
    expect(matches('202.01', relative)).toBe(false);
    expect(matches('197.99', relative)).toBe(false);
  });

  it('scales the band with the expected value, unlike an absolute tolerance', () => {
    const small = spec({ comparisonMode: 'RELATIVE_TOLERANCE', expectedValue: '2', toleranceValue: '0.01' });
    expect(matches('2.02', small)).toBe(true);
    expect(matches('2.03', small)).toBe(false);
  });

  it('uses the magnitude of a negative expected value', () => {
    const negative = spec({
      comparisonMode: 'RELATIVE_TOLERANCE',
      expectedValue: '-200',
      toleranceValue: '0.01',
    });
    expect(matches('-202', negative)).toBe(true);
    expect(matches('-198', negative)).toBe(true);
    expect(matches('-202.01', negative)).toBe(false);
  });

  it('falls back to an absolute comparison when the expected value is zero', () => {
    // A relative band around zero is zero wide, which would silently turn the
    // mode into EXACT and deny every near-miss the author meant to admit.
    const atZero = spec({ comparisonMode: 'RELATIVE_TOLERANCE', expectedValue: '0', toleranceValue: '0.01' });
    expect(matches('0', atZero)).toBe(true);
    expect(matches('0.01', atZero)).toBe(true);
    expect(matches('-0.01', atZero)).toBe(true);
    expect(matches('0.011', atZero)).toBe(false);
  });

  it('reports an unreadable tolerance rather than guessing', () => {
    const broken = spec({
      comparisonMode: 'RELATIVE_TOLERANCE',
      expectedValue: '200',
      toleranceValue: 'one per cent',
    });
    expect(expectError(compareNumeric('200', broken)).code).toBe('TOLERANCE_UNPARSEABLE');
  });
});

describe('SIGNIFICANT_FIGURES', () => {
  const figures = spec({
    comparisonMode: 'SIGNIFICANT_FIGURES',
    expectedValue: '9.81',
    significantFigures: 3,
  });

  it('matches an identical value', () => {
    expect(matches('9.81', figures)).toBe(true);
  });

  it('matches a value that rounds to the same three figures', () => {
    expect(matches('9.814', figures)).toBe(true);
    expect(matches('9.806', figures)).toBe(true);
  });

  it('does not match a value that rounds differently', () => {
    expect(matches('9.82', figures)).toBe(false);
    expect(matches('9.80', figures)).toBe(false);
  });

  it('rounds both sides, not only the learner (D-001 rule 4)', () => {
    const twoFigures = spec({
      comparisonMode: 'SIGNIFICANT_FIGURES',
      expectedValue: '9.814',
      significantFigures: 2,
    });
    expect(matches('9.8', twoFigures)).toBe(true);
  });

  it('rounds half away from zero at the boundary', () => {
    const two = spec({ comparisonMode: 'SIGNIFICANT_FIGURES', expectedValue: '1.3', significantFigures: 2 });
    expect(matches('1.25', two)).toBe(true);
  });

  it('matches a repeating fraction against its rounded decimal', () => {
    const three = spec({
      comparisonMode: 'SIGNIFICANT_FIGURES',
      expectedValue: '0.667',
      significantFigures: 3,
    });
    expect(matches('2/3', three)).toBe(true);
  });

  it('handles a value crossing a decade under rounding', () => {
    const two = spec({ comparisonMode: 'SIGNIFICANT_FIGURES', expectedValue: '10', significantFigures: 2 });
    expect(matches('9.99', two)).toBe(true);
  });

  it('matches zero against zero', () => {
    const atZero = spec({ comparisonMode: 'SIGNIFICANT_FIGURES', expectedValue: '0', significantFigures: 3 });
    expect(matches('0', atZero)).toBe(true);
    expect(matches('0.001', atZero)).toBe(false);
  });
});

describe('RANGE', () => {
  const range = spec({ comparisonMode: 'RANGE', rangeMin: '9.7', rangeMax: '9.9' });

  it('matches inside the range', () => {
    expect(matches('9.8', range)).toBe(true);
  });

  it('matches exactly on the lower bound', () => {
    expect(matches('9.7', range)).toBe(true);
  });

  it('matches exactly on the upper bound', () => {
    expect(matches('9.9', range)).toBe(true);
  });

  it('does not match just below the lower bound', () => {
    expect(matches('9.6999', range)).toBe(false);
  });

  it('does not match just above the upper bound', () => {
    expect(matches('9.9001', range)).toBe(false);
  });

  it('matches a degenerate range only at its single point', () => {
    const point = spec({ comparisonMode: 'RANGE', rangeMin: '5', rangeMax: '5' });
    expect(matches('5', point)).toBe(true);
    expect(matches('5.0001', point)).toBe(false);
  });

  it('spans zero correctly', () => {
    const spanning = spec({ comparisonMode: 'RANGE', rangeMin: '-1', rangeMax: '1' });
    expect(matches('0', spanning)).toBe(true);
    expect(matches('-1', spanning)).toBe(true);
    expect(matches('-1.1', spanning)).toBe(false);
  });

  it('ignores expectedValue entirely', () => {
    const withDecoy = spec({
      comparisonMode: 'RANGE',
      expectedValue: 'not a number at all',
      rangeMin: '1',
      rangeMax: '2',
    });
    expect(matches('1.5', withDecoy)).toBe(true);
  });

  it('reports unreadable bounds rather than guessing', () => {
    const broken = spec({ comparisonMode: 'RANGE', rangeMin: 'low', rangeMax: '9.9' });
    expect(expectError(compareNumeric('9.8', broken)).code).toBe('EXPECTED_VALUE_UNPARSEABLE');
    const brokenMax = spec({ comparisonMode: 'RANGE', rangeMin: '9.7', rangeMax: 'high' });
    expect(expectError(compareNumeric('9.8', brokenMax)).code).toBe('EXPECTED_VALUE_UNPARSEABLE');
  });
});

describe('unreadable input is not a wrong answer', () => {
  it('reports an unparseable learner value distinctly from a mismatch', () => {
    const error = expectError(compareNumeric('about nine', spec({ expectedValue: '9' })));
    expect(error.code).toBe('STUDENT_VALUE_UNPARSEABLE');
    expect(error.kind).toBe('Validation');
  });

  it('reports an unparseable expected value', () => {
    const broken = spec({ comparisonMode: 'EXACT', expectedValue: 'nine point eight' });
    expect(expectError(compareNumeric('9.8', broken)).code).toBe('EXPECTED_VALUE_UNPARSEABLE');
  });

  it('never throws, whatever it is given', () => {
    for (const value of ['', '.', '-', '1/0', 'abc', '1 234', '1,5']) {
      expect(() => compareNumeric(value, spec({ expectedValue: '1' })), value).not.toThrow();
    }
  });
});

describe('purity', () => {
  it('returns the same verdict on repeated calls', () => {
    const absolute = spec({
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      expectedValue: '9.81',
      toleranceValue: '0.01',
    });
    const verdicts = Array.from({ length: 50 }, () => matches('9.82', absolute));
    expect(new Set(verdicts).size).toBe(1);
    expect(verdicts[0]).toBe(true);
  });
});

describe('RELATIVE_TOLERANCE stays exact and canonical', () => {
  const gcd = (a: bigint, b: bigint): bigint => {
    let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
    while (y !== 0n) [x, y] = [y, x % y];
    return x;
  };

  it('multiplies rather than divides, so the band is exact', () => {
    // A third of a value has no decimal expansion. If the band were computed
    // by division through a double, this boundary would land wrong.
    const third = spec({ comparisonMode: 'RELATIVE_TOLERANCE', expectedValue: '3', toleranceValue: '1/3' });
    expect(matches('4', third)).toBe(true);
    expect(matches('2', third)).toBe(true);
    expect(matches('4.000001', third)).toBe(false);
  });

  it('produces a canonical band, so no non-reduced Rational escapes', () => {
    const band = spec({
      comparisonMode: 'RELATIVE_TOLERANCE',
      expectedValue: '200',
      toleranceValue: '0.01',
    });
    // 0.01 x 200 is 200/100 unreduced and 2/1 canonical. The comparison is
    // right either way; the invariant is what the determinism check rests on.
    const product = expectValue(parseRational('0.01'));
    const expected = expectValue(parseRational('200'));
    const combined = multiplyRational(product, expected);
    expect(gcd(combined.num, combined.den)).toBe(1n);
    expect(matches('202', band)).toBe(true);
  });
});
