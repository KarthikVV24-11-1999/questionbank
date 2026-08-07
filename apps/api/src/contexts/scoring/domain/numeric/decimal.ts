import { err, ok, type Result } from '../result.js';
import { validationError, type ScoringError } from '../scoring-error.js';

/**
 * Exact arithmetic for scoring. **No IEEE-754 anywhere in this file.**
 *
 * `0.1 + 0.2 !== 0.3` in binary floating point. A tolerance comparison decided
 * by that difference is a mark decided by it, so every value here is an exact
 * rational — a pair of arbitrary-precision integers — and every operation is
 * integer arithmetic. `2/3` is held as two over three, not as 0.6666666666667.
 *
 * The denominator is always positive; the sign lives in the numerator, so
 * comparison never has to reason about two sign bits.
 */
export interface Rational {
  readonly num: bigint;
  readonly den: bigint;
}

export type DecimalErrorCode = 'NOT_A_NUMBER' | 'ZERO_DENOMINATOR';

export type DecimalError = ScoringError<DecimalErrorCode>;

/** Optional sign, digits with an optional fractional part, optional exponent in either form. */
const PLAIN_OR_SCIENTIFIC = /^([+-]?)(\d*)(?:\.(\d*))?(?:\s*(?:[eE]|[×x*]\s*10\s*\^)\s*([+-]?\d+))?$/u;

function tenToThe(power: number): bigint {
  return 10n ** BigInt(power);
}

/** `divisor` is always a positive denominator, so only the numerator needs folding. */
function greatestCommonDivisor(value: bigint, divisor: bigint): bigint {
  let a = value < 0n ? -value : value;
  let b = divisor;
  while (b !== 0n) {
    const remainder = a % b;
    a = b;
    b = remainder;
  }
  return a;
}

/**
 * Rationals are kept in lowest terms with a positive denominator, so a value
 * has exactly one representation. Without that, four tenths read back from a
 * `numeric(14,4)` column is `4000/10000` while the same value computed in
 * memory is `2/5` — equal by comparison, unequal by structure. Determinism
 * (REL-03) is asserted on byte-identical records, so equal values have to
 * *look* equal too.
 *
 * The denominator is never zero: `parseRational` rejects it and no operation
 * can introduce one, so the divisor here is always at least one.
 */
export function makeRational(num: bigint, den: bigint): Rational {
  const sign = den < 0n ? -1n : 1n;
  const signedNum = num * sign;
  const signedDen = den * sign;
  const divisor = greatestCommonDivisor(signedNum, signedDen);
  return Object.freeze({ num: signedNum / divisor, den: signedDen / divisor });
}

export function isZero(value: Rational): boolean {
  return value.num === 0n;
}

export function isNegative(value: Rational): boolean {
  return value.num < 0n;
}

export function absRational(value: Rational): Rational {
  return value.num < 0n ? makeRational(-value.num, value.den) : value;
}

/** −1, 0 or 1. Cross-multiplication is exact because both denominators are positive. */
export function compareRational(left: Rational, right: Rational): -1 | 0 | 1 {
  const leftScaled = left.num * right.den;
  const rightScaled = right.num * left.den;
  if (leftScaled < rightScaled) return -1;
  if (leftScaled > rightScaled) return 1;
  return 0;
}

export function addRational(left: Rational, right: Rational): Rational {
  return makeRational(left.num * right.den + right.num * left.den, left.den * right.den);
}

export const ZERO: Rational = Object.freeze({ num: 0n, den: 1n });

/** Rounds half away from zero to a fixed number of decimal places. */
export function roundToDecimalPlaces(value: Rational, places: number): Rational {
  const negative = isNegative(value);
  const magnitude = absRational(value);
  const scale = tenToThe(places);
  const scaled = magnitude.num * scale;

  let quotient = scaled / magnitude.den;
  if ((scaled % magnitude.den) * 2n >= magnitude.den) quotient += 1n;

  const rounded = makeRational(quotient, scale);
  return negative ? makeRational(-rounded.num, rounded.den) : rounded;
}

export function subtractRational(left: Rational, right: Rational): Rational {
  return makeRational(left.num * right.den - right.num * left.den, left.den * right.den);
}

export function multiplyRational(left: Rational, right: Rational): Rational {
  return makeRational(left.num * right.num, left.den * right.den);
}

function parsePlainOrScientific(text: string): Result<Rational, DecimalError> {
  const match = PLAIN_OR_SCIENTIFIC.exec(text);
  if (match === null) {
    return err(validationError('NOT_A_NUMBER', `"${text}" is not a number`));
  }

  const [, sign = '', integerPart = '', fractionPart = '', exponentPart] = match;

  // `.`, `-` and `` all match the shape above but carry no digits.
  if (integerPart.length === 0 && fractionPart.length === 0) {
    return err(validationError('NOT_A_NUMBER', `"${text}" is not a number`));
  }

  const digits = BigInt(`${integerPart}${fractionPart}`);
  const exponent = exponentPart === undefined ? 0 : Number(exponentPart);
  const scale = fractionPart.length - exponent;

  const magnitude = scale >= 0 ? makeRational(digits, tenToThe(scale)) : makeRational(digits * tenToThe(-scale), 1n);

  return ok(sign === '-' ? makeRational(-magnitude.num, magnitude.den) : magnitude);
}

/**
 * Parses a normalized entry in any of the three accepted forms. Whether that
 * form was *permitted* is M2-06's question; this only turns text into a value.
 */
export function parseRational(text: string): Result<Rational, DecimalError> {
  const slash = text.indexOf('/');
  if (slash === -1) {
    return parsePlainOrScientific(text.trim());
  }

  const numerator = parsePlainOrScientific(text.slice(0, slash).trim());
  if (!numerator.ok) return err(numerator.error);

  const denominator = parsePlainOrScientific(text.slice(slash + 1).trim());
  if (!denominator.ok) return err(denominator.error);

  if (isZero(denominator.value)) {
    return err(validationError('ZERO_DENOMINATOR', `"${text}" divides by zero`));
  }

  return ok(
    makeRational(
      numerator.value.num * denominator.value.den,
      numerator.value.den * denominator.value.num,
    ),
  );
}

/**
 * An exact rational for a JavaScript number, taken through its shortest
 * decimal representation. `String(1.5)` is `"1.5"`, which is 15/10 exactly —
 * so mark values authored as decimals survive into the arithmetic intact
 * rather than as the nearest double.
 */
export function rationalFromNumber(value: number): Result<Rational, DecimalError> {
  return Number.isFinite(value)
    ? parseRational(String(value))
    : err(validationError('NOT_A_NUMBER', `${String(value)} is not a finite number`));
}

/**
 * A decimal rendering, for explanations and for the database. Mark values are
 * terminating decimals in every scheme the engine supports; `maxPlaces` bounds
 * the rendering so a value that somehow is not cannot produce endless digits.
 */
export function rationalToDecimalString(value: Rational, maxPlaces = 6): string {
  const negative = isNegative(value);
  const magnitude = absRational(value);
  const scaled = magnitude.num * tenToThe(maxPlaces);

  let quotient = scaled / magnitude.den;
  const remainder = scaled % magnitude.den;
  if (remainder * 2n >= magnitude.den) quotient += 1n;

  const digits = quotient.toString().padStart(maxPlaces + 1, '0');
  const whole = digits.slice(0, digits.length - maxPlaces);
  const fraction = digits.slice(digits.length - maxPlaces).replace(/0+$/u, '');
  const rendered = fraction.length > 0 ? `${whole}.${fraction}` : whole;

  return negative && quotient !== 0n ? `-${rendered}` : rendered;
}

/** Digit count of a non-negative integer — the only callers pass magnitudes. */
function digitCount(value: bigint): number {
  return value.toString().length;
}

/**
 * The decimal exponent of a non-zero value: the `e` for which
 * `10^e <= |value| < 10^(e+1)`.
 *
 * The digit-count estimate is `floor(log10 num) - floor(log10 den)`, and the
 * true exponent is `floor(log10 num - log10 den)`. The latter is either equal
 * to the former or one less, never more — so the estimate can only be too
 * high, and correcting downward is the only direction needed. The loop runs at
 * most once.
 */
function decimalExponent(value: Rational): number {
  const magnitude = absRational(value);
  let exponent = digitCount(magnitude.num) - digitCount(magnitude.den);

  while (magnitude.num * tenToThe(Math.max(-exponent, 0)) < magnitude.den * tenToThe(Math.max(exponent, 0))) {
    exponent -= 1;
  }

  return exponent;
}

/**
 * Rounds to `figures` significant digits, half **away from zero** — the
 * convention a candidate is taught, and stated rather than inherited from
 * whatever the language happens to do.
 */
export function roundToSignificantFigures(value: Rational, figures: number): Rational {
  if (isZero(value)) return value;

  const negative = isNegative(value);
  const magnitude = absRational(value);
  const scale = figures - 1 - decimalExponent(magnitude);

  const scaledNum = scale >= 0 ? magnitude.num * tenToThe(scale) : magnitude.num;
  const scaledDen = scale >= 0 ? magnitude.den : magnitude.den * tenToThe(-scale);

  let quotient = scaledNum / scaledDen;
  const remainder = scaledNum % scaledDen;
  if (remainder * 2n >= scaledDen) quotient += 1n;

  const rounded =
    scale >= 0 ? makeRational(quotient, tenToThe(scale)) : makeRational(quotient * tenToThe(-scale), 1n);

  return negative ? makeRational(-rounded.num, rounded.den) : rounded;
}
