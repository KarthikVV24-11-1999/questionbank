import type { NumericAnswerSpecResolved } from '../answer-key.js';

/**
 * Unit handling (D-001 rule 3).
 *
 * `missing` is deliberately not `mismatch`. A learner who computed the right
 * number and omitted `m/s^2` has not given a wrong answer; the engine simply
 * cannot tell whether the response satisfies a spec that demands a unit. That
 * is indeterminate, and an indeterminate response must fall through to the
 * terminal rule for 0 rather than match `NO_MATCH` and lose a mark (ADR-0003).
 */
export type UnitOutcome = 'not_required' | 'match' | 'mismatch' | 'missing';

function fold(text: string, caseInsensitive: boolean): string {
  const trimmed = text.trim();
  return caseInsensitive ? trimmed.toLowerCase() : trimmed;
}

export function checkUnit(studentUnit: string, spec: NumericAnswerSpecResolved): UnitOutcome {
  const unit = spec.unit;

  // No unit authored, or one authored but not demanded: whatever the learner
  // wrote is stripped rather than compared (D-001 rule 3).
  if (unit === undefined || !unit.required) return 'not_required';

  const caseInsensitive = spec.normalization.caseInsensitiveUnit;
  const supplied = fold(studentUnit, caseInsensitive);
  if (supplied.length === 0) return 'missing';

  const accepted = [unit.canonical, ...unit.acceptedEquivalents].map((form) => fold(form, caseInsensitive));
  return accepted.includes(supplied) ? 'match' : 'mismatch';
}
