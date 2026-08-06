import { err, ok, type Result } from '../result.js';

/**
 * The closed set of marking conditions (ASSESSMENT-ENGINE §2.2). Deliberately
 * not an expression language: eight predicates, exhaustively testable.
 */
export const CONDITION_KINDS = [
  'UNATTEMPTED',
  'EXACT_MATCH',
  'NO_MATCH',
  'ALL_CORRECT_SELECTED',
  'PARTIAL_CORRECT_SELECTED',
  'ANY_INCORRECT_SELECTED',
  'MATCHING_PAIRS_CORRECT',
  'ALWAYS',
] as const;

export type ConditionKind = (typeof CONDITION_KINDS)[number];

export type Condition =
  | { readonly kind: 'UNATTEMPTED' }
  | { readonly kind: 'EXACT_MATCH' }
  | { readonly kind: 'NO_MATCH' }
  | { readonly kind: 'ALL_CORRECT_SELECTED' }
  | { readonly kind: 'PARTIAL_CORRECT_SELECTED'; readonly minCorrect: number; readonly noIncorrect: boolean }
  | { readonly kind: 'ANY_INCORRECT_SELECTED' }
  | { readonly kind: 'MATCHING_PAIRS_CORRECT'; readonly count: number }
  | { readonly kind: 'ALWAYS' };

export type ConditionErrorCode = 'CONDITION_KIND_UNKNOWN' | 'MIN_CORRECT_INVALID' | 'PAIR_COUNT_INVALID';

export interface ConditionError {
  readonly kind: 'Validation';
  readonly code: ConditionErrorCode;
  readonly message: string;
}

function validationError(code: ConditionErrorCode, message: string): ConditionError {
  return { kind: 'Validation', code, message };
}

function isPositiveInteger(value: number): boolean {
  return Number.isInteger(value) && value >= 1;
}

export function createCondition(condition: Condition): Result<Condition, ConditionError> {
  switch (condition.kind) {
    case 'UNATTEMPTED':
    case 'EXACT_MATCH':
    case 'NO_MATCH':
    case 'ALL_CORRECT_SELECTED':
    case 'ANY_INCORRECT_SELECTED':
    case 'ALWAYS':
      return ok(Object.freeze({ kind: condition.kind }));

    case 'PARTIAL_CORRECT_SELECTED':
      return isPositiveInteger(condition.minCorrect)
        ? ok(
            Object.freeze({
              kind: 'PARTIAL_CORRECT_SELECTED' as const,
              minCorrect: condition.minCorrect,
              noIncorrect: condition.noIncorrect,
            }),
          )
        : err(
            validationError(
              'MIN_CORRECT_INVALID',
              `minCorrect must be an integer >= 1, got ${condition.minCorrect}`,
            ),
          );

    case 'MATCHING_PAIRS_CORRECT':
      return isPositiveInteger(condition.count)
        ? ok(Object.freeze({ kind: 'MATCHING_PAIRS_CORRECT' as const, count: condition.count }))
        : err(
            validationError('PAIR_COUNT_INVALID', `count must be an integer >= 1, got ${condition.count}`),
          );

    default:
      return err(
        validationError(
          'CONDITION_KIND_UNKNOWN',
          `unknown condition kind "${String((condition as { kind: string }).kind)}"`,
        ),
      );
  }
}

/**
 * True when `earlier` matches every response `later` would match, making
 * `later` unreachable behind it. Conservative: only relations that are certain
 * from the condition data alone are reported.
 */
export function subsumes(earlier: Condition, later: Condition): boolean {
  if (earlier.kind === 'ALWAYS') return true;
  if (earlier.kind === later.kind && earlier.kind !== 'PARTIAL_CORRECT_SELECTED') return true;

  if (earlier.kind === 'PARTIAL_CORRECT_SELECTED' && later.kind === 'PARTIAL_CORRECT_SELECTED') {
    const wider = earlier.minCorrect <= later.minCorrect;
    const equallyStrict = earlier.noIncorrect === later.noIncorrect || !earlier.noIncorrect;
    return wider && equallyStrict;
  }

  return false;
}
