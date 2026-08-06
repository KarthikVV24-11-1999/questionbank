import type { MarkingRuleSetData } from '../contexts/curriculum/domain/value-objects/marking-rule-set.js';

const MCQ = ['SINGLE_CORRECT_MCQ'] as const;
const MULTI = ['MULTIPLE_CORRECT_MCQ'] as const;

/**
 * JEE Main / NEET UG (ASSESSMENT-ENGINE §2.4), three rules.
 *
 * The document writes rule 3 as `NO_MATCH → −1`; expressed as the terminal
 * `ALWAYS` that F46 requires, it is the same function: after UNATTEMPTED and
 * EXACT_MATCH, the only remaining case is a wrong response.
 */
export const JEE_MAIN_RULE_SET: MarkingRuleSetData = {
  schemaVersion: 1,
  rules: [
    { id: 'unattempted', appliesTo: { itemTypes: [...MCQ] }, condition: { kind: 'UNATTEMPTED' }, award: { kind: 'FIXED', marks: 0 } },
    { id: 'correct', appliesTo: { itemTypes: [...MCQ] }, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
    { id: 'incorrect', appliesTo: { itemTypes: [...MCQ] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: -1 } },
  ],
};

/** JEE Advanced multi-correct partial credit (ASSESSMENT-ENGINE §2.4), seven rules. */
export const JEE_ADVANCED_RULE_SET: MarkingRuleSetData = {
  schemaVersion: 1,
  rules: [
    { id: 'unattempted', appliesTo: { itemTypes: [...MULTI] }, condition: { kind: 'UNATTEMPTED' }, award: { kind: 'FIXED', marks: 0 } },
    { id: 'any-incorrect', appliesTo: { itemTypes: [...MULTI] }, condition: { kind: 'ANY_INCORRECT_SELECTED' }, award: { kind: 'FIXED', marks: -2 } },
    { id: 'all-correct', appliesTo: { itemTypes: [...MULTI] }, condition: { kind: 'ALL_CORRECT_SELECTED' }, award: { kind: 'FIXED', marks: 4 } },
    { id: 'three-correct', appliesTo: { itemTypes: [...MULTI] }, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true }, award: { kind: 'FIXED', marks: 3 } },
    { id: 'two-correct', appliesTo: { itemTypes: [...MULTI] }, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 2, noIncorrect: true }, award: { kind: 'FIXED', marks: 2 } },
    { id: 'one-correct', appliesTo: { itemTypes: [...MULTI] }, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 1, noIncorrect: true }, award: { kind: 'FIXED', marks: 1 } },
    { id: 'default', appliesTo: { itemTypes: [...MULTI] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
  ],
};
