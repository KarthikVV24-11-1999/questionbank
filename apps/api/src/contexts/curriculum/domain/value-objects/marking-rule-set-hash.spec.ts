import { describe, expect, it } from 'vitest';
import { MarkingRuleSet, type MarkingRuleSetData } from './marking-rule-set.js';
import { canonicalizeMarkingRuleSet, hashMarkingRuleSet } from './marking-rule-set-hash.js';
import { JEE_ADVANCED_RULE_SET, JEE_MAIN_RULE_SET } from '../../../../testing/marking-fixtures.js';
import goldenHashes from '../../../../testing/golden/marking-rule-set-hashes.json' with { type: 'json' };
import { expectValue } from '../../../../testing/expect-result.js';

function hashOf(data: MarkingRuleSetData): string {
  return hashMarkingRuleSet(expectValue(MarkingRuleSet.create(data)));
}

/** Rebuilds the same rule set with object keys inserted in a different order. */
function shuffleKeys<T>(value: T, random: () => number): T {
  if (Array.isArray(value)) return value.map((entry) => shuffleKeys(entry, random)) as unknown as T;
  if (value === null || typeof value !== 'object') return value;

  const entries = Object.entries(value as Record<string, unknown>);
  for (let index = entries.length - 1; index > 0; index -= 1) {
    const swapWith = Math.floor(random() * (index + 1));
    const held = entries[index] as [string, unknown];
    entries[index] = entries[swapWith] as [string, unknown];
    entries[swapWith] = held;
  }

  return Object.fromEntries(
    entries.map(([key, nested]) => [key, shuffleKeys(nested, random)]),
  ) as unknown as T;
}

function seededRandom(seed: number): () => number {
  let state = seed;
  return () => {
    state = (state * 1103515245 + 12345) % 2147483648;
    return state / 2147483648;
  };
}

describe('canonical serialization', () => {
  it('sorts keys, emits no whitespace and formats numbers explicitly', () => {
    const canonical = canonicalizeMarkingRuleSet(expectValue(MarkingRuleSet.create(JEE_MAIN_RULE_SET)));

    expect(canonical).not.toMatch(/\s/u);
    expect(canonical.startsWith('{"rules":[')).toBe(true);
    expect(canonical.endsWith('"schemaVersion":"1"}')).toBe(true);
    expect(canonical).toContain('"award":{"kind":"FIXED","marks":"4"}');
  });

  it('keeps rules in evaluation order, not sorted order', () => {
    const canonical = canonicalizeMarkingRuleSet(expectValue(MarkingRuleSet.create(JEE_MAIN_RULE_SET)));

    expect(canonical.indexOf('"unattempted"')).toBeLessThan(canonical.indexOf('"correct"'));
    expect(canonical.indexOf('"correct"')).toBeLessThan(canonical.indexOf('"incorrect"'));
  });
});

describe('hash stability', () => {
  it('matches the committed golden fixture for the JEE Main set', () => {
    expect(hashOf(JEE_MAIN_RULE_SET)).toBe(goldenHashes.jeeMain);
  });

  it('matches the committed golden fixture for the JEE Advanced set', () => {
    expect(hashOf(JEE_ADVANCED_RULE_SET)).toBe(goldenHashes.jeeAdvanced);
  });

  it('produces a 64-character sha256 digest', () => {
    expect(hashOf(JEE_MAIN_RULE_SET)).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('is identical across 1,000 shuffled constructions', () => {
    const random = seededRandom(20260805);
    const expected = hashOf(JEE_ADVANCED_RULE_SET);

    const hashes = new Set(
      Array.from({ length: 1000 }, () => hashOf(shuffleKeys(JEE_ADVANCED_RULE_SET, random))),
    );

    expect([...hashes]).toEqual([expected]);
  });

  it('is identical for a set rebuilt from its own serialized data', () => {
    const original = expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET));
    const rebuilt = expectValue(
      MarkingRuleSet.create(JSON.parse(JSON.stringify(original.toData())) as MarkingRuleSetData),
    );

    expect(hashMarkingRuleSet(rebuilt)).toBe(hashMarkingRuleSet(original));
  });

  it('ignores the order in which item types were listed', () => {
    const listed = hashOf({
      schemaVersion: 1,
      rules: [
        { id: 'default', appliesTo: { itemTypes: ['A', 'B'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
      ],
    });
    const reversed = hashOf({
      schemaVersion: 1,
      rules: [
        { id: 'default', appliesTo: { itemTypes: ['B', 'A'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
      ],
    });

    expect(listed).toBe(reversed);
  });
});

describe('hash sensitivity', () => {
  const baseline = hashOf(JEE_ADVANCED_RULE_SET);

  it('changes when the rule order changes', () => {
    const [unattempted, anyIncorrect, ...rest] = JEE_ADVANCED_RULE_SET.rules;

    const reordered = hashOf({
      schemaVersion: 1,
      rules: [anyIncorrect, unattempted, ...rest] as MarkingRuleSetData['rules'],
    });

    expect(reordered).not.toBe(baseline);
  });

  it('changes when the schema version changes', () => {
    expect(hashOf({ ...JEE_ADVANCED_RULE_SET, schemaVersion: 2 })).not.toBe(baseline);
  });

  it.each([
    ['a mark value', { award: { kind: 'FIXED' as const, marks: 5 } }],
    ['an award kind', { award: { kind: 'FULL_MARKS' as const } }],
    ['a rule id', { id: 'renamed' }],
    ['an item type', { appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] } }],
    ['a section scope', { appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'], sectionOrdinals: [1] } }],
    ['a condition kind', { condition: { kind: 'NO_MATCH' as const } }],
  ])('changes when %s changes', (_case, mutation) => {
    const mutated = hashOf({
      schemaVersion: 1,
      rules: JEE_ADVANCED_RULE_SET.rules.map((rule, index) =>
        index === 1 ? { ...rule, ...mutation } : rule,
      ) as MarkingRuleSetData['rules'],
    });

    expect(mutated).not.toBe(baseline);
  });

  it('changes when a condition parameter changes', () => {
    const mutated = hashOf({
      schemaVersion: 1,
      rules: JEE_ADVANCED_RULE_SET.rules.map((rule) =>
        rule.id === 'three-correct'
          ? { ...rule, condition: { kind: 'PARTIAL_CORRECT_SELECTED' as const, minCorrect: 4, noIncorrect: true } }
          : rule,
      ) as MarkingRuleSetData['rules'],
    });

    expect(mutated).not.toBe(baseline);
  });

  it('changes when noIncorrect flips', () => {
    const mutated = hashOf({
      schemaVersion: 1,
      rules: JEE_ADVANCED_RULE_SET.rules.map((rule) =>
        rule.id === 'two-correct'
          ? { ...rule, condition: { kind: 'PARTIAL_CORRECT_SELECTED' as const, minCorrect: 2, noIncorrect: false } }
          : rule,
      ) as MarkingRuleSetData['rules'],
    });

    expect(mutated).not.toBe(baseline);
  });

  it('does not confuse a section-scoped rule with an unscoped one', () => {
    const unscoped = hashOf({
      schemaVersion: 1,
      rules: [{ id: 'r', appliesTo: { itemTypes: ['A'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FULL_MARKS' } }],
    });
    const scoped = hashOf({
      schemaVersion: 1,
      rules: [{ id: 'r', appliesTo: { itemTypes: ['A'], sectionOrdinals: [1] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FULL_MARKS' } }],
    });

    expect(scoped).not.toBe(unscoped);
  });

  it('does not confuse marks 4 with marks -4', () => {
    const positive = hashOf({
      schemaVersion: 1,
      rules: [{ id: 'r', appliesTo: { itemTypes: ['A'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 4 } }],
    });
    const negative = hashOf({
      schemaVersion: 1,
      rules: [{ id: 'r', appliesTo: { itemTypes: ['A'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: -4 } }],
    });

    expect(positive).not.toBe(negative);
  });

  it('treats -0 and 0 marks as the same value', () => {
    const zero = hashOf({
      schemaVersion: 1,
      rules: [{ id: 'r', appliesTo: { itemTypes: ['A'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } }],
    });
    const negativeZero = hashOf({
      schemaVersion: 1,
      rules: [{ id: 'r', appliesTo: { itemTypes: ['A'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: -0 } }],
    });

    expect(negativeZero).toBe(zero);
  });
});
