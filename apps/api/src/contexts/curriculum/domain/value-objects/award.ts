import { err, ok, type Result } from '../result.js';

/** The closed set of awards (ASSESSMENT-ENGINE §2.3). */
export const AWARD_KINDS = ['FIXED', 'PER_CORRECT', 'FULL_MARKS'] as const;

export type AwardKind = (typeof AWARD_KINDS)[number];

export type Award =
  | { readonly kind: 'FIXED'; readonly marks: number }
  | { readonly kind: 'PER_CORRECT'; readonly marks: number }
  | { readonly kind: 'FULL_MARKS' };

export type AwardErrorCode = 'AWARD_KIND_UNKNOWN' | 'MARKS_INVALID';

export interface AwardError {
  readonly kind: 'Validation';
  readonly code: AwardErrorCode;
  readonly message: string;
}

function validationError(code: AwardErrorCode, message: string): AwardError {
  return { kind: 'Validation', code, message };
}

export function createAward(award: Award): Result<Award, AwardError> {
  switch (award.kind) {
    case 'FIXED':
    case 'PER_CORRECT':
      return Number.isFinite(award.marks)
        ? ok(Object.freeze({ kind: award.kind, marks: award.marks }))
        : err(validationError('MARKS_INVALID', `marks must be a finite number, got ${award.marks}`));

    case 'FULL_MARKS':
      return ok(Object.freeze({ kind: 'FULL_MARKS' as const }));

    default:
      return err(
        validationError(
          'AWARD_KIND_UNKNOWN',
          `unknown award kind "${String((award as { kind: string }).kind)}"`,
        ),
      );
  }
}
