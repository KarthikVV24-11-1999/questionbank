import type { ContentBody } from '@questionbank/content-renderer';
import {
  bodyIsEmpty,
  notationAlternativeErrors,
  toContentBody,
  type BodyDraft,
  type FieldError,
} from '../../authoring/body-draft.js';

/**
 * The Solution editor's model (M3-41, FR-TCH-04).
 *
 * **Step order is a position, not an authored number.** The ordinals the
 * command carries are recomputed from the list on every save, never taken from
 * the draft — the same rule the repositories follow for projections, and for
 * the same reason: a number an author can set independently of the order they
 * see is a number that will eventually disagree with it.
 *
 * **Whether the final answer agrees with the key is not decided here.** M3-14
 * compares the assertion through the item's own `NumericAnswerSpec`, reached
 * through `scoring/public/`, so agreement means what it will mean at scoring
 * time. A browser-side comparison would be a second opinion, and the one the
 * author saw would be the wrong one.
 */

export interface StepDraft {
  /** Stable across reordering, so React and the author keep the same step. */
  readonly stepId: string;
  readonly body: BodyDraft;
}

export type FinalAnswerDraft =
  | { readonly kind: 'OPTION'; readonly optionId: string | null }
  /** The authored decimal literal, as text (ADR-0007). */
  | { readonly kind: 'NUMERIC'; readonly value: string };

export interface SolutionDraft {
  readonly solutionId: string;
  /** A solution targets an item *version* (FR-TCH-04 rule 3, D5). */
  readonly targetItemVersionId: string;
  readonly finalAnswer: FinalAnswerDraft;
  readonly steps: readonly StepDraft[];
  /** Keyed by option id; the misconception a wrong option represents. */
  readonly distractorAnalyses: Readonly<Record<string, BodyDraft>>;
}

/** The item the solution explains, with its key — an authoring view (ADR-0009). */
export interface SolutionTargetItem {
  readonly itemVersionId: string;
  readonly itemType: 'SINGLE_CORRECT_MCQ' | 'NUMERIC';
  readonly stem: ContentBody;
  readonly options: readonly {
    readonly optionId: string;
    readonly ordinal: number;
    readonly body: ContentBody;
  }[];
  readonly correctOptionId: string | null;
}

/** Moves a step one position, clamped: the ends are not wrap-around. */
export function moveStep(
  steps: readonly StepDraft[],
  index: number,
  direction: -1 | 1,
): readonly StepDraft[] {
  const target = index + direction;
  // The ends do not wrap: a first step that becomes the last on one keypress is
  // a reorder nobody meant. The index itself is always in range — the caller
  // enumerated the list to produce it.
  if (target < 0 || target >= steps.length) return steps;

  const reordered = [...steps];
  const moving = reordered[index] as StepDraft;
  reordered[index] = reordered[target] as StepDraft;
  reordered[target] = moving;
  return reordered;
}

/** Ordinals contiguous from 1, derived from position (M3-13). */
export function toStepCommands(
  steps: readonly StepDraft[],
): readonly { readonly ordinal: number; readonly body: ContentBody }[] {
  return steps.map((step, index) => ({ ordinal: index + 1, body: toContentBody(step.body) }));
}

export const SOLUTION_FORM_ERROR_CODES = [
  'STEPS_REQUIRED',
  'STEP_BODY_EMPTY',
  'FINAL_ANSWER_MISSING',
  'NOTATION_ALTERNATIVE_MISSING',
] as const;
export type SolutionFormErrorCode = (typeof SOLUTION_FORM_ERROR_CODES)[number];

export function solutionFormErrors(
  draft: SolutionDraft,
): readonly FieldError<SolutionFormErrorCode>[] {
  const errors: FieldError<SolutionFormErrorCode>[] = [];

  if (draft.steps.length === 0) {
    errors.push({
      code: 'STEPS_REQUIRED',
      message: 'A solution needs at least one step.',
      location: 'steps',
      fieldId: 'add-step',
    });
  }

  draft.steps.forEach((step, index) => {
    if (bodyIsEmpty(step.body)) {
      errors.push({
        code: 'STEP_BODY_EMPTY',
        message: `Step ${index + 1} is empty.`,
        location: `steps[${index}]`,
        fieldId: `step-${step.stepId}-block-0`,
      });
    }
    errors.push(
      ...notationAlternativeErrors(
        step.body,
        'NOTATION_ALTERNATIVE_MISSING',
        `steps[${index}]`,
        `step-${step.stepId}`,
      ),
    );
  });

  const stated =
    draft.finalAnswer.kind === 'OPTION'
      ? draft.finalAnswer.optionId !== null
      : draft.finalAnswer.value.trim().length > 0;
  if (!stated) {
    errors.push({
      code: 'FINAL_ANSWER_MISSING',
      message: 'The solution does not state its final answer.',
      location: 'finalAnswer',
      fieldId: 'final-answer',
    });
  }

  return errors;
}

export interface SolutionSaveResult {
  readonly ok: boolean;
  /**
   * Set when the domain refused because the stated answer contradicts the key
   * (M3-14, blocking per FR-TCH-07 rule 1). A solution ending in 9.8 against a
   * key of 9.81 is the defect that produces answer-key challenges, and it is
   * cheapest to fix while the author is still on the page.
   */
  readonly disagreement?: string;
}

export interface SolutionEditorApi {
  saveDraft(input: {
    readonly solutionId: string;
    readonly idempotencyKey: string;
    readonly targetItemVersionId: string;
    readonly finalAnswer: FinalAnswerDraft;
    readonly steps: readonly { readonly ordinal: number; readonly body: ContentBody }[];
    readonly distractorAnalyses: readonly {
      readonly optionId: string;
      readonly misconception: ContentBody;
    }[];
  }): Promise<SolutionSaveResult>;
}
