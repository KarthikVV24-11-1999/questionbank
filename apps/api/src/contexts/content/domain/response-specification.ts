import { err, ok, type Result } from './result.js';
import { validationError, type ContentError } from './content-error.js';
import type { ContentBody } from './content-body.js';

/**
 * `ResponseSpecification` — how an item is answered, and what "correct" means
 * (DOMAIN-MODEL §5).
 *
 * **This is where the answer key lives** (DEC-3). The specification carries the
 * presentation and the key together because they are authored together and
 * because separating them invites the two to disagree: an option list edited
 * without its `correctOptionId` is a wrong key, not a layout change. M3-08
 * projects the key half into the shape `scoring/public/` consumes, and that
 * projection is what the executor sees — never this type.
 *
 * **It never reaches a delivery payload** (§9 rule 10, ADR-0009). The authoring
 * DTO family carries it; nothing else may. M3-29, M3-33 and M3-44 assert that
 * in three places, because one place is a place somebody edits.
 *
 * **An option body is a `ContentBody`, not a string.** An option routinely *is*
 * an equation — `\frac{1}{2}mv^2` is a perfectly ordinary distractor — and the
 * category's standard mistake is storing option text as a string, which forces
 * either an image of the equation or markup smuggled into a text field. Both
 * are INV-14 violations that are then impossible to walk back.
 *
 * The item-type vocabulary is **closed and mirrored** from scoring's. M3-08
 * asserts the two are equal, so adding a type in one context fails the build
 * until it is added in both.
 */

export const ITEM_TYPES = ['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC'] as const;
export type ItemType = (typeof ITEM_TYPES)[number];

/** v1 authoring surface (FR-TCH-02 rule 2). The other two are modeled, not exposed. */
export const V1_AUTHORED_ITEM_TYPES = ['SINGLE_CORRECT_MCQ', 'NUMERIC'] as const satisfies readonly ItemType[];

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

/**
 * The numeric specification as authored (D-001).
 *
 * `expectedValue` and the bounds are **decimal strings**, never numbers. The
 * authored literal is what `SIGNIFICANT_FIGURES` counts figures in, and it is
 * what ADR-0007's exactness rests on — parsing `0.1` into a double here would
 * lose the thing the whole scoring pipeline exists to preserve.
 */
export interface NumericAnswerSpecData {
  readonly expectedValue: string;
  readonly comparisonMode: ComparisonMode;
  readonly toleranceValue?: string;
  readonly significantFigures?: number;
  readonly rangeMin?: string;
  readonly rangeMax?: string;
  readonly unit?: UnitSpec;
  readonly acceptedForms: readonly AnswerForm[];
  readonly normalization?: Partial<NormalizationFlags>;
}

export interface ItemOption {
  readonly optionId: string;
  readonly ordinal: number;
  readonly body: ContentBody;
}

export interface MatchingMember {
  readonly memberId: string;
  readonly ordinal: number;
  readonly body: ContentBody;
}

export interface MatchingPair {
  readonly left: string;
  readonly right: string;
}

export type ResponseSpecification =
  | {
      readonly itemType: 'SINGLE_CORRECT_MCQ';
      readonly options: readonly ItemOption[];
      readonly correctOptionId: string;
    }
  | {
      readonly itemType: 'MULTIPLE_CORRECT_MCQ';
      readonly options: readonly ItemOption[];
      readonly correctOptionIds: readonly string[];
    }
  | {
      readonly itemType: 'MATCHING';
      readonly left: readonly MatchingMember[];
      readonly right: readonly MatchingMember[];
      readonly pairs: readonly MatchingPair[];
    }
  | { readonly itemType: 'NUMERIC'; readonly spec: NumericAnswerSpecData };

export type ResponseSpecErrorCode =
  | 'ITEM_TYPE_UNKNOWN'
  | 'OPTIONS_TOO_FEW'
  | 'OPTION_ID_REQUIRED'
  | 'OPTION_ID_DUPLICATE'
  | 'OPTION_ORDINAL_GAP'
  | 'CORRECT_OPTION_REQUIRED'
  | 'CORRECT_OPTION_UNKNOWN'
  | 'CORRECT_OPTIONS_REQUIRED'
  | 'CORRECT_OPTION_DUPLICATE'
  | 'CORRECT_OPTIONS_EXHAUSTIVE'
  | 'MATCHING_MEMBERS_TOO_FEW'
  | 'MATCHING_MEMBER_ID_DUPLICATE'
  | 'MATCHING_MEMBER_ORDINAL_GAP'
  | 'MATCHING_PAIRS_REQUIRED'
  | 'MATCHING_PAIR_MEMBER_UNKNOWN'
  | 'MATCHING_PAIR_LEFT_DUPLICATE'
  | 'NUMERIC_SPEC_REQUIRED';

export type ResponseSpecError = ContentError<ResponseSpecErrorCode>;

/** Two options is the fewest that can pose a question rather than state a fact. */
export const MINIMUM_OPTIONS = 2;
export const MINIMUM_MATCHING_MEMBERS = 2;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: ResponseSpecErrorCode, message: string, location: string): ResponseSpecError {
  return validationError(code, message, location);
}

export function isItemType(itemType: string): itemType is ItemType {
  return (ITEM_TYPES as readonly string[]).includes(itemType);
}

function checkIdentified(
  members: readonly { readonly ordinal: number }[],
  ids: readonly string[],
  location: string,
  codes: {
    readonly blank: ResponseSpecErrorCode;
    readonly duplicate: ResponseSpecErrorCode;
    readonly gap: ResponseSpecErrorCode;
  },
): ResponseSpecError | undefined {
  const seen = new Set<string>();
  for (const [index, id] of ids.entries()) {
    if (isBlank(id)) {
      return invalid(codes.blank, 'an identifier is required', `${location}[${index}]`);
    }
    if (seen.has(id)) {
      return invalid(codes.duplicate, `identifier "${id}" appears more than once`, `${location}[${index}]`);
    }
    seen.add(id);
  }

  // Contiguous from 1. A gap means an option was deleted and the key may now
  // point at a position nobody sees.
  const ordinals = [...members.map((member) => member.ordinal)].sort((a, b) => a - b);
  for (const [index, ordinal] of ordinals.entries()) {
    if (ordinal !== index + 1) {
      return invalid(
        codes.gap,
        `ordinals must run contiguously from 1; found ${ordinals.join(', ')}`,
        location,
      );
    }
  }
  return undefined;
}

function checkOptions(options: readonly ItemOption[], location: string): ResponseSpecError | undefined {
  if (options.length < MINIMUM_OPTIONS) {
    return invalid(
      'OPTIONS_TOO_FEW',
      `a multiple-choice item requires at least ${MINIMUM_OPTIONS} options, got ${options.length}`,
      location,
    );
  }
  return checkIdentified(
    options,
    options.map((option) => option.optionId),
    location,
    { blank: 'OPTION_ID_REQUIRED', duplicate: 'OPTION_ID_DUPLICATE', gap: 'OPTION_ORDINAL_GAP' },
  );
}

function checkMembers(
  members: readonly MatchingMember[],
  location: string,
): ResponseSpecError | undefined {
  if (members.length < MINIMUM_MATCHING_MEMBERS) {
    return invalid(
      'MATCHING_MEMBERS_TOO_FEW',
      `a matching item requires at least ${MINIMUM_MATCHING_MEMBERS} members on each side, got ${members.length}`,
      location,
    );
  }
  return checkIdentified(
    members,
    members.map((member) => member.memberId),
    location,
    {
      blank: 'MATCHING_MEMBER_ID_DUPLICATE',
      duplicate: 'MATCHING_MEMBER_ID_DUPLICATE',
      gap: 'MATCHING_MEMBER_ORDINAL_GAP',
    },
  );
}

function freezeOptions(options: readonly ItemOption[]): readonly ItemOption[] {
  return Object.freeze(options.map((option) => Object.freeze({ ...option })));
}

function freezeMembers(members: readonly MatchingMember[]): readonly MatchingMember[] {
  return Object.freeze(members.map((member) => Object.freeze({ ...member })));
}

export type CreateResponseSpecificationProps = ResponseSpecification;

export function createResponseSpecification(
  props: CreateResponseSpecificationProps,
  location = 'responseSpec',
): Result<ResponseSpecification, ResponseSpecError> {
  if (!isItemType(props.itemType)) {
    return err(
      invalid(
        'ITEM_TYPE_UNKNOWN',
        `unknown item type "${String(props.itemType)}" — the vocabulary is closed and mirrors scoring's`,
        location,
      ),
    );
  }

  switch (props.itemType) {
    case 'SINGLE_CORRECT_MCQ': {
      const failure = checkOptions(props.options, `${location}.options`);
      if (failure !== undefined) return err(failure);
      if (isBlank(props.correctOptionId)) {
        return err(invalid('CORRECT_OPTION_REQUIRED', 'a single-correct item requires a key', location));
      }
      if (!props.options.some((option) => option.optionId === props.correctOptionId)) {
        return err(
          invalid(
            'CORRECT_OPTION_UNKNOWN',
            `the key names option "${props.correctOptionId}", which is not among the options`,
            location,
          ),
        );
      }
      return ok(Object.freeze({ ...props, options: freezeOptions(props.options) }));
    }

    case 'MULTIPLE_CORRECT_MCQ': {
      const failure = checkOptions(props.options, `${location}.options`);
      if (failure !== undefined) return err(failure);
      if (props.correctOptionIds.length === 0) {
        return err(
          invalid('CORRECT_OPTIONS_REQUIRED', 'a multi-correct item requires at least one correct option', location),
        );
      }
      const seen = new Set<string>();
      for (const id of props.correctOptionIds) {
        if (seen.has(id)) {
          return err(invalid('CORRECT_OPTION_DUPLICATE', `option "${id}" is marked correct twice`, location));
        }
        seen.add(id);
        if (!props.options.some((option) => option.optionId === id)) {
          return err(
            invalid('CORRECT_OPTION_UNKNOWN', `the key names option "${id}", which is not among the options`, location),
          );
        }
      }
      // Every option correct is not a question. It scores full marks for
      // selecting everything, which teaches the opposite of what it asks.
      if (props.correctOptionIds.length === props.options.length) {
        return err(
          invalid(
            'CORRECT_OPTIONS_EXHAUSTIVE',
            'every option is marked correct; the item cannot discriminate',
            location,
          ),
        );
      }
      return ok(
        Object.freeze({
          ...props,
          options: freezeOptions(props.options),
          correctOptionIds: Object.freeze([...props.correctOptionIds]),
        }),
      );
    }

    case 'MATCHING': {
      const leftFailure = checkMembers(props.left, `${location}.left`);
      if (leftFailure !== undefined) return err(leftFailure);
      const rightFailure = checkMembers(props.right, `${location}.right`);
      if (rightFailure !== undefined) return err(rightFailure);

      if (props.pairs.length === 0) {
        return err(invalid('MATCHING_PAIRS_REQUIRED', 'a matching item requires at least one pair', location));
      }
      const leftIds = new Set(props.left.map((member) => member.memberId));
      const rightIds = new Set(props.right.map((member) => member.memberId));
      const matchedLeft = new Set<string>();
      for (const [index, pair] of props.pairs.entries()) {
        if (!leftIds.has(pair.left) || !rightIds.has(pair.right)) {
          return err(
            invalid(
              'MATCHING_PAIR_MEMBER_UNKNOWN',
              `pair (${pair.left}, ${pair.right}) names a member the item does not define`,
              `${location}.pairs[${index}]`,
            ),
          );
        }
        if (matchedLeft.has(pair.left)) {
          return err(
            invalid(
              'MATCHING_PAIR_LEFT_DUPLICATE',
              `left member "${pair.left}" is matched more than once`,
              `${location}.pairs[${index}]`,
            ),
          );
        }
        matchedLeft.add(pair.left);
      }

      return ok(
        Object.freeze({
          ...props,
          left: freezeMembers(props.left),
          right: freezeMembers(props.right),
          pairs: Object.freeze(props.pairs.map((pair) => Object.freeze({ ...pair }))),
        }),
      );
    }

    case 'NUMERIC': {
      // Mode-required parameters are checked by M3-08's projection against
      // scoring's own constructor, not re-implemented here: two validators for
      // one rule is how the authoring surface and the executor come to
      // disagree about what is publishable.
      if (props.spec === undefined) {
        return err(invalid('NUMERIC_SPEC_REQUIRED', 'a numeric item requires a NumericAnswerSpec', location));
      }
      return ok(
        Object.freeze({
          ...props,
          spec: Object.freeze({
            ...props.spec,
            acceptedForms: Object.freeze([...props.spec.acceptedForms]),
            ...(props.spec.unit !== undefined
              ? {
                  unit: Object.freeze({
                    ...props.spec.unit,
                    acceptedEquivalents: Object.freeze([...props.spec.unit.acceptedEquivalents]),
                  }),
                }
              : {}),
          }),
        }),
      );
    }
  }
}

/** The options a specification presents, or none for a type that has no options. */
export function optionsOf(spec: ResponseSpecification): readonly ItemOption[] {
  return spec.itemType === 'SINGLE_CORRECT_MCQ' || spec.itemType === 'MULTIPLE_CORRECT_MCQ'
    ? spec.options
    : [];
}

/** The option identifiers a solution must analyse as distractors (FR-TCH-04 rule 2). */
export function incorrectOptionIdsOf(spec: ResponseSpecification): readonly string[] {
  switch (spec.itemType) {
    case 'SINGLE_CORRECT_MCQ':
      return spec.options
        .filter((option) => option.optionId !== spec.correctOptionId)
        .map((option) => option.optionId);
    case 'MULTIPLE_CORRECT_MCQ':
      return spec.options
        .filter((option) => !spec.correctOptionIds.includes(option.optionId))
        .map((option) => option.optionId);
    case 'MATCHING':
    case 'NUMERIC':
      return [];
  }
}
