/**
 * The marking rule set as the executor reads it (ASSESSMENT-ENGINE §2.1).
 *
 * Mirrored structurally from `curriculum/public/` rather than imported, for
 * the same reason as `Result` and `NumericAnswerSpecData`: `domain/` imports
 * nothing (§9 rule 2). `marking-rule-data.spec.ts` asserts the barrel types
 * stay assignable to these, so drift in M1 breaks a build rather than a score.
 *
 * Curriculum owns authoring and validation of these; Scoring only executes
 * them. Nothing here validates — by the time a rule set reaches the executor
 * M1 has already guaranteed it is `ALWAYS`-terminated (F46) with unique ids.
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

export const AWARD_KINDS = ['FIXED', 'PER_CORRECT', 'FULL_MARKS'] as const;

export type AwardKind = (typeof AWARD_KINDS)[number];

export type Award =
  | { readonly kind: 'FIXED'; readonly marks: number }
  | { readonly kind: 'PER_CORRECT'; readonly marks: number }
  | { readonly kind: 'FULL_MARKS' };

export interface AppliesTo {
  readonly itemTypes: readonly string[];
  readonly sectionOrdinals?: readonly number[];
}

export interface MarkingRuleData {
  readonly id: string;
  readonly appliesTo: AppliesTo;
  readonly condition: Condition;
  readonly award: Award;
}

export interface MarkingRuleSetData {
  readonly schemaVersion: number;
  readonly rules: readonly MarkingRuleData[];
}
