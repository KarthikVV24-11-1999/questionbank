import { describe, expect, it } from 'vitest';
import { CONDITION_KINDS, createCondition, subsumes, type Condition } from './condition.js';
import { AWARD_KINDS, createAward, type Award } from './award.js';
import { MarkingRule } from './marking-rule.js';
import { MarkingRuleSet, type MarkingRuleSetData } from './marking-rule-set.js';
import { JEE_ADVANCED_RULE_SET, JEE_MAIN_RULE_SET } from '../../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const MCQ = { itemTypes: ['SINGLE_CORRECT_MCQ'] };

const allConditions: readonly Condition[] = [
  { kind: 'UNATTEMPTED' },
  { kind: 'EXACT_MATCH' },
  { kind: 'NO_MATCH' },
  { kind: 'ALL_CORRECT_SELECTED' },
  { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 2, noIncorrect: true },
  { kind: 'ANY_INCORRECT_SELECTED' },
  { kind: 'MATCHING_PAIRS_CORRECT', count: 4 },
  { kind: 'ALWAYS' },
];

const allAwards: readonly Award[] = [
  { kind: 'FIXED', marks: -1 },
  { kind: 'PER_CORRECT', marks: 2 },
  { kind: 'FULL_MARKS' },
];

function ruleSet(rules: MarkingRuleSetData['rules'], schemaVersion = 1): MarkingRuleSetData {
  return { schemaVersion, rules };
}

describe('conditions', () => {
  it('covers all eight condition kinds', () => {
    expect([...CONDITION_KINDS]).toHaveLength(8);
    expect(allConditions.map((condition) => condition.kind)).toEqual([...CONDITION_KINDS]);
  });

  it.each(allConditions)('constructs $kind', (condition) => {
    expect(expectValue(createCondition(condition)).kind).toBe(condition.kind);
  });

  it('carries the parameters of PARTIAL_CORRECT_SELECTED', () => {
    const condition = expectValue(
      createCondition({ kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true }),
    );

    expect(condition).toEqual({ kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true });
  });

  it('carries the parameter of MATCHING_PAIRS_CORRECT', () => {
    expect(expectValue(createCondition({ kind: 'MATCHING_PAIRS_CORRECT', count: 4 }))).toEqual({
      kind: 'MATCHING_PAIRS_CORRECT',
      count: 4,
    });
  });

  it.each([0, -1, 1.5])('rejects minCorrect %s', (minCorrect) => {
    expect(
      expectError(createCondition({ kind: 'PARTIAL_CORRECT_SELECTED', minCorrect, noIncorrect: true })).code,
    ).toBe('MIN_CORRECT_INVALID');
  });

  it.each([0, 2.5])('rejects matching pair count %s', (count) => {
    expect(expectError(createCondition({ kind: 'MATCHING_PAIRS_CORRECT', count })).code).toBe(
      'PAIR_COUNT_INVALID',
    );
  });

  it('rejects an unknown condition kind', () => {
    expect(expectError(createCondition({ kind: 'SOMETIMES' } as unknown as Condition)).code).toBe(
      'CONDITION_KIND_UNKNOWN',
    );
  });

  it('knows that ALWAYS subsumes everything and identical kinds subsume each other', () => {
    expect(subsumes({ kind: 'ALWAYS' }, { kind: 'EXACT_MATCH' })).toBe(true);
    expect(subsumes({ kind: 'EXACT_MATCH' }, { kind: 'EXACT_MATCH' })).toBe(true);
    expect(subsumes({ kind: 'EXACT_MATCH' }, { kind: 'NO_MATCH' })).toBe(false);
  });

  it('knows a wider PARTIAL_CORRECT_SELECTED subsumes a stricter one', () => {
    const wider: Condition = { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 1, noIncorrect: true };
    const stricter: Condition = { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true };

    expect(subsumes(wider, stricter)).toBe(true);
    expect(subsumes(stricter, wider)).toBe(false);
  });
});

describe('awards', () => {
  it('covers all three award kinds', () => {
    expect([...AWARD_KINDS]).toEqual(['FIXED', 'PER_CORRECT', 'FULL_MARKS']);
  });

  it.each(allAwards)('constructs $kind', (award) => {
    expect(expectValue(createAward(award))).toEqual(award);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])('rejects marks %s', (marks) => {
    expect(expectError(createAward({ kind: 'FIXED', marks })).code).toBe('MARKS_INVALID');
  });

  it('rejects an unknown award kind', () => {
    expect(expectError(createAward({ kind: 'BONUS_POINTS' } as unknown as Award)).code).toBe(
      'AWARD_KIND_UNKNOWN',
    );
  });
});

describe('MarkingRule', () => {
  it('carries id, scope, condition and award', () => {
    const rule = expectValue(
      MarkingRule.create({
        id: 'correct',
        appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'], sectionOrdinals: [1, 2] },
        condition: { kind: 'EXACT_MATCH' },
        award: { kind: 'FIXED', marks: 4 },
      }),
    );

    expect(rule.id).toBe('correct');
    expect(rule.appliesTo.sectionOrdinals).toEqual([1, 2]);
    expect(rule.appliesToItemType('SINGLE_CORRECT_MCQ')).toBe(true);
    expect(rule.appliesToItemType('NUMERIC')).toBe(false);
    expect(Object.isFrozen(rule)).toBe(true);
  });

  it.each([
    ['a blank id', { id: '  ' }, 'RULE_ID_REQUIRED'],
    ['no item types', { appliesTo: { itemTypes: [] } }, 'ITEM_TYPES_REQUIRED'],
    ['a blank item type', { appliesTo: { itemTypes: [' '] } }, 'ITEM_TYPE_BLANK'],
    ['a zero section ordinal', { appliesTo: { itemTypes: ['MCQ'], sectionOrdinals: [0] } }, 'SECTION_ORDINAL_INVALID'],
  ])('rejects %s', (_case, overrides, code) => {
    const error = expectError(
      MarkingRule.create({
        id: 'r1',
        appliesTo: MCQ,
        condition: { kind: 'ALWAYS' },
        award: { kind: 'FIXED', marks: 0 },
        ...overrides,
      }),
    );

    expect(error.code).toBe(code);
  });

  it('propagates condition and award errors', () => {
    expect(
      expectError(
        MarkingRule.create({
          id: 'r1',
          appliesTo: MCQ,
          condition: { kind: 'MATCHING_PAIRS_CORRECT', count: 0 },
          award: { kind: 'FIXED', marks: 0 },
        }),
      ).code,
    ).toBe('PAIR_COUNT_INVALID');
    expect(
      expectError(
        MarkingRule.create({
          id: 'r1',
          appliesTo: MCQ,
          condition: { kind: 'ALWAYS' },
          award: { kind: 'FIXED', marks: Number.NaN },
        }),
      ).code,
    ).toBe('MARKS_INVALID');
  });
});

describe('MarkingRuleSet structure', () => {
  it('validates the JEE Main set: three authored rules plus a terminal ALWAYS', () => {
    const set = expectValue(MarkingRuleSet.create(JEE_MAIN_RULE_SET));

    expect(set.rules).toHaveLength(4);
    expect(set.ruleIds).toEqual(['unattempted', 'correct', 'incorrect', 'default']);
    expect(set.rules.map((rule) => rule.condition.kind)).toEqual([
      'UNATTEMPTED',
      'EXACT_MATCH',
      'NO_MATCH',
      'ALWAYS',
    ]);
    expect(set.warnings).toEqual([]);
  });

  it('terminates in a neutral award, never a penalty', () => {
    const set = expectValue(MarkingRuleSet.create(JEE_MAIN_RULE_SET));
    const terminal = set.rules.at(-1);

    // An unanticipated response state must not cost a candidate a mark.
    expect(terminal?.condition.kind).toBe('ALWAYS');
    expect(terminal?.award).toEqual({ kind: 'FIXED', marks: 0 });
  });

  it('validates the JEE Advanced seven-rule set with zero structural change', () => {
    const set = expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET));

    expect(set.rules).toHaveLength(7);
    expect(set.rules.map((rule) => rule.condition.kind)).toEqual([
      'UNATTEMPTED',
      'ANY_INCORRECT_SELECTED',
      'ALL_CORRECT_SELECTED',
      'PARTIAL_CORRECT_SELECTED',
      'PARTIAL_CORRECT_SELECTED',
      'PARTIAL_CORRECT_SELECTED',
      'ALWAYS',
    ]);
    expect(set.warnings).toEqual([]);
  });

  it('requires a schema version', () => {
    expect(expectError(MarkingRuleSet.create(ruleSet(JEE_MAIN_RULE_SET.rules, 0))).code).toBe(
      'SCHEMA_VERSION_REQUIRED',
    );
    expect(
      expectError(
        MarkingRuleSet.create({ rules: JEE_MAIN_RULE_SET.rules } as unknown as MarkingRuleSetData),
      ).code,
    ).toBe('SCHEMA_VERSION_REQUIRED');
  });

  it('rejects an empty rule list', () => {
    expect(expectError(MarkingRuleSet.create(ruleSet([]))).code).toBe('RULES_REQUIRED');
  });

  it('rejects a set that does not terminate in ALWAYS', () => {
    const withoutAlways = JEE_MAIN_RULE_SET.rules.slice(0, 3);

    const error = expectError(MarkingRuleSet.create(ruleSet(withoutAlways)));

    expect(error.code).toBe('MISSING_TERMINAL_ALWAYS');
  });

  it('rejects an ALWAYS rule that is not last', () => {
    const alwaysFirst = [JEE_MAIN_RULE_SET.rules[3], JEE_MAIN_RULE_SET.rules[0], JEE_MAIN_RULE_SET.rules[1]];

    const error = expectError(MarkingRuleSet.create(ruleSet(alwaysFirst as MarkingRuleSetData['rules'])));

    expect(error.code).toBe('ALWAYS_RULE_NOT_LAST');
    expect(error.ruleId).toBe('default');
  });

  it('rejects a duplicate rule id', () => {
    const duplicated = [
      JEE_MAIN_RULE_SET.rules[0],
      { ...JEE_MAIN_RULE_SET.rules[0], condition: { kind: 'EXACT_MATCH' } },
      JEE_MAIN_RULE_SET.rules[3],
    ];

    const error = expectError(MarkingRuleSet.create(ruleSet(duplicated as MarkingRuleSetData['rules'])));

    expect(error.code).toBe('DUPLICATE_RULE_ID');
    expect(error.ruleId).toBe('unattempted');
  });

  it('reports the offending rule id when a rule is invalid', () => {
    const broken = [
      { ...JEE_MAIN_RULE_SET.rules[0], appliesTo: { itemTypes: [] } },
      JEE_MAIN_RULE_SET.rules[3],
    ];

    const error = expectError(MarkingRuleSet.create(ruleSet(broken as MarkingRuleSetData['rules'])));

    expect(error.code).toBe('ITEM_TYPES_REQUIRED');
    expect(error.ruleId).toBe('unattempted');
  });
});

describe('MarkingRuleSet ordering', () => {
  it('preserves rule order through a serialization round-trip', () => {
    const original = expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET));

    const roundTripped = expectValue(
      MarkingRuleSet.create(JSON.parse(JSON.stringify(original.toData())) as MarkingRuleSetData),
    );

    expect(roundTripped.ruleIds).toEqual(original.ruleIds);
    expect(roundTripped.toData()).toEqual(original.toData());
  });

  it('treats order as significant — a reordered set is a different set', () => {
    const [unattempted, anyIncorrect, ...rest] = JEE_ADVANCED_RULE_SET.rules;
    const reordered = expectValue(
      MarkingRuleSet.create(ruleSet([anyIncorrect, unattempted, ...rest] as MarkingRuleSetData['rules'])),
    );

    expect(reordered.ruleIds[0]).toBe('any-incorrect');
    expect(reordered.ruleIds).not.toEqual(expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET)).ruleIds);
  });

  it('lists rules applying to an item type in order', () => {
    const set = expectValue(MarkingRuleSet.create(JEE_MAIN_RULE_SET));

    expect(set.rulesForItemType('SINGLE_CORRECT_MCQ').map((rule) => rule.id)).toEqual([
      'unattempted',
      'correct',
      'incorrect',
      'default',
    ]);
    expect(set.rulesForItemType('NUMERIC')).toEqual([]);
  });

  it('is immutable', () => {
    const set = expectValue(MarkingRuleSet.create(JEE_MAIN_RULE_SET));

    expect(Object.isFrozen(set)).toBe(true);
    expect(Object.isFrozen(set.rules)).toBe(true);
    expect(() => (set.rules as MarkingRule[]).pop()).toThrow(TypeError);
  });
});

describe('MarkingRuleSet unreachable rules', () => {
  it('warns, rather than failing, when an earlier rule subsumes a later one', () => {
    const shadowed = expectValue(
      MarkingRuleSet.create(
        ruleSet([
          { id: 'first', appliesTo: MCQ, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
          { id: 'second', appliesTo: MCQ, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 2 } },
          { id: 'default', appliesTo: MCQ, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
        ]),
      ),
    );

    expect(shadowed.warnings).toHaveLength(1);
    expect(shadowed.warnings[0]).toMatchObject({
      code: 'UNREACHABLE_RULE',
      ruleId: 'second',
      shadowedByRuleId: 'first',
    });
  });

  it('warns when a stricter partial-credit rule sits behind a wider one', () => {
    const set = expectValue(
      MarkingRuleSet.create(
        ruleSet([
          { id: 'one-correct', appliesTo: MCQ, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 1, noIncorrect: true }, award: { kind: 'FIXED', marks: 1 } },
          { id: 'three-correct', appliesTo: MCQ, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true }, award: { kind: 'FIXED', marks: 3 } },
          { id: 'default', appliesTo: MCQ, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
        ]),
      ),
    );

    expect(set.warnings.map((warning) => warning.ruleId)).toEqual(['three-correct']);
  });

  it('does not warn when the shadowing rule applies to a different item type', () => {
    const set = expectValue(
      MarkingRuleSet.create(
        ruleSet([
          { id: 'numeric', appliesTo: { itemTypes: ['NUMERIC'] }, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
          { id: 'mcq', appliesTo: MCQ, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
          { id: 'default', appliesTo: MCQ, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
        ]),
      ),
    );

    expect(set.warnings).toEqual([]);
  });

  it('does not warn when the shadowing rule applies to a different section', () => {
    const set = expectValue(
      MarkingRuleSet.create(
        ruleSet([
          { id: 'section-one', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'], sectionOrdinals: [1] }, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
          { id: 'section-two', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'], sectionOrdinals: [2] }, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 3 } },
          { id: 'default', appliesTo: MCQ, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
        ]),
      ),
    );

    expect(set.warnings).toEqual([]);
  });
});
