import { describe, expect, it } from 'vitest';
import { createAnswerKey } from './answer-key.js';
import { CONDITION_KINDS, type Condition, type MarkingRuleData } from './marking-rule-data.js';
import type { ResponseSnapshot, ScoredSlot } from './scoring-input.js';
import { makeRational, parseRational, rationalToDecimalString, type Rational } from './numeric/decimal.js';
import {
  bonusOutcome,
  CORRECTNESS_VALUES,
  droppedOutcome,
  explain,
  outcomeFromRule,
  OVERRIDE_RULE_IDS,
  type Correctness,
} from './item-outcome.js';
import { expectValue } from '../../../testing/expect-result.js';

const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const marks = (text: string): Rational => expectValue(parseRational(text));

function slot(response?: ResponseSnapshot): ScoredSlot {
  return {
    slotId: 'slot-1',
    ordinal: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: 'iv-7',
    marksAvailable: 4,
    marksAvailableExact: makeRational(4n, 1n),
    answerKey: key,
    ...(response !== undefined ? { response } : {}),
  };
}

const answered: ResponseSnapshot = { kind: 'OPTION_SELECTION', optionIds: ['B'] };

function rule(condition: Condition, id = 'r'): MarkingRuleData {
  return { id, appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] }, condition, award: { kind: 'FIXED', marks: 0 } };
}

function outcomeFor(condition: Condition, awarded: string, response?: ResponseSnapshot, indeterminate = false) {
  return outcomeFromRule({
    slot: slot(response),
    sectionOrdinal: 1,
    rule: rule(condition, 'the-rule'),
    marksAwarded: marks(awarded),
    marksAvailable: marks('4'),
    sawIndeterminate: indeterminate,
  });
}

describe('rule attribution is structural (F47)', () => {
  it('always names the rule that produced the outcome', () => {
    expect(outcomeFor({ kind: 'EXACT_MATCH' }, '4', answered).ruleApplied.ruleId).toBe('the-rule');
  });

  it('names a reserved override id for a dropped slot, not a rule', () => {
    expect(droppedOutcome(slot(), 1, 'key defect').ruleApplied.ruleId).toBe(OVERRIDE_RULE_IDS.DROPPED);
  });

  it('names a reserved override id for a bonus slot', () => {
    expect(bonusOutcome(slot(), 1, marks('4'), 'challenge upheld').ruleApplied.ruleId).toBe(OVERRIDE_RULE_IDS.BONUS);
  });

  it('carries a non-empty explanation on every construction path', () => {
    const outcomes = [
      outcomeFor({ kind: 'EXACT_MATCH' }, '4', answered),
      droppedOutcome(slot(), 1, 'key defect'),
      bonusOutcome(slot(), 1, marks('4'), 'challenge upheld'),
    ];
    for (const outcome of outcomes) {
      expect(outcome.ruleApplied.explanation.length).toBeGreaterThan(0);
    }
  });
});

describe('correctness', () => {
  it('declares the six values the domain model names, plus indeterminate', () => {
    expect([...CORRECTNESS_VALUES]).toEqual([
      'correct',
      'incorrect',
      'unattempted',
      'dropped',
      'bonus',
      'indeterminate',
    ]);
  });

  const cases: readonly [Condition, Correctness][] = [
    [{ kind: 'UNATTEMPTED' }, 'unattempted'],
    [{ kind: 'EXACT_MATCH' }, 'correct'],
    [{ kind: 'ALL_CORRECT_SELECTED' }, 'correct'],
    [{ kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 2, noIncorrect: true }, 'correct'],
    [{ kind: 'MATCHING_PAIRS_CORRECT', count: 2 }, 'correct'],
    [{ kind: 'NO_MATCH' }, 'incorrect'],
    [{ kind: 'ANY_INCORRECT_SELECTED' }, 'incorrect'],
  ];

  for (const [condition, expected] of cases) {
    it(`reads ${condition.kind} as ${expected}`, () => {
      expect(outcomeFor(condition, '0', answered).correctness).toBe(expected);
    });
  }

  it('reads a terminal ALWAYS on an unattempted slot as unattempted', () => {
    expect(outcomeFor({ kind: 'ALWAYS' }, '0').correctness).toBe('unattempted');
  });

  it('reads a terminal ALWAYS on an answered slot as indeterminate, never incorrect', () => {
    // No authored rule described what the learner did. That is not wrongness,
    // and it awards 0 either way.
    expect(outcomeFor({ kind: 'ALWAYS' }, '0', answered).correctness).toBe('indeterminate');
  });

  it('records indeterminate whenever the evaluation could not be decided', () => {
    expect(outcomeFor({ kind: 'ALWAYS' }, '0', answered, true).correctness).toBe('indeterminate');
  });

  it('records indeterminate even where the condition would have read as incorrect', () => {
    // The load-bearing case: an unreadable entry must never be filed as a
    // wrong answer, whatever rule it finally landed on.
    expect(outcomeFor({ kind: 'NO_MATCH' }, '0', answered, true).correctness).toBe('indeterminate');
  });

  it('records an unrecognised condition as indeterminate rather than guessing', () => {
    const unknown = { kind: 'ASSERTION_REASON' } as unknown as Condition;
    expect(outcomeFor(unknown, '0', answered).correctness).toBe('indeterminate');
  });
});

describe('the explanation', () => {
  it('reads plainly for the JEE Main outcomes', () => {
    expect(explain({ kind: 'UNATTEMPTED' }, marks('0'), false)).toBe('unattempted → 0 marks');
    expect(explain({ kind: 'EXACT_MATCH' }, marks('4'), false)).toBe('correct → +4 marks');
    expect(explain({ kind: 'NO_MATCH' }, marks('-1'), false)).toBe('incorrect → −1 mark');
  });

  it('singularises one mark and pluralises the rest', () => {
    expect(explain({ kind: 'EXACT_MATCH' }, marks('1'), false)).toContain('+1 mark');
    expect(explain({ kind: 'EXACT_MATCH' }, marks('2'), false)).toContain('+2 marks');
    expect(explain({ kind: 'UNATTEMPTED' }, marks('0'), false)).toContain('0 marks');
  });

  it('describes every condition kind', () => {
    for (const kind of CONDITION_KINDS) {
      const condition = { kind, minCorrect: 2, noIncorrect: true, count: 3 } as unknown as Condition;
      expect(explain(condition, marks('1'), false), kind).not.toContain('not recognised');
    }
  });

  it('names the partial-credit thresholds it applied', () => {
    expect(explain({ kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true }, marks('3'), false)).toBe(
      'at least 3 correct selected, none incorrect → +3 marks',
    );
    expect(explain({ kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 1, noIncorrect: false }, marks('1'), false)).toBe(
      'at least 1 correct selected → +1 mark',
    );
  });

  it('names the pair count it required', () => {
    expect(explain({ kind: 'MATCHING_PAIRS_CORRECT', count: 4 }, marks('4'), false)).toContain('4 pairs');
  });

  it('says so when the response could not be evaluated', () => {
    const text = explain({ kind: 'ALWAYS' }, marks('0'), true);
    expect(text).toContain('could not be evaluated');
    expect(text).toContain('no mark was deducted');
  });

  it('falls back rather than throwing on an unrecognised condition', () => {
    const unknown = { kind: 'NOT_A_CONDITION' } as unknown as Condition;
    expect(explain(unknown, marks('0'), false)).toContain('not recognised');
  });

  it('renders a fractional award', () => {
    expect(explain({ kind: 'EXACT_MATCH' }, marks('1.5'), false)).toContain('+1.5 marks');
  });
});

describe('a dropped slot', () => {
  it('is excluded from both the awarded and the available marks', () => {
    const outcome = droppedOutcome(slot(answered), 1, 'key defect');
    expect(rationalToDecimalString(outcome.marksAwarded)).toBe('0');
    expect(rationalToDecimalString(outcome.marksAvailable)).toBe('0');
  });

  it('records the reason in the explanation', () => {
    expect(droppedOutcome(slot(), 1, 'key defect confirmed').ruleApplied.explanation).toContain('key defect confirmed');
  });

  it('keeps the learner response on record', () => {
    expect(droppedOutcome(slot(answered), 1, 'r').responseSnapshot).toEqual(answered);
  });

  it('records correctness as dropped', () => {
    expect(droppedOutcome(slot(), 1, 'r').correctness).toBe('dropped');
  });
});

describe('a bonus slot', () => {
  it('pays the full marks and keeps them available', () => {
    const outcome = bonusOutcome(slot(), 1, marks('4'), 'challenge upheld');
    expect(rationalToDecimalString(outcome.marksAwarded)).toBe('4');
    expect(rationalToDecimalString(outcome.marksAvailable)).toBe('4');
  });

  it('pays an unattempted slot', () => {
    expect(bonusOutcome(slot(), 1, marks('4'), 'r').correctness).toBe('bonus');
  });

  it('records the reason in the explanation', () => {
    expect(bonusOutcome(slot(), 1, marks('4'), 'challenge upheld').ruleApplied.explanation).toContain(
      'challenge upheld',
    );
  });

  it('keeps an answered learner response on record', () => {
    expect(bonusOutcome(slot(answered), 1, marks('4'), 'r').responseSnapshot).toEqual(answered);
  });
});

describe('the response snapshot', () => {
  it('is absent for an unattempted slot', () => {
    expect(outcomeFor({ kind: 'UNATTEMPTED' }, '0').responseSnapshot).toBeUndefined();
  });

  it('is the learner response, and carries no key material', () => {
    const outcome = outcomeFor({ kind: 'EXACT_MATCH' }, '4', answered);
    expect(outcome.responseSnapshot).toEqual(answered);

    // Marks are BigInt rationals, so the outcome is not directly JSON —
    // rendering to decimal is the repository's job at the boundary (M2-20).
    const serialized = JSON.stringify(outcome, (_key, value) =>
      typeof value === 'bigint' ? value.toString() : value,
    );
    expect(serialized).not.toContain('answerKey');
    expect(serialized).not.toContain('optionId"');
  });
});

describe('immutability', () => {
  it('freezes the outcome and its attribution', () => {
    const outcome = outcomeFor({ kind: 'EXACT_MATCH' }, '4', answered);
    expect(Object.isFrozen(outcome)).toBe(true);
    expect(Object.isFrozen(outcome.ruleApplied)).toBe(true);
  });

  it('freezes a dropped and a bonus outcome', () => {
    expect(Object.isFrozen(droppedOutcome(slot(), 1, 'r'))).toBe(true);
    expect(Object.isFrozen(bonusOutcome(slot(), 1, makeRational(4n, 1n), 'r'))).toBe(true);
  });
});
