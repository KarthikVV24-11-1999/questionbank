import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { claimedAnswerOf, isVerifiable, normalizeAnswer, solveInputOf, VERIFIABLE_ITEM_TYPES } from './solve-input.js';

const OPTIONS = [
  { optionId: 'a', ordinal: 1, body: { text: 'one' } },
  { optionId: 'b', ordinal: 2, body: { text: 'two' } },
];
const SINGLE = { stem: { blocks: ['q'] }, responseSpec: { itemType: 'SINGLE_CORRECT_MCQ', options: OPTIONS, correctOptionId: 'b' } };
const MULTI = { stem: 'q', responseSpec: { itemType: 'MULTIPLE_CORRECT_MCQ', options: OPTIONS, correctOptionIds: ['b', 'a', 'a'] } };
const NUMERIC = {
  stem: 'q',
  responseSpec: { itemType: 'NUMERIC', spec: { expectedValue: '9.81', toleranceValue: '0.01', comparisonMode: 'ABSOLUTE_TOLERANCE', unit: { canonical: 'm/s^2' } } },
};

/** Every key at every depth, so a leak cannot hide inside a nested object. */
function keysOf(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysOf);
  if (typeof value === 'object' && value !== null) return Object.entries(value).flatMap(([key, inner]) => [key, ...keysOf(inner)]);
  return [];
}

describe('what an independent solver is shown', () => {
  it('is the stem and the options for a choice question, exactly', () => {
    const input = expectValue(solveInputOf('SINGLE_CORRECT_MCQ', SINGLE));
    expect(Object.keys(input).sort()).toEqual(['itemType', 'options', 'stem']);
    expect(input['stem']).toEqual(SINGLE.stem);
    expect(input['options']).toEqual(OPTIONS);
  });

  it('is the stem and the unit for a numeric question — never the expected value or the tolerance', () => {
    const input = expectValue(solveInputOf('NUMERIC', NUMERIC));
    expect(input).toEqual({ itemType: 'NUMERIC', stem: 'q', unit: 'm/s^2' });
    expect(JSON.stringify(input)).not.toMatch(/9\.81|0\.01|expectedValue|toleranceValue/u);
  });

  it('carries no unit when the specification names none', () => {
    expect(expectValue(solveInputOf('NUMERIC', { stem: 'q', responseSpec: { itemType: 'NUMERIC', spec: { expectedValue: '1' } } }))).toEqual({ itemType: 'NUMERIC', stem: 'q' });
    expect(expectValue(solveInputOf('NUMERIC', { stem: 'q', responseSpec: { itemType: 'NUMERIC', spec: { expectedValue: '1', unit: { canonical: 5 } } } }))).toEqual({ itemType: 'NUMERIC', stem: 'q' });
  });

  it('never carries a key, whatever the specification holds: it is built from an allowlist, so a new key-bearing field cannot leak', () => {
    const treacherous = {
      stem: 'q',
      responseSpec: { ...SINGLE.responseSpec, answerKey: 'b', isCorrect: true, correctOptionIds: ['b'], expectedValue: '1', finalAnswerAssertion: 'b', newKeyFieldNobodyListed: 'b' },
    };
    const keys = keysOf(expectValue(solveInputOf('SINGLE_CORRECT_MCQ', treacherous)));
    for (const forbidden of ['correctOptionId', 'correctOptionIds', 'answerKey', 'isCorrect', 'expectedValue', 'finalAnswerAssertion', 'newKeyFieldNobodyListed']) {
      expect(keys, forbidden).not.toContain(forbidden);
    }
  });

  it('refuses a proposal it cannot read, naming what', () => {
    expect(expectError(solveInputOf('SINGLE_CORRECT_MCQ', { stem: 'q' })).location).toBe('content.body.responseSpec');
    expect(expectError(solveInputOf('SINGLE_CORRECT_MCQ', { responseSpec: SINGLE.responseSpec })).code).toBe('PROPOSAL_UNREADABLE');
    expect(expectError(solveInputOf('SINGLE_CORRECT_MCQ', { stem: 'q', responseSpec: { options: 'x' } })).location).toBe('content.body.responseSpec.options');
    expect(expectError(solveInputOf('MULTIPLE_CORRECT_MCQ', { stem: 'q', responseSpec: { options: [1] } })).code).toBe('PROPOSAL_UNREADABLE');
  });
});

describe('what the proposal claims', () => {
  it('reads the claimed answer for each item type, in one canonical form', () => {
    expect(expectValue(claimedAnswerOf('SINGLE_CORRECT_MCQ', SINGLE))).toBe('b');
    expect(expectValue(claimedAnswerOf('MULTIPLE_CORRECT_MCQ', MULTI))).toEqual(['a', 'b']);
    expect(expectValue(claimedAnswerOf('NUMERIC', NUMERIC))).toBe('9.81');
  });

  it('refuses a specification with no key to compare against', () => {
    expect(expectError(claimedAnswerOf('SINGLE_CORRECT_MCQ', { stem: 'q' })).code).toBe('PROPOSAL_UNREADABLE');
    expect(expectError(claimedAnswerOf('SINGLE_CORRECT_MCQ', { responseSpec: { options: OPTIONS } })).location).toBe('content.body.responseSpec (its key)');
    expect(expectError(claimedAnswerOf('NUMERIC', { responseSpec: { spec: 5 } })).code).toBe('PROPOSAL_UNREADABLE');
  });
});

describe('answers compare in one canonical form', () => {
  it('trims a single answer and sorts and de-duplicates a set', () => {
    expect(normalizeAnswer('SINGLE_CORRECT_MCQ', ' b ')).toBe('b');
    expect(normalizeAnswer('MULTIPLE_CORRECT_MCQ', ['c', 'a', 'c'])).toEqual(['a', 'c']);
    expect(normalizeAnswer('NUMERIC', ' 9.81 ')).toBe('9.81');
    expect(normalizeAnswer('NUMERIC', 9.81)).toBe('9.81');
  });

  it('is undefined for anything that is not an answer', () => {
    for (const [type, raw] of [
      ['SINGLE_CORRECT_MCQ', ''], ['SINGLE_CORRECT_MCQ', 3], ['SINGLE_CORRECT_MCQ', undefined],
      ['MULTIPLE_CORRECT_MCQ', []], ['MULTIPLE_CORRECT_MCQ', 'a'], ['MULTIPLE_CORRECT_MCQ', ['a', ' ']],
      ['NUMERIC', ''], ['NUMERIC', Number.NaN], ['NUMERIC', null], ['NUMERIC', {}],
    ] as const) {
      expect(normalizeAnswer(type, raw), `${type} ${String(raw)}`).toBeUndefined();
    }
  });

  it('names exactly the item types an independent solve is defined for', () => {
    expect([...VERIFIABLE_ITEM_TYPES]).toEqual(['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'NUMERIC']);
    expect(isVerifiable('NUMERIC')).toBe(true);
    expect(isVerifiable('MATCHING')).toBe(false);
  });
});
