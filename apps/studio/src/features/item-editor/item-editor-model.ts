import {
  bodyIsEmpty,
  notationAlternativeErrors,
  type BodyDraft,
  type FieldError,
} from '../../authoring/body-draft.js';

/**
 * The Item Editor's own model — the part that has no DOM in it (M3-40).
 *
 * **This module decides nothing about whether an item may be submitted.** The
 * findings FR-TCH-07 defines are the domain's (M3-17), they arrive from the
 * API through `ItemEditorApi`, and `report.maySubmit` is read rather than
 * recomputed. What lives here is the narrower, purely local question of
 * whether the draft on screen can be turned into a command at all — a blank
 * stem, a notation node with no authored alternative, an option nobody has
 * marked correct. Client validation is a courtesy, never a control
 * (FRONTEND §7); the server refuses the same things again.
 *
 * The two families are named differently on purpose: a **form error** names a
 * field an author is looking at, a **finding** names a governance rule. An
 * editor that emitted one of the domain's own finding codes would be a second
 * implementation of the validator, and the two would disagree the first time
 * either changed. A spec scans this feature for those codes and finds none.
 */

/* ------------------------------------------------------------------ *
 * The item draft
 * ------------------------------------------------------------------ */

/**
 * The two types the Studio surface exposes in v1 (FR-TCH-02 rule 2, DEC-3).
 * All four are modeled in the domain; multi-correct and matching are authored
 * later, and the closed tuple is what makes "later" a reviewed change.
 */
export const AUTHORABLE_ITEM_TYPES = ['SINGLE_CORRECT_MCQ', 'NUMERIC'] as const;
export type AuthorableItemType = (typeof AUTHORABLE_ITEM_TYPES)[number];

export interface OptionDraft {
  readonly optionId: string;
  readonly ordinal: number;
  /** An option body is a `ContentBody`, so an option can *be* an equation. */
  readonly body: BodyDraft;
  /** What a student who chose this believed — prompted here, stored on the solution. */
  readonly misconception: string;
}

/** Decimal literals are text the whole way (ADR-0007), never a JS number. */
export interface NumericDraft {
  readonly expectedValue: string;
  readonly tolerance: string;
  readonly unit: string;
}

export interface ItemEditorDraft {
  readonly itemId: string;
  readonly itemType: AuthorableItemType;
  readonly stem: BodyDraft;
  readonly options: readonly OptionDraft[];
  readonly correctOptionId: string | null;
  readonly numeric: NumericDraft | null;
}

/* ------------------------------------------------------------------ *
 * Form errors — the local half, and only the local half
 * ------------------------------------------------------------------ */

export const FORM_ERROR_CODES = [
  'STEM_EMPTY',
  'OPTION_BODY_EMPTY',
  'NOTATION_ALTERNATIVE_MISSING',
  'CORRECT_OPTION_UNCHOSEN',
  'NUMERIC_EXPECTED_VALUE_MISSING',
  'NUMERIC_EXPECTED_VALUE_NOT_DECIMAL',
] as const;
export type FormErrorCode = (typeof FORM_ERROR_CODES)[number];

export function isFormErrorCode(value: string): value is FormErrorCode {
  return (FORM_ERROR_CODES as readonly string[]).includes(value);
}

export type FormError = FieldError<FormErrorCode>;

const DECIMAL_LITERAL = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/u;

/**
 * Everything the author must fix before the draft is even a command, reported
 * at once and each naming where it is. An author told one thing per attempt
 * stops attempting (UX §10.1).
 */
export function itemEditorFormErrors(draft: ItemEditorDraft): readonly FormError[] {
  const errors: FormError[] = [];

  if (bodyIsEmpty(draft.stem)) {
    errors.push({
      code: 'STEM_EMPTY',
      message: 'The question stem is empty.',
      location: 'stem',
      fieldId: 'stem-block-0',
    });
  }
  errors.push(
    ...notationAlternativeErrors(draft.stem, 'NOTATION_ALTERNATIVE_MISSING', 'stem', 'stem'),
  );

  draft.options.forEach((option, index) => {
    if (bodyIsEmpty(option.body)) {
      errors.push({
        code: 'OPTION_BODY_EMPTY',
        message: `Option ${index + 1} has no content.`,
        location: `options[${option.optionId}]`,
        fieldId: `option-${option.optionId}-block-0`,
      });
    }
    errors.push(
      ...notationAlternativeErrors(
        option.body,
        'NOTATION_ALTERNATIVE_MISSING',
        `options[${option.optionId}]`,
        `option-${option.optionId}`,
      ),
    );
  });

  if (draft.itemType === 'SINGLE_CORRECT_MCQ' && draft.correctOptionId === null) {
    errors.push({
      code: 'CORRECT_OPTION_UNCHOSEN',
      message: 'No option is marked correct.',
      location: 'correctOptionId',
      fieldId: 'correct-option-group',
    });
  }

  if (draft.itemType === 'NUMERIC') {
    const expected = draft.numeric?.expectedValue ?? '';
    if (expected.trim().length === 0) {
      errors.push({
        code: 'NUMERIC_EXPECTED_VALUE_MISSING',
        message: 'The expected value is empty.',
        location: 'numeric.expectedValue',
        fieldId: 'numeric-expected-value',
      });
    } else if (!DECIMAL_LITERAL.test(expected.trim())) {
      errors.push({
        code: 'NUMERIC_EXPECTED_VALUE_NOT_DECIMAL',
        message: `"${expected}" is not a decimal literal.`,
        location: 'numeric.expectedValue',
        fieldId: 'numeric-expected-value',
      });
    }
  }

  return errors;
}

/* ------------------------------------------------------------------ *
 * The port
 * ------------------------------------------------------------------ */

/** A finding as M3-17 defines it. Produced by the domain; displayed here. */
export interface ValidationFinding {
  readonly code: string;
  readonly severity: 'blocking' | 'warning';
  readonly message: string;
  readonly location: string;
}

export interface ValidationReport {
  readonly findings: readonly ValidationFinding[];
  /** The domain's verdict. Read, never recomputed. */
  readonly maySubmit: boolean;
  /** M4 owns duplicate detection; until then this says the check has not run. */
  readonly duplicateCheckState: string;
}

export interface SaveDraftInput {
  readonly itemId: string;
  /** Autosave is `UpdateItemDraft` with a key, so a retry is a no-op (M3-25). */
  readonly idempotencyKey: string;
  readonly expectedAggregateVersion: number;
  readonly draft: ItemEditorDraft;
  /**
   * Routed to `UpdateSolutionDraft`'s distractor analyses (M3-13, M3-26). The
   * misconception is prompted here because this is where the author still has
   * the item in their head; it is not stored here, because a distractor
   * analysis belongs to the solution.
   */
  readonly misconceptions: readonly { readonly optionId: string; readonly text: string }[];
}

export interface ItemEditorApi {
  saveDraft(input: SaveDraftInput): Promise<{
    readonly aggregateVersion: number;
    readonly report: ValidationReport;
  }>;
  submitForReview(
    itemId: string,
    expectedAggregateVersion: number,
  ): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}
