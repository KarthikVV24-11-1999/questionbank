import { err, ok, type Result } from '../result.js';
import { ruleViolationError, type ScoringError } from '../scoring-error.js';
import type { Award } from '../marking-rule-data.js';
import { makeRational, multiplyRational, rationalFromNumber, type Rational } from '../numeric/decimal.js';

/**
 * The three awards (ASSESSMENT-ENGINE §2.3), applied.
 *
 * Marks are carried as exact rationals for the same reason values are: a
 * partial-credit scheme can award 1.5, and summing eighty of those in binary
 * floating point drifts. The drift is small; the difference between a rank and
 * the next one is smaller.
 */

export interface AwardContext {
  /** The slot's `marksAvailable`, paid in full by `FULL_MARKS`. */
  readonly marksAvailable: number;
  /** How many of the learner's selections were correct — `PER_CORRECT`'s multiplier. */
  readonly correctSelectionCount: number;
}

export type AwardErrorCode = 'AWARD_KIND_UNKNOWN' | 'AWARD_MARKS_INVALID';

export type ApplyAwardError = ScoringError<AwardErrorCode>;

export function applyAward(award: Award, context: AwardContext): Result<Rational, ApplyAwardError> {
  switch (award.kind) {
    case 'FIXED': {
      const marks = rationalFromNumber(award.marks);
      return marks.ok
        ? ok(marks.value)
        : err(ruleViolationError('AWARD_MARKS_INVALID', `FIXED marks ${award.marks} is not a finite number`));
    }

    case 'PER_CORRECT': {
      const marks = rationalFromNumber(award.marks);
      if (!marks.ok) {
        return err(
          ruleViolationError('AWARD_MARKS_INVALID', `PER_CORRECT marks ${award.marks} is not a finite number`),
        );
      }
      // Zero correct selections award zero, whatever the sign of the marks.
      const multiplier = makeRational(BigInt(Math.max(context.correctSelectionCount, 0)), 1n);
      return ok(multiplyRational(marks.value, multiplier));
    }

    case 'FULL_MARKS': {
      const available = rationalFromNumber(context.marksAvailable);
      return available.ok
        ? ok(available.value)
        : err(
            ruleViolationError(
              'AWARD_MARKS_INVALID',
              `marksAvailable ${context.marksAvailable} is not a finite number`,
            ),
          );
    }

    default:
      // Fail closed (§8): an award kind this executor does not understand
      // yields no mark at all rather than a guess. Guessing zero silently
      // would be an undetectable scoring defect; guessing anything else could
      // deduct a mark on an award nobody wrote.
      return err(
        ruleViolationError(
          'AWARD_KIND_UNKNOWN',
          `unknown award kind "${String((award as { kind: string }).kind)}"`,
        ),
      );
  }
}
