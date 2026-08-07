import { err, ok, type Result } from '../result.js';
import { validationError, type ScoringError } from '../scoring-error.js';
import type { ComparisonMode, NumericAnswerSpecResolved } from '../answer-key.js';
import {
  absRational,
  compareRational,
  isZero,
  multiplyRational,
  parseRational,
  roundToSignificantFigures,
  subtractRational,
  type Rational,
} from './decimal.js';

/**
 * The five comparison modes (D-001), evaluated on exact rationals.
 *
 * Every boundary is **inclusive**: a candidate landing exactly on the stated
 * tolerance has met it. Excluding the boundary would deny a mark to the one
 * answer the tolerance was written to admit.
 */

export type CompareErrorCode = 'STUDENT_VALUE_UNPARSEABLE' | 'EXPECTED_VALUE_UNPARSEABLE' | 'TOLERANCE_UNPARSEABLE';

export type CompareError = ScoringError<CompareErrorCode>;

function unparseable(code: CompareErrorCode, message: string): CompareError {
  return validationError(code, message);
}

function withinAbsoluteTolerance(student: Rational, expected: Rational, tolerance: Rational): boolean {
  return compareRational(absRational(subtractRational(student, expected)), absRational(tolerance)) <= 0;
}

/**
 * Compares a learner's already-normalized value against the specification.
 *
 * Returns `false` for a genuine mismatch and an error for an entry that cannot
 * be read at all. The two are different outcomes upstream: a mismatch is a
 * wrong answer, an unreadable entry is indeterminate and must not be judged
 * wrong (ADR-0003).
 */
export function compareNumeric(
  studentValue: string,
  spec: NumericAnswerSpecResolved,
): Result<boolean, CompareError> {
  const student = parseRational(studentValue);
  if (!student.ok) {
    return err(unparseable('STUDENT_VALUE_UNPARSEABLE', `"${studentValue}" cannot be read as a number`));
  }

  const mode: ComparisonMode = spec.comparisonMode;

  if (mode === 'RANGE') {
    const min = parseRational(spec.rangeMin as string);
    const max = parseRational(spec.rangeMax as string);
    if (!min.ok || !max.ok) {
      return err(unparseable('EXPECTED_VALUE_UNPARSEABLE', 'the range bounds cannot be read as numbers'));
    }
    const aboveMin = compareRational(student.value, min.value) >= 0;
    const belowMax = compareRational(student.value, max.value) <= 0;
    return ok(aboveMin && belowMax);
  }

  const expected = parseRational(spec.expectedValue);
  if (!expected.ok) {
    return err(
      unparseable('EXPECTED_VALUE_UNPARSEABLE', `expected value "${spec.expectedValue}" cannot be read`),
    );
  }

  switch (mode) {
    case 'EXACT':
      return ok(compareRational(student.value, expected.value) === 0);

    case 'ABSOLUTE_TOLERANCE': {
      const tolerance = parseRational(spec.toleranceValue as string);
      if (!tolerance.ok) {
        return err(unparseable('TOLERANCE_UNPARSEABLE', `tolerance "${spec.toleranceValue}" cannot be read`));
      }
      return ok(withinAbsoluteTolerance(student.value, expected.value, tolerance.value));
    }

    case 'RELATIVE_TOLERANCE': {
      const fraction = parseRational(spec.toleranceValue as string);
      if (!fraction.ok) {
        return err(unparseable('TOLERANCE_UNPARSEABLE', `tolerance "${spec.toleranceValue}" cannot be read`));
      }
      // A relative tolerance of an expected zero is zero, which would admit
      // only an exact zero and silently turn the mode into EXACT. Falling back
      // to the same figure read absolutely keeps the authored width.
      // multiplyRational, not a raw literal: every Rational must stay in
      // lowest terms, or two equal values can differ structurally and the
      // byte-identity determinism check stops meaning anything (M2-20).
      // Multiplication only — there is no division here, so the band is exact.
      const tolerance = isZero(expected.value)
        ? fraction.value
        : multiplyRational(fraction.value, absRational(expected.value));
      return ok(withinAbsoluteTolerance(student.value, expected.value, absRational(tolerance)));
    }

    case 'SIGNIFICANT_FIGURES': {
      const figures = spec.significantFigures as number;
      const roundedStudent = roundToSignificantFigures(student.value, figures);
      const roundedExpected = roundToSignificantFigures(expected.value, figures);
      return ok(compareRational(roundedStudent, roundedExpected) === 0);
    }
  }
}
