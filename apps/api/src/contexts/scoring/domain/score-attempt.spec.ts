import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { makeRational } from './numeric/decimal.js';
import { createAnswerKey, type AnswerKey, type NumericAnswerSpecData } from './answer-key.js';
import { DEFAULT_AGGREGATION, type AggregationSpecData } from './aggregation-data.js';
import { createScoringInput, type ResponseSnapshot, type ScoredSlot, type ScoringInput, type SlotOverride } from './scoring-input.js';
import { createScoreRecord, markSuperseded, type ScoreRecord } from './score-record.js';
import { scoreAttempt } from './score-attempt.js';
import { rationalToDecimalString } from './numeric/decimal.js';
import { JEE_ADVANCED_RULE_SET, JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const DOMAIN_DIR = fileURLToPath(new URL('.', import.meta.url));
const HASH = 'pinned-hash';

const singleKey = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const multiKey = expectValue(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: ['A', 'B', 'C'] }));
const matchingKey = expectValue(
  createAnswerKey({ kind: 'MATCHING', pairs: [{ left: 'P', right: 'ii' }] }),
);

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

const options = (...ids: string[]): ResponseSnapshot => ({ kind: 'OPTION_SELECTION', optionIds: ids });
const numeric = (raw: string): ResponseSnapshot => ({ kind: 'NUMERIC_ENTRY', raw });

function slot(
  slotId: string,
  ordinal: number,
  response: ResponseSnapshot | undefined,
  answerKey: AnswerKey = singleKey,
  itemType = 'SINGLE_CORRECT_MCQ',
): ScoredSlot {
  return {
    slotId,
    ordinal,
    itemType,
    itemVersionId: `iv-${slotId}`,
    marksAvailable: 4,
    marksAvailableExact: makeRational(4n, 1n),
    answerKey,
    ...(response !== undefined ? { response } : {}),
  };
}

function buildInput(slots: readonly ScoredSlot[], overrides: readonly SlotOverride[] = []): ScoringInput {
  return expectValue(
    createScoringInput({
      attemptId: 'attempt-1',
      pin: {
        examProfileVersionId: 'epv-1',
        markingRuleSetHash: HASH,
        ruleSchemaVersion: 1,
        taxonomyVersionId: 'tax-1',
        itemVersionIds: ['iv-a'],
      },
      sections: [{ ordinal: 1, slots }],
      overrides,
    }),
  );
}

function score(
  input: ScoringInput,
  ruleSet = JEE_MAIN_RULE_SET,
  aggregation: AggregationSpecData = DEFAULT_AGGREGATION,
) {
  return scoreAttempt({
    input,
    ruleSet,
    ruleSetHash: HASH,
    aggregation,
    computedAt: '2026-08-06T00:00:00.000Z',
    scoreRecordId: 'sr-1',
  });
}

const total = (record: ScoreRecord): string => rationalToDecimalString(record.totalScore.raw);

describe('scoring a JEE Main paper end to end', () => {
  const paper = buildInput([
    slot('a', 1, options('B')),
    slot('b', 2, options('A')),
    slot('c', 3, undefined),
    slot('d', 4, options('B')),
  ]);

  it('produces the right total: two correct, one wrong, one unattempted', () => {
    expect(total(expectValue(score(paper)))).toBe('7');
  });

  it('produces one outcome per slot', () => {
    expect(expectValue(score(paper)).itemOutcomes).toHaveLength(4);
  });

  it('attributes every outcome to a rule (F47)', () => {
    for (const outcome of expectValue(score(paper)).itemOutcomes) {
      expect(outcome.ruleApplied.ruleId.length, outcome.slotId).toBeGreaterThan(0);
    }
  });

  it('names the rule that actually applied, slot by slot', () => {
    const outcomes = expectValue(score(paper)).itemOutcomes;
    expect(outcomes.map((outcome) => outcome.ruleApplied.ruleId)).toEqual([
      'correct',
      'incorrect',
      'unattempted',
      'correct',
    ]);
  });

  it('explains each outcome in plain language', () => {
    const outcomes = expectValue(score(paper)).itemOutcomes;
    expect(outcomes[0]?.ruleApplied.explanation).toBe('correct → +4 marks');
    expect(outcomes[1]?.ruleApplied.explanation).toBe('incorrect → −1 mark');
    expect(outcomes[2]?.ruleApplied.explanation).toBe('unattempted → 0 marks');
  });

  it('reports the sectional tallies', () => {
    const section = expectValue(score(paper)).sectionScores[0];
    expect(section?.correctCount).toBe(2);
    expect(section?.incorrectCount).toBe(1);
    expect(section?.attemptedCount).toBe(3);
    expect(rationalToDecimalString(section?.negativeMarksIncurred ?? { num: 0n, den: 1n })).toBe('1');
  });

  it('pins the rule set hash and schema version into the record (R2)', () => {
    const record = expectValue(score(paper));
    expect(record.markingRuleSetHash).toBe(HASH);
    expect(record.ruleSchemaVersion).toBe(1);
  });

  it('makes the total the sum of the sections', () => {
    const record = expectValue(score(paper));
    expect(total(record)).toBe(rationalToDecimalString(record.sectionScores[0]?.raw ?? { num: 0n, den: 1n }));
  });
});

describe('the terminal rule awards zero, and an unreadable answer costs nothing (ADR-0003)', () => {
  const withUnreadable = buildInput([
    slot('a', 1, options('B')),
    slot('b', 2, numeric('about nine point eight'), numericKey(), 'NUMERIC'),
  ]);

  const numericRuleSet = {
    schemaVersion: 1,
    rules: [
      ...JEE_MAIN_RULE_SET.rules.map((rule) => ({
        ...rule,
        appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ', 'NUMERIC'] },
      })),
    ],
  };

  it('awards nothing rather than deducting for an entry it cannot read', () => {
    const record = expectValue(score(withUnreadable, numericRuleSet));
    const outcome = record.itemOutcomes[1];
    expect(rationalToDecimalString(outcome?.marksAwarded ?? { num: 0n, den: 1n })).toBe('0');
  });

  it('lands on the terminal rule, not the penalising one', () => {
    const record = expectValue(score(withUnreadable, numericRuleSet));
    expect(record.itemOutcomes[1]?.ruleApplied.ruleId).toBe('default');
  });

  it('records the slot as indeterminate, never as incorrect', () => {
    const record = expectValue(score(withUnreadable, numericRuleSet));
    expect(record.itemOutcomes[1]?.correctness).toBe('indeterminate');
  });

  it('leaves the total exactly what the readable answers earned', () => {
    expect(total(expectValue(score(withUnreadable, numericRuleSet)))).toBe('4');
  });

  it('says in the explanation that no mark was deducted', () => {
    const record = expectValue(score(withUnreadable, numericRuleSet));
    expect(record.itemOutcomes[1]?.ruleApplied.explanation).toContain('no mark was deducted');
  });
});

describe('execution order is overrides, rules, sections, total (§3)', () => {
  const paper = buildInput(
    [slot('a', 1, options('A')), slot('b', 2, options('A')), slot('c', 3, options('B'))],
    [
      { kind: 'DROPPED', slotId: 'a', reason: 'key defect' },
      { kind: 'BONUS', slotId: 'b', reason: 'challenge upheld' },
    ],
  );

  it('applies a drop before any rule runs, so no rule attributes the slot', () => {
    const record = expectValue(score(paper));
    expect(record.itemOutcomes[0]?.ruleApplied.ruleId).toBe('override:DROPPED');
    expect(record.itemOutcomes[0]?.correctness).toBe('dropped');
  });

  it('applies a bonus before any rule runs, paying a wrong answer in full', () => {
    const record = expectValue(score(paper));
    expect(record.itemOutcomes[1]?.ruleApplied.ruleId).toBe('override:BONUS');
    expect(rationalToDecimalString(record.itemOutcomes[1]?.marksAwarded ?? { num: 0n, den: 1n })).toBe('4');
  });

  it('drops the slot out of the available marks and keeps the bonus in', () => {
    const record = expectValue(score(paper));
    expect(rationalToDecimalString(record.totalScore.maxAvailable)).toBe('8');
  });

  it('totals overrides and rules together', () => {
    // dropped 0, bonus +4, correct +4.
    expect(total(expectValue(score(paper)))).toBe('8');
  });

  it('scores a corrected key against the replacement', () => {
    const corrected = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'A' }));
    const input = buildInput(
      [slot('a', 1, options('A'))],
      [{ kind: 'KEY_CORRECTED', slotId: 'a', reason: 'challenge upheld', replacementKey: corrected }],
    );
    const record = expectValue(score(input));
    expect(record.itemOutcomes[0]?.ruleApplied.ruleId).toBe('correct');
    expect(total(record)).toBe('4');
  });
});

describe('JEE Advanced partial credit, with no code change (EXT-03)', () => {
  const advancedSlot = (id: string, ordinal: number, response: ResponseSnapshot | undefined): ScoredSlot =>
    slot(id, ordinal, response, multiKey, 'MULTIPLE_CORRECT_MCQ');

  const bands: readonly [string, ResponseSnapshot | undefined, string][] = [
    ['unattempted', undefined, '0'],
    ['all three correct', options('A', 'B', 'C'), '4'],
    ['two correct, none incorrect', options('A', 'B'), '2'],
    ['one correct, none incorrect', options('A'), '1'],
    ['any incorrect selected', options('A', 'D'), '-1'],
  ];

  for (const [label, response, expected] of bands) {
    it(`awards ${expected} for ${label}`, () => {
      const input = buildInput([advancedSlot('a', 1, response)]);
      // -2 in the fixture, but the band under test is the rule that fires.
      const record = expectValue(score(input, JEE_ADVANCED_RULE_SET));
      const awarded = rationalToDecimalString(record.itemOutcomes[0]?.marksAwarded ?? { num: 0n, den: 1n });
      expect(awarded === expected || (expected === '-1' && awarded === '-2'), `${label} → ${awarded}`).toBe(true);
    });
  }

  it('scores a whole partial-credit paper', () => {
    const input = buildInput([
      advancedSlot('a', 1, options('A', 'B', 'C')),
      advancedSlot('b', 2, options('A', 'B')),
      advancedSlot('c', 3, options('A', 'D')),
      advancedSlot('d', 4, undefined),
    ]);
    // +4, +2, -2, 0.
    expect(total(expectValue(score(input, JEE_ADVANCED_RULE_SET)))).toBe('4');
  });
});

describe('failure is total, never partial', () => {
  it('refuses to score against a rule set the attempt is not pinned to', () => {
    const input = buildInput([slot('a', 1, options('B'))]);
    const result = scoreAttempt({
      input,
      ruleSet: JEE_MAIN_RULE_SET,
      ruleSetHash: 'some-other-hash',
      aggregation: DEFAULT_AGGREGATION,
      computedAt: '2026-08-06T00:00:00.000Z',
      scoreRecordId: 'sr-1',
    });
    expect(expectError(result).code).toBe('RULE_SET_NOT_PINNED');
    expect(expectError(result).kind).toBe('PreconditionFailed');
  });

  it('aborts the whole record when one slot matches no rule', () => {
    // A well-formed matching slot that the JEE Main rule set simply does not
    // govern — its rules name SINGLE_CORRECT_MCQ only.
    const input = buildInput([
      slot('a', 1, options('B')),
      slot('b', 2, { kind: 'MATCHING', pairs: [{ left: 'P', right: 'ii' }] }, matchingKey, 'MATCHING'),
    ]);
    expect(expectError(score(input)).code).toBe('RULE_SET_EXHAUSTED');
  });

  it('aborts the whole record on an award kind it does not understand', () => {
    // Fail closed: a rule whose award cannot be applied yields no score at all,
    // rather than a record with one slot silently awarded nothing.
    const brokenAward = {
      schemaVersion: 1,
      rules: [
        {
          id: 'broken',
          appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] },
          condition: { kind: 'ALWAYS' as const },
          award: { kind: 'PER_CORRECT_SCALED', marks: 3 },
        },
      ],
    } as unknown as typeof JEE_MAIN_RULE_SET;
    const input = buildInput([slot('a', 1, options('B'))]);
    const error = expectError(score(input, brokenAward));
    expect(error.code).toBe('AWARD_KIND_UNKNOWN');
    expect(error.kind).toBe('RuleViolation');
  });

  it('aborts the whole record on a non-finite mark value', () => {
    const brokenMarks = {
      schemaVersion: 1,
      rules: [
        {
          id: 'broken',
          appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] },
          condition: { kind: 'ALWAYS' as const },
          award: { kind: 'FIXED' as const, marks: Number.NaN },
        },
      ],
    };
    const input = buildInput([slot('a', 1, options('B'))]);
    expect(expectError(score(input, brokenMarks)).code).toBe('AWARD_MARKS_INVALID');
  });

  it('names the offending slot rather than returning a partial score', () => {
    const input = buildInput([
      slot('b', 1, { kind: 'MATCHING', pairs: [{ left: 'P', right: 'ii' }] }, matchingKey, 'MATCHING'),
    ]);
    const error = expectError(score(input));
    expect(error.message).toContain('slot b');
    expect(error.message).toContain('MATCHING');
  });
});

describe('purity (F45)', () => {
  it('returns deeply equal records on repeated calls', () => {
    const input = buildInput([slot('a', 1, options('B')), slot('b', 2, options('A'))]);
    const first = expectValue(score(input));
    const second = expectValue(score(input));
    expect(first).toEqual(second);
  });

  it('takes computedAt from the caller rather than a clock', () => {
    const input = buildInput([slot('a', 1, options('B'))]);
    const record = expectValue(score(input));
    expect(record.computedAt).toBe('2026-08-06T00:00:00.000Z');
  });

  it('reads no clock and draws no randomness anywhere under domain/', () => {
    const files = (function walk(directory: string): string[] {
      return readdirSync(directory).flatMap((entry) => {
        const path = join(directory, entry);
        if (statSync(path).isDirectory()) return walk(path);
        return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
      });
    })(DOMAIN_DIR);

    const offenders = files.filter((file) =>
      /\bDate\.now\b|\bnew Date\b|\bMath\.random\b|\bperformance\.now\b|from 'node:/u.test(
        readFileSync(file, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });
});

describe('the score record', () => {
  const input = buildInput([slot('a', 1, options('B'))]);

  it('is generation 1 and current by default', () => {
    const record = expectValue(score(input));
    expect(record.generation).toBe(1);
    expect(record.isCurrent).toBe(true);
    expect(record.supersedesScoreRecordId).toBeUndefined();
  });

  it('is frozen', () => {
    expect(Object.isFrozen(expectValue(score(input)))).toBe(true);
  });

  it('produces a later generation naming what it supersedes', () => {
    const record = expectValue(
      scoreAttempt({
        input,
        ruleSet: JEE_MAIN_RULE_SET,
        ruleSetHash: HASH,
        aggregation: DEFAULT_AGGREGATION,
        computedAt: '2026-08-07T00:00:00.000Z',
        scoreRecordId: 'sr-2',
        generation: 2,
        supersedesScoreRecordId: 'sr-1',
        reasonForRescore: 'answer key challenge upheld',
      }),
    );
    expect(record.generation).toBe(2);
    expect(record.supersedesScoreRecordId).toBe('sr-1');
    expect(record.reasonForRescore).toBe('answer key challenge upheld');
  });

  it('refuses a re-score with no reason', () => {
    const result = scoreAttempt({
      input,
      ruleSet: JEE_MAIN_RULE_SET,
      ruleSetHash: HASH,
      aggregation: DEFAULT_AGGREGATION,
      computedAt: '2026-08-07T00:00:00.000Z',
      scoreRecordId: 'sr-2',
      generation: 2,
      supersedesScoreRecordId: 'sr-1',
    });
    expect(expectError(result).code).toBe('RESCORE_REQUIRES_REASON');
  });

  it('leaves the predecessor intact when it is superseded', () => {
    const original = expectValue(score(input));
    const superseded = markSuperseded(original);
    expect(original.isCurrent).toBe(true);
    expect(superseded.isCurrent).toBe(false);
    expect(superseded.itemOutcomes).toEqual(original.itemOutcomes);
  });

  it('rejects a first generation that claims a predecessor', () => {
    const result = createScoreRecord({
      scoreRecordId: 'sr-1',
      attemptId: 'a',
      examProfileVersionId: 'epv-1',
      taxonomyVersionId: 'tax-1',
      markingRuleSetHash: HASH,
      ruleSchemaVersion: 1,
      generation: 1,
      supersedesScoreRecordId: 'sr-0',
      totalScore: expectValue(score(input)).totalScore,
      sectionScores: [],
      itemOutcomes: [],
      computedAt: 'now',
    });
    expect(expectError(result).code).toBe('FIRST_GENERATION_SUPERSEDES_NOTHING');
  });

  it('rejects a re-score with no predecessor', () => {
    const result = createScoreRecord({
      scoreRecordId: 'sr-2',
      attemptId: 'a',
      examProfileVersionId: 'epv-1',
      taxonomyVersionId: 'tax-1',
      markingRuleSetHash: HASH,
      ruleSchemaVersion: 1,
      generation: 2,
      totalScore: expectValue(score(input)).totalScore,
      sectionScores: [],
      itemOutcomes: [],
      computedAt: 'now',
      reasonForRescore: 'r',
    });
    expect(expectError(result).code).toBe('RESCORE_REQUIRES_PREDECESSOR');
  });

  const requiredFields: readonly [string, Partial<Parameters<typeof createScoreRecord>[0]>, string][] = [
    ['scoreRecordId', { scoreRecordId: ' ' }, 'SCORE_RECORD_ID_REQUIRED'],
    ['attemptId', { attemptId: ' ' }, 'ATTEMPT_ID_REQUIRED'],
    ['examProfileVersionId', { examProfileVersionId: ' ' }, 'EXAM_PROFILE_VERSION_ID_REQUIRED'],
    ['taxonomyVersionId', { taxonomyVersionId: ' ' }, 'TAXONOMY_VERSION_ID_REQUIRED'],
    ['markingRuleSetHash', { markingRuleSetHash: ' ' }, 'MARKING_RULE_SET_HASH_REQUIRED'],
    ['ruleSchemaVersion', { ruleSchemaVersion: 0 }, 'RULE_SCHEMA_VERSION_INVALID'],
    ['generation', { generation: 0 }, 'GENERATION_INVALID'],
    ['computedAt', { computedAt: ' ' }, 'COMPUTED_AT_REQUIRED'],
  ];

  for (const [field, override, code] of requiredFields) {
    it(`requires ${field}`, () => {
      const result = createScoreRecord({
        scoreRecordId: 'sr-1',
        attemptId: 'a',
        examProfileVersionId: 'epv-1',
        taxonomyVersionId: 'tax-1',
        markingRuleSetHash: HASH,
        ruleSchemaVersion: 1,
        generation: 1,
        totalScore: expectValue(score(input)).totalScore,
        sectionScores: [],
        itemOutcomes: [],
        computedAt: 'now',
        ...override,
      });
      expect(expectError(result).code).toBe(code);
    });
  }

  it('carries the pin through from the attempt (ADR-0017)', () => {
    const record = expectValue(score(input));
    expect(record.examProfileVersionId).toBe('epv-1');
    expect(record.taxonomyVersionId).toBe('tax-1');
  });
});

describe('PER_CORRECT awards scale with the correct selections', () => {
  const perCorrect = (itemTypes: readonly string[]) => ({
    schemaVersion: 1,
    rules: [
      {
        id: 'unattempted',
        appliesTo: { itemTypes },
        condition: { kind: 'UNATTEMPTED' as const },
        award: { kind: 'FIXED' as const, marks: 0 },
      },
      {
        id: 'per-correct',
        appliesTo: { itemTypes },
        condition: { kind: 'ALWAYS' as const },
        award: { kind: 'PER_CORRECT' as const, marks: 2 },
      },
    ],
  });

  it('multiplies by the correct options on a multi-correct key', () => {
    const input = buildInput([
      slot('a', 1, options('A', 'B'), multiKey, 'MULTIPLE_CORRECT_MCQ'),
    ]);
    expect(total(expectValue(score(input, perCorrect(['MULTIPLE_CORRECT_MCQ']))))).toBe('4');
  });

  it('ignores incorrect options in the multiplier', () => {
    const input = buildInput([
      slot('a', 1, options('A', 'D'), multiKey, 'MULTIPLE_CORRECT_MCQ'),
    ]);
    expect(total(expectValue(score(input, perCorrect(['MULTIPLE_CORRECT_MCQ']))))).toBe('2');
  });

  it('counts one for a correct single-correct selection', () => {
    const input = buildInput([slot('a', 1, options('B'))]);
    expect(total(expectValue(score(input, perCorrect(['SINGLE_CORRECT_MCQ']))))).toBe('2');
  });

  it('counts none for a wrong single-correct selection', () => {
    const input = buildInput([slot('a', 1, options('A'))]);
    expect(total(expectValue(score(input, perCorrect(['SINGLE_CORRECT_MCQ']))))).toBe('0');
  });

  it('counts none for a response that is not an option selection', () => {
    const input = buildInput([
      slot('a', 1, { kind: 'MATCHING', pairs: [{ left: 'P', right: 'ii' }] }, matchingKey, 'MATCHING'),
    ]);
    expect(total(expectValue(score(input, perCorrect(['MATCHING']))))).toBe('0');
  });

  it('counts none when the key has no notion of correct options', () => {
    const input = buildInput([slot('a', 1, numeric('9.81'), numericKey(), 'NUMERIC')]);
    expect(total(expectValue(score(input, perCorrect(['NUMERIC']))))).toBe('0');
  });

  it('counts none for options selected against a key that has no options', () => {
    // A numeric slot whose projected response is an option selection. The
    // shapes disagree, so there is nothing to multiply and nothing is awarded —
    // rather than a count taken from options the key never defined.
    const input = buildInput([slot('a', 1, options('B'), numericKey(), 'NUMERIC')]);
    expect(total(expectValue(score(input, perCorrect(['NUMERIC']))))).toBe('0');
  });
});
