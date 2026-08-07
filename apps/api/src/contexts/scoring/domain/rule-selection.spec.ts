import { describe, expect, it } from 'vitest';
import { makeRational } from './numeric/decimal.js';
import { createAnswerKey, type AnswerKey, type NumericAnswerSpecData } from './answer-key.js';
import type { MarkingRuleData, MarkingRuleSetData } from './marking-rule-data.js';
import type { ResponseSnapshot, ScoredSlot } from './scoring-input.js';
import { ruleApplies, selectRule } from './rule-selection.js';
import { JEE_ADVANCED_RULE_SET, JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const singleKey = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const multiKey = expectValue(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: ['A', 'B', 'C'] }));

function numericKey(overrides: Partial<NumericAnswerSpecData> = {}): AnswerKey {
  return expectValue(
    createAnswerKey({
      kind: 'NUMERIC',
      spec: {
        expectedValue: '9.81',
        comparisonMode: 'ABSOLUTE_TOLERANCE',
        toleranceValue: '0.01',
        acceptedForms: ['DECIMAL'],
        ...overrides,
      },
    }),
  );
}

function slot(
  response: ResponseSnapshot | undefined,
  answerKey: AnswerKey,
  itemType = 'SINGLE_CORRECT_MCQ',
): ScoredSlot {
  return {
    slotId: 'slot-1',
    ordinal: 1,
    itemType,
    itemVersionId: 'iv-1',
    marksAvailable: 4,
    marksAvailableExact: makeRational(4n, 1n),
    answerKey,
    ...(response !== undefined ? { response } : {}),
  };
}

const options = (...ids: string[]): ResponseSnapshot => ({ kind: 'OPTION_SELECTION', optionIds: ids });
const numeric = (raw: string): ResponseSnapshot => ({ kind: 'NUMERIC_ENTRY', raw });

describe('ruleApplies', () => {
  const rule: MarkingRuleData = {
    id: 'r',
    appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] },
    condition: { kind: 'ALWAYS' },
    award: { kind: 'FIXED', marks: 0 },
  };

  it('applies to a listed item type', () => {
    expect(ruleApplies(rule, 'SINGLE_CORRECT_MCQ', 1)).toBe(true);
  });

  it('does not apply to an unlisted item type', () => {
    expect(ruleApplies(rule, 'NUMERIC', 1)).toBe(false);
  });

  it('applies to every section when no ordinals are listed', () => {
    for (const ordinal of [1, 2, 3, 99]) {
      expect(ruleApplies(rule, 'SINGLE_CORRECT_MCQ', ordinal), String(ordinal)).toBe(true);
    }
  });

  it('applies only to the listed sections when ordinals are given', () => {
    const scoped: MarkingRuleData = { ...rule, appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'], sectionOrdinals: [2, 3] } };
    expect(ruleApplies(scoped, 'SINGLE_CORRECT_MCQ', 1)).toBe(false);
    expect(ruleApplies(scoped, 'SINGLE_CORRECT_MCQ', 2)).toBe(true);
    expect(ruleApplies(scoped, 'SINGLE_CORRECT_MCQ', 3)).toBe(true);
  });

  it('requires both the item type and the section to match', () => {
    const scoped: MarkingRuleData = { ...rule, appliesTo: { itemTypes: ['NUMERIC'], sectionOrdinals: [2] } };
    expect(ruleApplies(scoped, 'SINGLE_CORRECT_MCQ', 2)).toBe(false);
    expect(ruleApplies(scoped, 'NUMERIC', 1)).toBe(false);
    expect(ruleApplies(scoped, 'NUMERIC', 2)).toBe(true);
  });
});

describe('first match wins', () => {
  it('selects the unattempted rule for an unattempted slot', () => {
    const selected = expectValue(selectRule(JEE_MAIN_RULE_SET, slot(undefined, singleKey), 1, singleKey));
    expect(selected.rule.id).toBe('unattempted');
  });

  it('selects the correct rule for a correct response', () => {
    const selected = expectValue(selectRule(JEE_MAIN_RULE_SET, slot(options('B'), singleKey), 1, singleKey));
    expect(selected.rule.id).toBe('correct');
  });

  it('selects the incorrect rule for a wrong response', () => {
    const selected = expectValue(selectRule(JEE_MAIN_RULE_SET, slot(options('A'), singleKey), 1, singleKey));
    expect(selected.rule.id).toBe('incorrect');
  });

  it('stops at the first match, leaving later rules unevaluated', () => {
    // The unattempted rule is first of four. Evaluating exactly one proves the
    // loop stopped rather than running on and taking the last match.
    const selected = expectValue(selectRule(JEE_MAIN_RULE_SET, slot(undefined, singleKey), 1, singleKey));
    expect(selected.rulesEvaluated).toBe(1);
  });

  it('counts each rule it had to try before matching', () => {
    const selected = expectValue(selectRule(JEE_MAIN_RULE_SET, slot(options('A'), singleKey), 1, singleKey));
    expect(selected.rulesEvaluated).toBe(3);
  });

  it('takes the earlier of two rules that both match', () => {
    const ambiguous: MarkingRuleSetData = {
      schemaVersion: 1,
      rules: [
        { id: 'first', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 1 } },
        { id: 'second', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 2 } },
      ],
    };
    const selected = expectValue(selectRule(ambiguous, slot(options('B'), singleKey), 1, singleKey));
    expect(selected.rule.id).toBe('first');
    expect(selected.rulesEvaluated).toBe(1);
  });

  it('never reorders the authored rules', () => {
    // Reversing the JEE Main set makes ALWAYS first, so it must now win.
    const reversed: MarkingRuleSetData = { ...JEE_MAIN_RULE_SET, rules: [...JEE_MAIN_RULE_SET.rules].reverse() };
    const selected = expectValue(selectRule(reversed, slot(options('B'), singleKey), 1, singleKey));
    expect(selected.rule.id).toBe('default');
  });

  it('skips rules that do not govern the slot without counting them', () => {
    const mixed: MarkingRuleSetData = {
      schemaVersion: 1,
      rules: [
        { id: 'numeric-only', appliesTo: { itemTypes: ['NUMERIC'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 9 } },
        { id: 'mcq', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 1 } },
      ],
    };
    const selected = expectValue(selectRule(mixed, slot(options('B'), singleKey), 1, singleKey));
    expect(selected.rule.id).toBe('mcq');
    expect(selected.rulesEvaluated).toBe(1);
  });
});

describe('the seven-rule JEE Advanced set', () => {
  const multiSlot = (response: ResponseSnapshot | undefined): ScoredSlot =>
    slot(response, multiKey, 'MULTIPLE_CORRECT_MCQ');

  const cases: readonly [string, ResponseSnapshot | undefined, string][] = [
    ['unattempted', undefined, 'unattempted'],
    ['any incorrect selected', options('A', 'D'), 'any-incorrect'],
    ['all correct selected', options('A', 'B', 'C'), 'all-correct'],
    ['two correct, none incorrect', options('A', 'B'), 'two-correct'],
    ['one correct, none incorrect', options('A'), 'one-correct'],
  ];

  for (const [label, response, expected] of cases) {
    it(`selects ${expected} for ${label}`, () => {
      expect(expectValue(selectRule(JEE_ADVANCED_RULE_SET, multiSlot(response), 1, multiKey)).rule.id).toBe(
        expected,
      );
    });
  }

  it('evaluates in authored order, so any-incorrect precedes the partial bands', () => {
    // A, B and D is two correct with one incorrect. Order is what makes this
    // -2 rather than +2.
    const selected = expectValue(selectRule(JEE_ADVANCED_RULE_SET, multiSlot(options('A', 'B', 'D')), 1, multiKey));
    expect(selected.rule.id).toBe('any-incorrect');
  });
});

describe('an indeterminate condition falls through', () => {
  const numericSet: MarkingRuleSetData = {
    schemaVersion: 1,
    rules: [
      { id: 'unattempted', appliesTo: { itemTypes: ['NUMERIC'] }, condition: { kind: 'UNATTEMPTED' }, award: { kind: 'FIXED', marks: 0 } },
      { id: 'correct', appliesTo: { itemTypes: ['NUMERIC'] }, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
      { id: 'incorrect', appliesTo: { itemTypes: ['NUMERIC'] }, condition: { kind: 'NO_MATCH' }, award: { kind: 'FIXED', marks: -1 } },
      { id: 'default', appliesTo: { itemTypes: ['NUMERIC'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
    ],
  };

  const numericSlot = (raw: string): ScoredSlot => slot(numeric(raw), numericKey(), 'NUMERIC');

  it('lands on the terminal rule when the entry cannot be read', () => {
    const selected = expectValue(selectRule(numericSet, numericSlot('about ten'), 1, numericKey()));
    expect(selected.rule.id).toBe('default');
  });

  it('reports that it saw an indeterminate condition', () => {
    const selected = expectValue(selectRule(numericSet, numericSlot('about ten'), 1, numericKey()));
    expect(selected.sawIndeterminate).toBe(true);
  });

  it('does not report an indeterminate for a plainly wrong answer', () => {
    const selected = expectValue(selectRule(numericSet, numericSlot('1'), 1, numericKey()));
    expect(selected.rule.id).toBe('incorrect');
    expect(selected.sawIndeterminate).toBe(false);
  });

  it('never reaches the penalising rule with an unreadable entry (ADR-0003)', () => {
    // The whole point: `incorrect` awards -1, and an unreadable entry must not
    // reach it. The terminal rule awards 0 instead.
    const selected = expectValue(selectRule(numericSet, numericSlot('nine-ish'), 1, numericKey()));
    expect(selected.rule.id).not.toBe('incorrect');
    expect(selected.rule.award).toEqual({ kind: 'FIXED', marks: 0 });
  });
});

describe('a slot no rule governs', () => {
  it('is a hard error, not a zero', () => {
    const error = expectError(selectRule(JEE_MAIN_RULE_SET, slot(options('B'), singleKey, 'MATCHING'), 1, singleKey));
    expect(error.code).toBe('RULE_SET_EXHAUSTED');
    expect(error.kind).toBe('RuleViolation');
  });

  it('names the slot, the item type and the section', () => {
    const error = expectError(selectRule(JEE_MAIN_RULE_SET, slot(options('B'), singleKey, 'MATCHING'), 2, singleKey));
    expect(error.message).toContain('slot-1');
    expect(error.message).toContain('MATCHING');
    expect(error.message).toContain('2');
  });

  it('is a hard error when the terminal ALWAYS has been stripped', () => {
    const withoutTerminal: MarkingRuleSetData = {
      ...JEE_MAIN_RULE_SET,
      rules: JEE_MAIN_RULE_SET.rules.filter((rule) => rule.condition.kind !== 'ALWAYS'),
    };
    const numericSlot = slot(numeric('unreadable'), numericKey(), 'SINGLE_CORRECT_MCQ');
    expect(expectError(selectRule(withoutTerminal, numericSlot, 1, numericKey())).code).toBe(
      'RULE_SET_EXHAUSTED',
    );
  });

  it('is a hard error for an empty rule set', () => {
    const empty: MarkingRuleSetData = { schemaVersion: 1, rules: [] };
    expect(expectError(selectRule(empty, slot(options('B'), singleKey), 1, singleKey)).code).toBe(
      'RULE_SET_EXHAUSTED',
    );
  });
});
