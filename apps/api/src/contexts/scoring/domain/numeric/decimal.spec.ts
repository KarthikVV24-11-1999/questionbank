import { describe, expect, it } from 'vitest';
import {
  absRational,
  addRational,
  rationalToDecimalString,
  roundToDecimalPlaces,
  ZERO,
  compareRational,
  isNegative,
  isZero,
  makeRational,
  multiplyRational,
  parseRational,
  roundToSignificantFigures,
  subtractRational,
} from './decimal.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

function parsed(text: string): { num: bigint; den: bigint } {
  const value = expectValue(parseRational(text));
  return { num: value.num, den: value.den };
}

/** A readable decimal rendering, for assertions only. */
function asText(num: bigint, den: bigint, places = 12): string {
  const negative = num < 0n;
  const scaled = (negative ? -num : num) * 10n ** BigInt(places);
  const digits = (scaled / den).toString().padStart(places + 1, '0');
  const whole = digits.slice(0, digits.length - places);
  const fraction = digits.slice(digits.length - places).replace(/0+$/u, '');
  return `${negative ? '-' : ''}${whole}${fraction.length > 0 ? `.${fraction}` : ''}`;
}

describe('parsing', () => {
  it('reads an integer', () => {
    expect(parsed('42')).toEqual({ num: 42n, den: 1n });
  });

  it('reads a decimal as an exact rational, in lowest terms', () => {
    // 125/100 and 5/4 are the same value; keeping one representation is what
    // lets two equal records compare byte-identical (REL-03).
    expect(parsed('1.25')).toEqual({ num: 5n, den: 4n });
  });

  it('reads a leading-point decimal', () => {
    expect(parsed('.5')).toEqual({ num: 1n, den: 2n });
  });

  it('reads a trailing-point decimal', () => {
    expect(parsed('5.')).toEqual({ num: 5n, den: 1n });
  });

  it('reads an explicit positive sign', () => {
    expect(parsed('+7')).toEqual({ num: 7n, den: 1n });
  });

  it('reads a negative value', () => {
    expect(parsed('-1.5')).toEqual({ num: -3n, den: 2n });
  });

  it('reads a negative zero as zero', () => {
    expect(isZero(expectValue(parseRational('-0')))).toBe(true);
  });

  it('reads a positive scientific exponent', () => {
    expect(asText(...Object.values(parsed('1.5e3')) as [bigint, bigint])).toBe('1500');
  });

  it('reads a negative scientific exponent', () => {
    expect(asText(...Object.values(parsed('1.5e-3')) as [bigint, bigint])).toBe('0.0015');
  });

  it('reads an uppercase exponent', () => {
    expect(asText(...Object.values(parsed('2E2')) as [bigint, bigint])).toBe('200');
  });

  it('reads the ×10^ exponent form', () => {
    expect(asText(...Object.values(parsed('1.5×10^3')) as [bigint, bigint])).toBe('1500');
  });

  it('reads a spaced ×10^ exponent form', () => {
    expect(asText(...Object.values(parsed('1.5 × 10 ^ 3')) as [bigint, bigint])).toBe('1500');
  });

  it('reads a fraction exactly, never as a repeating decimal', () => {
    expect(parsed('2/3')).toEqual({ num: 2n, den: 3n });
  });

  it('reduces a reducible fraction to lowest terms', () => {
    expect(parsed('4/6')).toEqual({ num: 2n, den: 3n });
    expect(parsed('10/5')).toEqual({ num: 2n, den: 1n });
  });

  it('reads a fraction with a negative denominator, keeping the denominator positive', () => {
    const value = expectValue(parseRational('2/-3'));
    expect(value.den > 0n).toBe(true);
    expect(isNegative(value)).toBe(true);
  });

  it('reads a spaced fraction', () => {
    expect(parsed('3 / 4')).toEqual({ num: 3n, den: 4n });
  });

  it('reads a decimal fraction', () => {
    expect(compareRational(expectValue(parseRational('1.5/3')), makeRational(1n, 2n))).toBe(0);
  });

  it('rejects a zero denominator', () => {
    expect(expectError(parseRational('1/0')).code).toBe('ZERO_DENOMINATOR');
  });

  it('rejects an unparseable numerator', () => {
    expect(expectError(parseRational('x/3')).code).toBe('NOT_A_NUMBER');
  });

  it('rejects an unparseable denominator', () => {
    expect(expectError(parseRational('3/x')).code).toBe('NOT_A_NUMBER');
  });

  it('rejects text with no digits', () => {
    for (const text of ['', '.', '-', '+', 'abc', 'e5']) {
      expect(expectError(parseRational(text)).code, text).toBe('NOT_A_NUMBER');
    }
  });

  it('rejects a value with an internal space — a separator the flags left in place', () => {
    expect(expectError(parseRational('1 234')).code).toBe('NOT_A_NUMBER');
  });

  it('rejects a value with a comma the flags left in place', () => {
    expect(expectError(parseRational('1,5')).code).toBe('NOT_A_NUMBER');
  });

  it('handles a value far beyond double precision without loss', () => {
    const huge = `1${'0'.repeat(40)}.5`;
    const value = expectValue(parseRational(huge));
    expect(rationalToDecimalString(value, 1)).toBe(huge);
    // The same literal through a double loses the fractional part entirely.
    expect(String(Number(huge))).not.toBe(huge);
  });
});

describe('arithmetic', () => {
  it('is exact where binary floating point is not', () => {
    const tenth = expectValue(parseRational('0.1'));
    const fifth = expectValue(parseRational('0.2'));
    const threeTenths = expectValue(parseRational('0.3'));

    // 0.3 - 0.1 - 0.2 is exactly zero here. In IEEE-754 it is -5.55e-17, which
    // is enough to fail an exact comparison and cost a mark.
    expect(isZero(subtractRational(subtractRational(threeTenths, tenth), fifth))).toBe(true);
    expect(0.3 - 0.1 - 0.2).not.toBe(0);
  });

  it('compares across differing denominators', () => {
    expect(compareRational(makeRational(1n, 2n), makeRational(2n, 4n))).toBe(0);
    expect(compareRational(makeRational(1n, 3n), makeRational(1n, 2n))).toBe(-1);
    expect(compareRational(makeRational(1n, 2n), makeRational(1n, 3n))).toBe(1);
  });

  it('compares negatives correctly', () => {
    expect(compareRational(makeRational(-1n, 2n), makeRational(1n, 2n))).toBe(-1);
    expect(compareRational(makeRational(-1n, 2n), makeRational(-3n, 4n))).toBe(1);
  });

  it('subtracts', () => {
    expect(compareRational(subtractRational(makeRational(3n, 4n), makeRational(1n, 4n)), makeRational(1n, 2n))).toBe(0);
  });

  it('multiplies', () => {
    expect(compareRational(multiplyRational(makeRational(2n, 3n), makeRational(3n, 4n)), makeRational(1n, 2n))).toBe(0);
  });

  it('takes an absolute value, leaving a positive one alone', () => {
    expect(absRational(makeRational(-3n, 4n))).toEqual(makeRational(3n, 4n));
    expect(absRational(makeRational(3n, 4n))).toEqual(makeRational(3n, 4n));
  });

  it('normalizes a negative denominator on construction', () => {
    const value = makeRational(3n, -4n);
    expect(value.den > 0n).toBe(true);
    expect(value.num).toBe(-3n);
  });

  it('reports zero and sign', () => {
    expect(isZero(makeRational(0n, 5n))).toBe(true);
    expect(isZero(makeRational(1n, 5n))).toBe(false);
    expect(isNegative(makeRational(-1n, 5n))).toBe(true);
    expect(isNegative(makeRational(1n, 5n))).toBe(false);
  });
});

describe('rounding to significant figures', () => {
  const round = (text: string, figures: number): string => {
    const value = roundToSignificantFigures(expectValue(parseRational(text)), figures);
    return asText(value.num, value.den);
  };

  it('rounds a value greater than one', () => {
    expect(round('1234', 2)).toBe('1200');
    expect(round('1234', 3)).toBe('1230');
  });

  it('rounds a value less than one', () => {
    expect(round('0.001234', 2)).toBe('0.0012');
    expect(round('0.0987', 2)).toBe('0.099');
  });

  it('rounds a value at exactly a power of ten', () => {
    expect(round('100', 2)).toBe('100');
    expect(round('0.1', 3)).toBe('0.1');
  });

  it('rounds half away from zero, not to even', () => {
    expect(round('1.25', 2)).toBe('1.3');
    expect(round('1.35', 2)).toBe('1.4');
    expect(round('-1.25', 2)).toBe('-1.3');
  });

  it('rounds up across a decade boundary', () => {
    expect(round('9.99', 2)).toBe('10');
    expect(round('0.0999', 2)).toBe('0.1');
  });

  it('leaves zero as zero at any precision', () => {
    expect(round('0', 3)).toBe('0');
    expect(round('0.0', 1)).toBe('0');
  });

  it('preserves the sign', () => {
    expect(round('-1234', 2)).toBe('-1200');
  });

  it('rounds a repeating fraction', () => {
    expect(round('2/3', 3)).toBe('0.667');
    expect(round('1/3', 3)).toBe('0.333');
  });

  it('leaves a value already at the requested precision unchanged', () => {
    expect(round('1.5', 2)).toBe('1.5');
  });

  it('keeps rounding idempotent', () => {
    const once = roundToSignificantFigures(expectValue(parseRational('1.2345')), 3);
    const twice = roundToSignificantFigures(once, 3);
    expect(compareRational(once, twice)).toBe(0);
  });
});

describe('decimal rendering', () => {
  const render = (text: string, places?: number): string =>
    rationalToDecimalString(expectValue(parseRational(text)), places);

  it('renders an integer without a decimal point', () => {
    expect(render('4')).toBe('4');
    expect(render('0')).toBe('0');
  });

  it('renders a terminating decimal exactly', () => {
    expect(render('1.5')).toBe('1.5');
    expect(render('-0.25')).toBe('-0.25');
  });

  it('rounds a non-terminating value at the place limit', () => {
    // 2/3 has no exact decimal. The limit bounds the rendering rather than
    // producing endless digits; the stored value stays the exact rational.
    expect(render('2/3')).toBe('0.666667');
    expect(render('1/3')).toBe('0.333333');
  });

  it('honours a narrower place limit', () => {
    expect(render('2/3', 2)).toBe('0.67');
    expect(render('1/8', 2)).toBe('0.13');
  });

  it('rounds half away from zero', () => {
    expect(render('1/8', 2)).toBe('0.13');
    expect(render('-1/8', 2)).toBe('-0.13');
  });

  it('does not render a negative zero', () => {
    expect(render('-0.0000001')).toBe('0');
  });
});

describe('rounding to decimal places', () => {
  const round = (text: string, places: number): string =>
    rationalToDecimalString(roundToDecimalPlaces(expectValue(parseRational(text)), places));

  it('rounds a positive value half away from zero', () => {
    expect(round('1/3', 2)).toBe('0.33');
    expect(round('2/3', 2)).toBe('0.67');
    expect(round('0.125', 2)).toBe('0.13');
  });

  it('rounds a negative value half away from zero', () => {
    expect(round('-1/3', 2)).toBe('-0.33');
    expect(round('-2/3', 2)).toBe('-0.67');
    expect(round('-0.125', 2)).toBe('-0.13');
  });

  it('rounds to whole numbers', () => {
    expect(round('2.5', 0)).toBe('3');
    expect(round('-2.5', 0)).toBe('-3');
  });

  it('leaves an exact value alone', () => {
    expect(round('1.5', 2)).toBe('1.5');
    expect(round('-4', 2)).toBe('-4');
  });
});

describe('addition and the zero constant', () => {
  it('adds across differing denominators', () => {
    expect(rationalToDecimalString(addRational(makeRational(1n, 3n), makeRational(1n, 6n)))).toBe('0.5');
  });

  it('adds a negative', () => {
    expect(rationalToDecimalString(addRational(makeRational(4n, 1n), makeRational(-1n, 1n)))).toBe('3');
  });

  it('leaves a value unchanged when added to zero', () => {
    expect(compareRational(addRational(ZERO, makeRational(7n, 2n)), makeRational(7n, 2n))).toBe(0);
  });

  it('declares zero as zero', () => {
    expect(isZero(ZERO)).toBe(true);
  });
});

describe('canonicality is an invariant, not a convention', () => {
  const gcd = (a: bigint, b: bigint): bigint => {
    let [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b];
    while (y !== 0n) [x, y] = [y, x % y];
    return x;
  };
  const isCanonical = (value: { num: bigint; den: bigint }): boolean =>
    value.den > 0n && gcd(value.num, value.den) === 1n;

  it('holds for every constructor and operation', () => {
    const a = expectValue(parseRational('1.25'));
    const b = expectValue(parseRational('0.5'));
    const values = [
      a,
      b,
      ZERO,
      addRational(a, b),
      subtractRational(a, b),
      multiplyRational(a, b),
      absRational(makeRational(-4n, 6n)),
      roundToDecimalPlaces(expectValue(parseRational('2/3')), 4),
      roundToSignificantFigures(expectValue(parseRational('1234')), 2),
      makeRational(4000n, 10000n),
    ];
    for (const [index, value] of values.entries()) {
      expect(isCanonical(value), `value ${index}: ${value.num}/${value.den}`).toBe(true);
    }
  });

  it('reduces a value read back at the database scale to the one it was written from', () => {
    // 4 written as numeric(14,4) reads back as "4.0000". Structural equality is
    // what the determinism soak compares, so the two must be identical.
    expect(expectValue(parseRational('4.0000'))).toEqual(expectValue(parseRational('4')));
    expect(expectValue(parseRational('0.0000'))).toEqual(ZERO);
  });
});
