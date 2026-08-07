import { err, ok, type Result } from './result.js';
import { validationError, type ScoringError } from './scoring-error.js';

/**
 * What "correct" means for one slot, as data.
 *
 * The numeric shape below mirrors `NumericAnswerSpecData` on the curriculum
 * barrel structurally rather than importing it: `domain/` imports nothing
 * (§9 rule 2), and that does not soften for a DTO any more than it did for
 * `Result`. `answer-key.spec.ts` asserts the two remain assignable, so a change
 * to M1's DTO surfaces as a failing test rather than as a scoring defect.
 *
 * **Answer keys never reach a client** (§9 rule 10). The spec at the foot of
 * this file's test asserts that no API DTO or contract document carries one.
 */

/** The authored decimal literal, never a float — `SIGNIFICANT_FIGURES` depends on the text. */
export type DecimalString = string;

export const COMPARISON_MODES = [
  'EXACT',
  'ABSOLUTE_TOLERANCE',
  'RELATIVE_TOLERANCE',
  'SIGNIFICANT_FIGURES',
  'RANGE',
] as const;
export type ComparisonMode = (typeof COMPARISON_MODES)[number];

export const ANSWER_FORMS = ['DECIMAL', 'FRACTION', 'SCIENTIFIC'] as const;
export type AnswerForm = (typeof ANSWER_FORMS)[number];

export interface UnitSpec {
  readonly canonical: string;
  readonly acceptedEquivalents: readonly string[];
  readonly required: boolean;
}

export interface NormalizationFlags {
  readonly trimWhitespace: boolean;
  readonly stripThousandsSeparator: boolean;
  readonly unicodeMinusToAscii: boolean;
  readonly caseInsensitiveUnit: boolean;
}

export const DEFAULT_NORMALIZATION: NormalizationFlags = Object.freeze({
  trimWhitespace: true,
  stripThousandsSeparator: true,
  unicodeMinusToAscii: true,
  caseInsensitiveUnit: true,
});

/** The barrel DTO's shape (D-001), with normalization optional as authored. */
export interface NumericAnswerSpecData {
  readonly expectedValue: DecimalString;
  readonly comparisonMode: ComparisonMode;
  readonly toleranceValue?: DecimalString;
  readonly significantFigures?: number;
  readonly rangeMin?: DecimalString;
  readonly rangeMax?: DecimalString;
  readonly unit?: UnitSpec;
  readonly acceptedForms: readonly AnswerForm[];
  readonly normalization?: Partial<NormalizationFlags>;
}

/** The same specification with every normalization flag resolved, ready to evaluate. */
export interface NumericAnswerSpecResolved extends Omit<NumericAnswerSpecData, 'normalization'> {
  readonly normalization: NormalizationFlags;
}

export interface AnswerKeyPair {
  readonly left: string;
  readonly right: string;
}

export type AnswerKey =
  | { readonly kind: 'SINGLE_CORRECT'; readonly optionId: string }
  | { readonly kind: 'MULTI_CORRECT'; readonly correctOptionIds: readonly string[] }
  | { readonly kind: 'MATCHING'; readonly pairs: readonly AnswerKeyPair[] }
  | { readonly kind: 'NUMERIC'; readonly spec: NumericAnswerSpecResolved };

export type AnswerKeyKind = AnswerKey['kind'];

/**
 * Item type to key variant, deliberately closed.
 *
 * EXT-03 promises that a *marking rule* arrives as data with no code change.
 * It does not promise that of an item type: a new item type is a new way for
 * an answer to be right, and there is no data-only expression of that. A type
 * this file does not know is refused rather than guessed at.
 */
export const KEY_KIND_BY_ITEM_TYPE = Object.freeze({
  SINGLE_CORRECT_MCQ: 'SINGLE_CORRECT',
  MULTIPLE_CORRECT_MCQ: 'MULTI_CORRECT',
  MATCHING: 'MATCHING',
  NUMERIC: 'NUMERIC',
} as const satisfies Record<string, AnswerKeyKind>);

export type KnownItemType = keyof typeof KEY_KIND_BY_ITEM_TYPE;

export function isKnownItemType(itemType: string): itemType is KnownItemType {
  return Object.hasOwn(KEY_KIND_BY_ITEM_TYPE, itemType);
}

export type AnswerKeyErrorCode =
  | 'OPTION_ID_REQUIRED'
  | 'CORRECT_OPTIONS_REQUIRED'
  | 'CORRECT_OPTION_BLANK'
  | 'CORRECT_OPTION_DUPLICATE'
  | 'PAIRS_REQUIRED'
  | 'PAIR_MEMBER_BLANK'
  | 'PAIR_LEFT_DUPLICATE'
  | 'EXPECTED_VALUE_REQUIRED'
  | 'COMPARISON_MODE_UNKNOWN'
  | 'TOLERANCE_VALUE_REQUIRED'
  | 'SIGNIFICANT_FIGURES_REQUIRED'
  | 'RANGE_BOUNDS_REQUIRED'
  | 'RANGE_BOUNDS_INVERTED'
  | 'ACCEPTED_FORMS_REQUIRED'
  | 'ACCEPTED_FORM_UNKNOWN'
  | 'UNIT_CANONICAL_REQUIRED'
  | 'ITEM_TYPE_UNKNOWN'
  | 'KEY_VARIANT_MISMATCH';

export type AnswerKeyError = ScoringError<AnswerKeyErrorCode>;

function invalid(code: AnswerKeyErrorCode, message: string): AnswerKeyError {
  return validationError(code, message);
}

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function firstDuplicate(values: readonly string[]): string | undefined {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) return value;
    seen.add(value);
  }
  return undefined;
}

function resolveNumericSpec(spec: NumericAnswerSpecData): Result<NumericAnswerSpecResolved, AnswerKeyError> {
  if (isBlank(spec.expectedValue)) {
    return err(invalid('EXPECTED_VALUE_REQUIRED', 'a numeric key requires an expectedValue'));
  }
  if (!(COMPARISON_MODES as readonly string[]).includes(spec.comparisonMode)) {
    return err(invalid('COMPARISON_MODE_UNKNOWN', `unknown comparison mode "${spec.comparisonMode}"`));
  }

  // D-001 rule 5: a mode missing its parameter is invalid, not a runtime surprise.
  switch (spec.comparisonMode) {
    case 'ABSOLUTE_TOLERANCE':
    case 'RELATIVE_TOLERANCE':
      if (spec.toleranceValue === undefined || isBlank(spec.toleranceValue)) {
        return err(
          invalid('TOLERANCE_VALUE_REQUIRED', `${spec.comparisonMode} requires a toleranceValue`),
        );
      }
      break;
    case 'SIGNIFICANT_FIGURES': {
      const figures = spec.significantFigures;
      if (figures === undefined || !Number.isInteger(figures) || figures < 1) {
        return err(
          invalid(
            'SIGNIFICANT_FIGURES_REQUIRED',
            `SIGNIFICANT_FIGURES requires significantFigures as an integer >= 1, got ${figures}`,
          ),
        );
      }
      break;
    }
    case 'RANGE':
      if (
        spec.rangeMin === undefined ||
        spec.rangeMax === undefined ||
        isBlank(spec.rangeMin) ||
        isBlank(spec.rangeMax)
      ) {
        return err(invalid('RANGE_BOUNDS_REQUIRED', 'RANGE requires both rangeMin and rangeMax'));
      }
      if (Number(spec.rangeMin) > Number(spec.rangeMax)) {
        return err(
          invalid('RANGE_BOUNDS_INVERTED', `rangeMin ${spec.rangeMin} exceeds rangeMax ${spec.rangeMax}`),
        );
      }
      break;
    case 'EXACT':
      break;
  }

  if (spec.acceptedForms.length === 0) {
    return err(invalid('ACCEPTED_FORMS_REQUIRED', 'a numeric key requires at least one accepted form'));
  }
  const unknownForm = spec.acceptedForms.find((form) => !(ANSWER_FORMS as readonly string[]).includes(form));
  if (unknownForm !== undefined) {
    return err(invalid('ACCEPTED_FORM_UNKNOWN', `unknown accepted form "${unknownForm}"`));
  }

  if (spec.unit !== undefined && isBlank(spec.unit.canonical)) {
    return err(invalid('UNIT_CANONICAL_REQUIRED', 'a unit requires a canonical form'));
  }

  return ok(
    Object.freeze({
      ...spec,
      acceptedForms: Object.freeze([...spec.acceptedForms]),
      ...(spec.unit !== undefined
        ? {
            unit: Object.freeze({
              ...spec.unit,
              acceptedEquivalents: Object.freeze([...spec.unit.acceptedEquivalents]),
            }),
          }
        : {}),
      normalization: Object.freeze({ ...DEFAULT_NORMALIZATION, ...spec.normalization }),
    }),
  );
}

export interface CreateAnswerKeyProps {
  readonly kind: AnswerKeyKind;
  readonly optionId?: string;
  readonly correctOptionIds?: readonly string[];
  readonly pairs?: readonly AnswerKeyPair[];
  readonly spec?: NumericAnswerSpecData;
}

export function createAnswerKey(props: CreateAnswerKeyProps): Result<AnswerKey, AnswerKeyError> {
  switch (props.kind) {
    case 'SINGLE_CORRECT': {
      const optionId = props.optionId ?? '';
      return isBlank(optionId)
        ? err(invalid('OPTION_ID_REQUIRED', 'a single-correct key requires an optionId'))
        : ok(Object.freeze({ kind: 'SINGLE_CORRECT' as const, optionId }));
    }

    case 'MULTI_CORRECT': {
      const ids = props.correctOptionIds ?? [];
      if (ids.length === 0) {
        return err(invalid('CORRECT_OPTIONS_REQUIRED', 'a multi-correct key requires at least one correct option'));
      }
      if (ids.some(isBlank)) {
        return err(invalid('CORRECT_OPTION_BLANK', 'a multi-correct key must not contain a blank option'));
      }
      const duplicate = firstDuplicate([...ids]);
      if (duplicate !== undefined) {
        return err(invalid('CORRECT_OPTION_DUPLICATE', `option ${duplicate} appears more than once`));
      }
      return ok(Object.freeze({ kind: 'MULTI_CORRECT' as const, correctOptionIds: Object.freeze([...ids]) }));
    }

    case 'MATCHING': {
      const pairs = props.pairs ?? [];
      if (pairs.length === 0) {
        return err(invalid('PAIRS_REQUIRED', 'a matching key requires at least one pair'));
      }
      if (pairs.some((pair) => isBlank(pair.left) || isBlank(pair.right))) {
        return err(invalid('PAIR_MEMBER_BLANK', 'a matching pair must have a non-blank left and right'));
      }
      const duplicateLeft = firstDuplicate(pairs.map((pair) => pair.left));
      if (duplicateLeft !== undefined) {
        return err(
          invalid('PAIR_LEFT_DUPLICATE', `left member ${duplicateLeft} is matched more than once`),
        );
      }
      return ok(
        Object.freeze({
          kind: 'MATCHING' as const,
          pairs: Object.freeze(pairs.map((pair) => Object.freeze({ ...pair }))),
        }),
      );
    }

    case 'NUMERIC': {
      if (props.spec === undefined) {
        return err(invalid('EXPECTED_VALUE_REQUIRED', 'a numeric key requires a NumericAnswerSpec'));
      }
      const resolved = resolveNumericSpec(props.spec);
      return resolved.ok
        ? ok(Object.freeze({ kind: 'NUMERIC' as const, spec: resolved.value }))
        : err(resolved.error);
    }
  }
}

/**
 * A key whose variant does not match the slot's item type would be scored
 * against the wrong comparison entirely, so the pairing is refused rather than
 * coerced.
 */
export function checkKeyMatchesItemType(key: AnswerKey, itemType: string): Result<true, AnswerKeyError> {
  if (!isKnownItemType(itemType)) {
    return err(invalid('ITEM_TYPE_UNKNOWN', `item type "${itemType}" has no answer-key variant`));
  }
  const expected = KEY_KIND_BY_ITEM_TYPE[itemType];
  return key.kind === expected
    ? ok(true)
    : err(
        invalid('KEY_VARIANT_MISMATCH', `item type ${itemType} expects a ${expected} key, got ${key.kind}`),
      );
}
