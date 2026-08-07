import { describe, expect, it } from 'vitest';
import { makeRational } from '../numeric/decimal.js';
import { createAnswerKey, type AnswerKey, type NumericAnswerSpecData } from '../answer-key.js';
import { CONDITION_KINDS, type Condition } from '../marking-rule-data.js';
import type { ResponseSnapshot, ScoredSlot } from '../scoring-input.js';
import { evaluateCondition, type ConditionOutcome } from './evaluate-condition.js';
import { expectValue } from '../../../../testing/expect-result.js';

function slot(response: ResponseSnapshot | undefined, answerKey: AnswerKey): ScoredSlot {
  return {
    slotId: 'slot-1',
    ordinal: 1,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId: 'iv-1',
    marksAvailable: 4,
    marksAvailableExact: makeRational(4n, 1n),
    answerKey,
    ...(response !== undefined ? { response } : {}),
  };
}

const singleKey = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const multiKey = expectValue(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: ['A', 'B', 'C'] }));
const matchingKey = expectValue(
  createAnswerKey({
    kind: 'MATCHING',
    pairs: [
      { left: 'P', right: 'ii' },
      { left: 'Q', right: 'iv' },
    ],
  }),
);

function numericKey(overrides: Partial<NumericAnswerSpecData> = {}): AnswerKey {
  return expectValue(
    createAnswerKey({
      kind: 'NUMERIC',
      spec: {
        expectedValue: '9.81',
        comparisonMode: 'ABSOLUTE_TOLERANCE',
        toleranceValue: '0.01',
        acceptedForms: ['DECIMAL', 'FRACTION', 'SCIENTIFIC'],
        ...overrides,
      },
    }),
  );
}

const options = (...ids: string[]): ResponseSnapshot => ({ kind: 'OPTION_SELECTION', optionIds: ids });
const numeric = (raw: string): ResponseSnapshot => ({ kind: 'NUMERIC_ENTRY', raw });
const pairs = (...entries: [string, string][]): ResponseSnapshot => ({
  kind: 'MATCHING',
  pairs: entries.map(([left, right]) => ({ left, right })),
});

const evaluate = (condition: Condition, response: ResponseSnapshot | undefined, key: AnswerKey): ConditionOutcome =>
  evaluateCondition(condition, slot(response, key), key);

describe('the closed set of eight', () => {
  it('declares exactly the eight conditions the document names', () => {
    expect([...CONDITION_KINDS]).toHaveLength(8);
  });

  it('returns an outcome for every kind without throwing', () => {
    for (const kind of CONDITION_KINDS) {
      const condition = { kind, minCorrect: 1, noIncorrect: false, count: 1 } as unknown as Condition;
      expect(() => evaluate(condition, options('B'), singleKey), kind).not.toThrow();
    }
  });
});

describe('UNATTEMPTED', () => {
  const condition: Condition = { kind: 'UNATTEMPTED' };

  it('matches when no response was recorded', () => {
    expect(evaluate(condition, undefined, singleKey)).toBe('matched');
  });

  it('does not match when a response exists', () => {
    expect(evaluate(condition, options('B'), singleKey)).toBe('not_matched');
  });

  it('does not match a wrong response', () => {
    expect(evaluate(condition, options('A'), singleKey)).toBe('not_matched');
  });
});

describe('ALWAYS', () => {
  const condition: Condition = { kind: 'ALWAYS' };

  it('matches an unattempted slot', () => {
    expect(evaluate(condition, undefined, singleKey)).toBe('matched');
  });

  it('matches a correct response', () => {
    expect(evaluate(condition, options('B'), singleKey)).toBe('matched');
  });

  it('matches an unreadable response — this is what catches the indeterminate', () => {
    expect(evaluate(condition, numeric('about ten'), numericKey())).toBe('matched');
  });
});

describe('EXACT_MATCH on a single-correct key', () => {
  const condition: Condition = { kind: 'EXACT_MATCH' };

  it('matches the correct option', () => {
    expect(evaluate(condition, options('B'), singleKey)).toBe('matched');
  });

  it('does not match a different option', () => {
    expect(evaluate(condition, options('A'), singleKey)).toBe('not_matched');
  });

  it('does not match when more than one option is selected', () => {
    expect(evaluate(condition, options('A', 'B'), singleKey)).toBe('not_matched');
  });

  it('does not match an unattempted slot', () => {
    expect(evaluate(condition, undefined, singleKey)).toBe('not_matched');
  });

  it('is indeterminate when the response shape does not fit the key', () => {
    expect(evaluate(condition, numeric('9.81'), singleKey)).toBe('indeterminate');
    expect(evaluate(condition, pairs(['P', 'ii']), singleKey)).toBe('indeterminate');
  });
});

describe('EXACT_MATCH on a multi-correct key', () => {
  const condition: Condition = { kind: 'EXACT_MATCH' };

  it('matches the exact correct set', () => {
    expect(evaluate(condition, options('A', 'B', 'C'), multiKey)).toBe('matched');
  });

  it('matches regardless of selection order', () => {
    expect(evaluate(condition, options('C', 'A', 'B'), multiKey)).toBe('matched');
  });

  it('does not match a subset', () => {
    expect(evaluate(condition, options('A', 'B'), multiKey)).toBe('not_matched');
  });

  it('does not match a superset', () => {
    expect(evaluate(condition, options('A', 'B', 'C', 'D'), multiKey)).toBe('not_matched');
  });

  it('is indeterminate on a response of the wrong shape', () => {
    expect(evaluate(condition, numeric('9.81'), multiKey)).toBe('indeterminate');
    expect(evaluate(condition, pairs(['P', 'ii']), multiKey)).toBe('indeterminate');
  });
});

describe('EXACT_MATCH on a matching key', () => {
  const condition: Condition = { kind: 'EXACT_MATCH' };

  it('matches every pair correctly paired', () => {
    expect(evaluate(condition, pairs(['P', 'ii'], ['Q', 'iv']), matchingKey)).toBe('matched');
  });

  it('does not match when a pair is wrong', () => {
    expect(evaluate(condition, pairs(['P', 'iv'], ['Q', 'ii']), matchingKey)).toBe('not_matched');
  });

  it('does not match when a pair is missing', () => {
    expect(evaluate(condition, pairs(['P', 'ii']), matchingKey)).toBe('not_matched');
  });

  it('is indeterminate on a response of the wrong shape', () => {
    expect(evaluate(condition, options('P'), matchingKey)).toBe('indeterminate');
  });
});

describe('EXACT_MATCH on a numeric key', () => {
  const condition: Condition = { kind: 'EXACT_MATCH' };

  it('matches inside the tolerance', () => {
    expect(evaluate(condition, numeric('9.815'), numericKey())).toBe('matched');
  });

  it('matches exactly on the tolerance boundary', () => {
    expect(evaluate(condition, numeric('9.82'), numericKey())).toBe('matched');
  });

  it('does not match outside the tolerance', () => {
    expect(evaluate(condition, numeric('9.9'), numericKey())).toBe('not_matched');
  });

  it('is indeterminate when the entry cannot be read', () => {
    expect(evaluate(condition, numeric('about ten'), numericKey())).toBe('indeterminate');
  });

  it('is indeterminate when a grouping is ambiguous and survives normalization', () => {
    expect(evaluate(condition, numeric('9,81'), numericKey())).toBe('indeterminate');
  });

  it('is indeterminate on a response of the wrong shape', () => {
    expect(evaluate(condition, options('B'), numericKey())).toBe('indeterminate');
  });

  it('rejects a form the author excluded as a wrong answer, not an unreadable one', () => {
    const decimalOnly = numericKey({ expectedValue: '0.75', toleranceValue: '0', acceptedForms: ['DECIMAL'] });
    expect(evaluate(condition, numeric('3/4'), decimalOnly)).toBe('not_matched');
    expect(evaluate(condition, numeric('0.75'), decimalOnly)).toBe('matched');
  });

  it('is indeterminate when a required unit is omitted', () => {
    const withUnit = numericKey({
      unit: { canonical: 'm/s^2', acceptedEquivalents: [], required: true },
    });
    expect(evaluate(condition, numeric('9.81'), withUnit)).toBe('indeterminate');
  });

  it('matches when the required unit is supplied', () => {
    const withUnit = numericKey({
      unit: { canonical: 'm/s^2', acceptedEquivalents: [], required: true },
    });
    expect(evaluate(condition, numeric('9.81 m/s^2'), withUnit)).toBe('matched');
  });

  it('does not match when the supplied unit is wrong', () => {
    const withUnit = numericKey({
      unit: { canonical: 'm/s^2', acceptedEquivalents: [], required: true },
    });
    expect(evaluate(condition, numeric('9.81 kg'), withUnit)).toBe('not_matched');
  });
});

describe('NO_MATCH', () => {
  const condition: Condition = { kind: 'NO_MATCH' };

  it('matches a recognised wrong answer', () => {
    expect(evaluate(condition, options('A'), singleKey)).toBe('matched');
  });

  it('does not match a correct answer', () => {
    expect(evaluate(condition, options('B'), singleKey)).toBe('not_matched');
  });

  it('does not match an unattempted slot — absence is not wrongness', () => {
    expect(evaluate(condition, undefined, singleKey)).toBe('not_matched');
  });

  it('is indeterminate on an unreadable entry, so it never penalises one', () => {
    // The single most important assertion for ADR-0003: an unparseable numeric
    // entry must not reach NO_MATCH, because NO_MATCH deducts a mark.
    expect(evaluate(condition, numeric('nine point eight'), numericKey())).toBe('indeterminate');
  });

  it('is indeterminate when a required unit is omitted', () => {
    const withUnit = numericKey({
      unit: { canonical: 'm/s^2', acceptedEquivalents: [], required: true },
    });
    expect(evaluate(condition, numeric('9.81'), withUnit)).toBe('indeterminate');
  });

  it('is indeterminate on a response whose shape does not fit the key', () => {
    expect(evaluate(condition, numeric('9.81'), singleKey)).toBe('indeterminate');
  });

  it('is the exact inversion of EXACT_MATCH wherever both are decided', () => {
    const cases: readonly [ResponseSnapshot | undefined, AnswerKey][] = [
      [options('B'), singleKey],
      [options('A'), singleKey],
      [options('A', 'B', 'C'), multiKey],
      [options('A'), multiKey],
      [numeric('9.81'), numericKey()],
      [numeric('1'), numericKey()],
    ];
    for (const [response, key] of cases) {
      const exact = evaluate({ kind: 'EXACT_MATCH' }, response, key);
      const inverse = evaluate(condition, response, key);
      expect(inverse).toBe(exact === 'matched' ? 'not_matched' : 'matched');
    }
  });
});

describe('ALL_CORRECT_SELECTED', () => {
  const condition: Condition = { kind: 'ALL_CORRECT_SELECTED' };

  it('matches every correct option with none incorrect', () => {
    expect(evaluate(condition, options('A', 'B', 'C'), multiKey)).toBe('matched');
  });

  it('does not match a partial selection', () => {
    expect(evaluate(condition, options('A', 'B'), multiKey)).toBe('not_matched');
  });

  it('does not match when an incorrect option is included', () => {
    expect(evaluate(condition, options('A', 'B', 'C', 'D'), multiKey)).toBe('not_matched');
  });

  it('does not match an unattempted slot', () => {
    expect(evaluate(condition, undefined, multiKey)).toBe('not_matched');
  });

  it('is indeterminate against a key that has no notion of multiple correct options', () => {
    expect(evaluate(condition, options('B'), singleKey)).toBe('indeterminate');
  });

  it('is indeterminate on a response of the wrong shape', () => {
    expect(evaluate(condition, pairs(['P', 'ii']), multiKey)).toBe('indeterminate');
  });
});

describe('PARTIAL_CORRECT_SELECTED', () => {
  const twoClean: Condition = { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 2, noIncorrect: true };
  const twoDirty: Condition = { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 2, noIncorrect: false };

  it('does not match one below the minimum', () => {
    expect(evaluate(twoClean, options('A'), multiKey)).toBe('not_matched');
  });

  it('matches exactly at the minimum', () => {
    expect(evaluate(twoClean, options('A', 'B'), multiKey)).toBe('matched');
  });

  it('matches above the minimum', () => {
    expect(evaluate(twoClean, options('A', 'B', 'C'), multiKey)).toBe('matched');
  });

  it('does not match when an incorrect option is present and none is allowed', () => {
    expect(evaluate(twoClean, options('A', 'B', 'D'), multiKey)).toBe('not_matched');
  });

  it('matches with an incorrect option present when the constraint is relaxed', () => {
    expect(evaluate(twoDirty, options('A', 'B', 'D'), multiKey)).toBe('matched');
  });

  it('does not match an unattempted slot', () => {
    expect(evaluate(twoClean, undefined, multiKey)).toBe('not_matched');
  });

  it('is indeterminate against a key without multiple correct options', () => {
    expect(evaluate(twoClean, options('B'), singleKey)).toBe('indeterminate');
  });

  it('is indeterminate on a response of the wrong shape', () => {
    expect(evaluate(twoClean, pairs(['P', 'ii']), multiKey)).toBe('indeterminate');
  });
});

describe('ANY_INCORRECT_SELECTED', () => {
  const condition: Condition = { kind: 'ANY_INCORRECT_SELECTED' };

  it('matches when an incorrect option is selected', () => {
    expect(evaluate(condition, options('A', 'D'), multiKey)).toBe('matched');
  });

  it('does not match a wholly correct selection', () => {
    expect(evaluate(condition, options('A', 'B'), multiKey)).toBe('not_matched');
  });

  it('does not match an unattempted slot', () => {
    expect(evaluate(condition, undefined, multiKey)).toBe('not_matched');
  });

  it('is indeterminate against a key without multiple correct options', () => {
    expect(evaluate(condition, options('B'), singleKey)).toBe('indeterminate');
  });

  it('is indeterminate on a response of the wrong shape', () => {
    expect(evaluate(condition, pairs(['P', 'ii']), multiKey)).toBe('indeterminate');
  });
});

describe('MATCHING_PAIRS_CORRECT', () => {
  const exactlyTwo: Condition = { kind: 'MATCHING_PAIRS_CORRECT', count: 2 };
  const exactlyOne: Condition = { kind: 'MATCHING_PAIRS_CORRECT', count: 1 };

  it('matches at exactly the stated count', () => {
    expect(evaluate(exactlyTwo, pairs(['P', 'ii'], ['Q', 'iv']), matchingKey)).toBe('matched');
  });

  it('does not match one below the count', () => {
    expect(evaluate(exactlyTwo, pairs(['P', 'ii'], ['Q', 'ii']), matchingKey)).toBe('not_matched');
  });

  it('does not match one above the count', () => {
    expect(evaluate(exactlyOne, pairs(['P', 'ii'], ['Q', 'iv']), matchingKey)).toBe('not_matched');
  });

  it('counts only correctly matched pairs', () => {
    expect(evaluate(exactlyOne, pairs(['P', 'ii'], ['Q', 'ii']), matchingKey)).toBe('matched');
  });

  it('does not match an unattempted slot', () => {
    expect(evaluate(exactlyTwo, undefined, matchingKey)).toBe('not_matched');
  });

  it('is indeterminate against a key that is not a matching key', () => {
    expect(evaluate(exactlyTwo, pairs(['P', 'ii']), singleKey)).toBe('indeterminate');
  });

  it('is indeterminate on a response of the wrong shape', () => {
    expect(evaluate(exactlyTwo, options('P'), matchingKey)).toBe('indeterminate');
  });
});

describe('an unknown condition kind', () => {
  const unknown = { kind: 'ASSERTION_REASON_CORRECT' } as unknown as Condition;

  it('is inert — neither matching nor throwing', () => {
    expect(evaluate(unknown, options('B'), singleKey)).toBe('not_matched');
  });

  it('does not match even a correct response', () => {
    expect(evaluate(unknown, options('B'), singleKey)).not.toBe('matched');
  });
});
