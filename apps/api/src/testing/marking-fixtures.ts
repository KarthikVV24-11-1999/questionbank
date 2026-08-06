import type { MarkingRuleSetData } from '../contexts/curriculum/domain/value-objects/marking-rule-set.js';

const MCQ = ['SINGLE_CORRECT_MCQ'] as const;
const MULTI = ['MULTIPLE_CORRECT_MCQ'] as const;

/**
 * JEE Main / NEET UG (ASSESSMENT-ENGINE §2.4): the three authored rules plus
 * the terminal `ALWAYS` that F46 requires.
 *
 * The terminal rule awards 0, never a penalty. A response state that is
 * neither unattempted, nor matched, nor a recognised mismatch is one the
 * authors did not anticipate — deducting a mark for it would penalise a
 * candidate for an engine gap. This mirrors the JEE Advanced set in §2.4,
 * which also terminates in `ALWAYS → 0`.
 */
export const JEE_MAIN_RULE_SET: MarkingRuleSetData = {
  schemaVersion: 1,
  rules: [
    { id: 'unattempted', appliesTo: { itemTypes: [...MCQ] }, condition: { kind: 'UNATTEMPTED' }, award: { kind: 'FIXED', marks: 0 } },
    { id: 'correct', appliesTo: { itemTypes: [...MCQ] }, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
    { id: 'incorrect', appliesTo: { itemTypes: [...MCQ] }, condition: { kind: 'NO_MATCH' }, award: { kind: 'FIXED', marks: -1 } },
    { id: 'default', appliesTo: { itemTypes: [...MCQ] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
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
