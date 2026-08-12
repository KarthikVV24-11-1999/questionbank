import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, AUTHORED_AT, FOUR_OPTIONS, itemOption, textBody } from '../../../testing/content-fixtures.js';
import {
  createResponseSpecification,
  type CreateResponseSpecificationProps,
  type NumericAnswerSpecData,
  type ResponseSpecification,
} from '../domain/response-specification.js';
import {
  createSolutionVersion,
  type CreateSolutionVersionProps,
  type FinalAnswerAssertion,
  type SolutionVersion,
} from '../domain/solution.js';
import { checkFinalAnswerMatchesKey, solutionAgreesWithKey } from './final-answer-agreement.js';

function spec(props: CreateResponseSpecificationProps): ResponseSpecification {
  return expectValue(createResponseSpecification(props));
}

function solution(finalAnswerAssertion: FinalAnswerAssertion): SolutionVersion {
  const props: CreateSolutionVersionProps = {
    versionId: 'solution-version-1',
    versionNo: 1,
    finalAnswerAssertion,
    steps: [{ ordinal: 1, body: textBody('derivation'), conceptRefs: [] }],
    authoredBy: AUTHOR,
    createdAt: AUTHORED_AT,
  };
  return expectValue(createSolutionVersion(props));
}

const SINGLE = spec({
  itemType: 'SINGLE_CORRECT_MCQ',
  options: FOUR_OPTIONS,
  correctOptionId: 'b',
});

const MULTI = spec({
  itemType: 'MULTIPLE_CORRECT_MCQ',
  options: FOUR_OPTIONS,
  correctOptionIds: ['a', 'c'],
});

const MATCHING = spec({
  itemType: 'MATCHING',
  left: [
    { memberId: 'l1', ordinal: 1, body: textBody('l1') },
    { memberId: 'l2', ordinal: 2, body: textBody('l2') },
  ],
  right: [
    { memberId: 'r1', ordinal: 1, body: textBody('r1') },
    { memberId: 'r2', ordinal: 2, body: textBody('r2') },
  ],
  pairs: [
    { left: 'l1', right: 'r2' },
    { left: 'l2', right: 'r1' },
  ],
});

function numeric(overrides: Partial<NumericAnswerSpecData> = {}): ResponseSpecification {
  return spec({
    itemType: 'NUMERIC',
    spec: {
      expectedValue: '9.81',
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      toleranceValue: '0.05',
      acceptedForms: ['DECIMAL'],
      ...overrides,
    },
  });
}

describe('option items', () => {
  it('agrees when the solution states the correct option', () => {
    expect(expectValue(checkFinalAnswerMatchesKey(solution({ kind: 'OPTION', optionId: 'b' }), SINGLE))).toBe(
      true,
    );
  });

  // The defect class this exists to catch: a learner reads the derivation,
  // answers what it says, and is marked wrong.
  it('disagrees when the solution states a different option, naming it', () => {
    const failure = expectError(
      checkFinalAnswerMatchesKey(solution({ kind: 'OPTION', optionId: 'a' }), SINGLE),
    );
    expect(failure.code).toBe('FINAL_ANSWER_DISAGREES_WITH_KEY');
    expect(failure.message).toContain('option a');
  });

  it('agrees when a multi-correct solution states the exact set, in any order', () => {
    for (const optionIds of [['a', 'c'], ['c', 'a']]) {
      expect(solutionAgreesWithKey(solution({ kind: 'OPTION_SET', optionIds }), MULTI)).toBe(true);
    }
  });

  it('disagrees when a multi-correct solution omits one correct option', () => {
    expect(
      expectError(checkFinalAnswerMatchesKey(solution({ kind: 'OPTION_SET', optionIds: ['a'] }), MULTI)).code,
    ).toBe('FINAL_ANSWER_DISAGREES_WITH_KEY');
  });

  it('disagrees when a multi-correct solution adds an incorrect option', () => {
    expect(solutionAgreesWithKey(solution({ kind: 'OPTION_SET', optionIds: ['a', 'b', 'c'] }), MULTI)).toBe(
      false,
    );
  });
});

describe('matching items', () => {
  it('agrees on the correct pairing', () => {
    const assertion: FinalAnswerAssertion = {
      kind: 'PAIRS',
      pairs: [
        { left: 'l1', right: 'r2' },
        { left: 'l2', right: 'r1' },
      ],
    };
    expect(solutionAgreesWithKey(solution(assertion), MATCHING)).toBe(true);
  });

  it('disagrees when one pair is wrong', () => {
    const assertion: FinalAnswerAssertion = {
      kind: 'PAIRS',
      pairs: [
        { left: 'l1', right: 'r1' },
        { left: 'l2', right: 'r2' },
      ],
    };
    expect(solutionAgreesWithKey(solution(assertion), MATCHING)).toBe(false);
  });

  it('disagrees when the pairing is incomplete', () => {
    const assertion: FinalAnswerAssertion = { kind: 'PAIRS', pairs: [{ left: 'l1', right: 'r2' }] };
    expect(solutionAgreesWithKey(solution(assertion), MATCHING)).toBe(false);
  });
});

describe('numeric items — the executor decides, under the item’s own specification', () => {
  it('agrees on the exact expected value', () => {
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.81' }), numeric())).toBe(true);
  });

  // Agreement means "the executor would mark this correct". A learner
  // answering a value inside the band is marked correct, so there is no
  // defect to block — authorial imprecision is a review matter, not a
  // scoring one.
  it('agrees on a value inside the item’s own tolerance band', () => {
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.79' }), numeric())).toBe(true);
  });

  it('agrees exactly at the tolerance boundary, as the executor does', () => {
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.86' }), numeric())).toBe(true);
  });

  it('disagrees outside the band', () => {
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.7' }), numeric())).toBe(false);
  });

  // The comparison mode is the item's, not a rule invented here.
  it('honours EXACT mode, where a nearby value disagrees', () => {
    const exact = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '9.81', comparisonMode: 'EXACT', acceptedForms: ['DECIMAL'] },
    });
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.81' }), exact)).toBe(true);
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.79' }), exact)).toBe(false);
  });

  it('honours RANGE mode inclusively at both bounds', () => {
    const ranged = spec({
      itemType: 'NUMERIC',
      spec: {
        expectedValue: '5',
        comparisonMode: 'RANGE',
        rangeMin: '4',
        rangeMax: '6',
        acceptedForms: ['DECIMAL'],
      },
    });
    for (const value of ['4', '5', '6']) {
      expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value }), ranged)).toBe(true);
    }
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '6.01' }), ranged)).toBe(false);
  });

  it('treats trailing zeros as the same value, because the executor does', () => {
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.8100' }), numeric())).toBe(true);
  });

  it('agrees when the solution states the required unit', () => {
    const withUnit = numeric({
      unit: { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2'], required: true },
    });
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.81', unit: 'm/s^2' }), withUnit)).toBe(
      true,
    );
  });

  it('accepts an equivalent unit the specification allows', () => {
    const withUnit = numeric({
      unit: { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2'], required: true },
    });
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.81', unit: 'm s^-2' }), withUnit)).toBe(
      true,
    );
  });

  // indeterminate is not agreement: a solution omitting a required unit is
  // one the executor could not mark correct either.
  it('reports indeterminate when a required unit is omitted, and does not call it agreement', () => {
    const withUnit = numeric({
      unit: { canonical: 'm/s^2', acceptedEquivalents: [], required: true },
    });
    const failure = expectError(checkFinalAnswerMatchesKey(solution({ kind: 'NUMERIC', value: '9.81' }), withUnit));
    expect(failure.code).toBe('FINAL_ANSWER_INDETERMINATE');
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.81' }), withUnit)).toBe(false);
  });

  it('disagrees on a wrong unit', () => {
    const withUnit = numeric({
      unit: { canonical: 'm/s^2', acceptedEquivalents: [], required: true },
    });
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '9.81', unit: 'kg' }), withUnit)).toBe(
      false,
    );
  });

  it('honours the accepted answer forms the author restricted to', () => {
    const decimalOnly = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '0.75', comparisonMode: 'EXACT', acceptedForms: ['DECIMAL'] },
    });
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '3/4' }), decimalOnly)).toBe(false);
  });
});

describe('shape mismatches', () => {
  it.each([
    ['a numeric assertion on an option item', { kind: 'NUMERIC', value: '4' } as const, () => SINGLE],
    ['an option assertion on a numeric item', { kind: 'OPTION', optionId: 'b' } as const, () => numeric()],
    ['an option assertion on a matching item', { kind: 'OPTION', optionId: 'b' } as const, () => MATCHING],
    ['a pairing on a single-correct item', { kind: 'PAIRS', pairs: [{ left: 'a', right: 'b' }] } as const, () => SINGLE],
    ['an option set on a single-correct item', { kind: 'OPTION_SET', optionIds: ['b'] } as const, () => SINGLE],
    ['an option on a multi-correct item', { kind: 'OPTION', optionId: 'a' } as const, () => MULTI],
  ])('refuses %s', (_label, assertion, target) => {
    const failure = expectError(checkFinalAnswerMatchesKey(solution(assertion), target()));
    expect(failure.code).toBe('FINAL_ANSWER_SHAPE_MISMATCH');
  });
});

describe('an unusable key', () => {
  // Agreement cannot be decided against a key the executor refuses, and
  // saying "they agree" would be the worst possible answer.
  it('reports that agreement cannot be decided rather than guessing', () => {
    const incomplete = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '1', comparisonMode: 'RANGE', acceptedForms: ['DECIMAL'] },
    });
    const failure = expectError(
      checkFinalAnswerMatchesKey(solution({ kind: 'NUMERIC', value: '1' }), incomplete),
    );
    expect(failure.code).toBe('ANSWER_KEY_UNUSABLE');
    expect(failure.message).toContain('RANGE_BOUNDS_REQUIRED');
  });

  it('does not report agreement for an unusable key', () => {
    const incomplete = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '1', comparisonMode: 'ABSOLUTE_TOLERANCE', acceptedForms: ['DECIMAL'] },
    });
    expect(solutionAgreesWithKey(solution({ kind: 'NUMERIC', value: '1' }), incomplete)).toBe(false);
  });
});

describe('the check is re-runnable and pure', () => {
  it('gives the same verdict on repeated calls', () => {
    const version = solution({ kind: 'OPTION', optionId: 'b' });
    for (let run = 0; run < 50; run += 1) {
      expect(solutionAgreesWithKey(version, SINGLE)).toBe(true);
    }
  });

  // The key can change after the solution was written, which is why M3-11
  // re-checks at publication rather than trusting an authoring-time verdict.
  it('changes its verdict when the key changes under a fixed solution', () => {
    const version = solution({ kind: 'OPTION', optionId: 'b' });
    const rekeyed = spec({
      itemType: 'SINGLE_CORRECT_MCQ',
      options: FOUR_OPTIONS,
      correctOptionId: 'd',
    });
    expect(solutionAgreesWithKey(version, SINGLE)).toBe(true);
    expect(solutionAgreesWithKey(version, rekeyed)).toBe(false);
  });

  it('changes its verdict when an option is renamed under a fixed solution', () => {
    const version = solution({ kind: 'OPTION', optionId: 'b' });
    const renamed = spec({
      itemType: 'SINGLE_CORRECT_MCQ',
      options: [itemOption('w', 1), itemOption('x', 2), itemOption('y', 3), itemOption('z', 4)],
      correctOptionId: 'x',
    });
    expect(solutionAgreesWithKey(version, renamed)).toBe(false);
  });
});
