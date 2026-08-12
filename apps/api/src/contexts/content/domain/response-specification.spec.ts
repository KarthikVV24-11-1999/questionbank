import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { createContentBody, type Block, type ContentBody } from './content-body.js';
import {
  createResponseSpecification,
  incorrectOptionIdsOf,
  isItemType,
  ITEM_TYPES,
  MINIMUM_MATCHING_MEMBERS,
  MINIMUM_OPTIONS,
  optionsOf,
  V1_AUTHORED_ITEM_TYPES,
  type CreateResponseSpecificationProps,
  type ItemOption,
  type MatchingMember,
  type NumericAnswerSpecData,
} from './response-specification.js';

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('./response-specification.ts', import.meta.url)),
  'utf8',
);

function body(value: string): ContentBody {
  const block: Block = { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value, marks: [] }] };
  return expectValue(createContentBody([block]));
}

function option(optionId: string, ordinal: number, value = optionId): ItemOption {
  return { optionId, ordinal, body: body(value) };
}

function member(memberId: string, ordinal: number): MatchingMember {
  return { memberId, ordinal, body: body(memberId) };
}

const FOUR_OPTIONS: readonly ItemOption[] = [
  option('a', 1),
  option('b', 2),
  option('c', 3),
  option('d', 4),
];

const NUMERIC_SPEC: NumericAnswerSpecData = {
  expectedValue: '9.8',
  comparisonMode: 'ABSOLUTE_TOLERANCE',
  toleranceValue: '0.1',
  acceptedForms: ['DECIMAL'],
};

function singleCorrect(
  overrides: Partial<Extract<CreateResponseSpecificationProps, { itemType: 'SINGLE_CORRECT_MCQ' }>> = {},
): CreateResponseSpecificationProps {
  return { itemType: 'SINGLE_CORRECT_MCQ', options: FOUR_OPTIONS, correctOptionId: 'b', ...overrides };
}

describe('the item-type vocabulary', () => {
  it('is the closed set of four', () => {
    expect([...ITEM_TYPES]).toEqual(['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC']);
  });

  it('names the two the v1 authoring surface exposes (FR-TCH-02 rule 2)', () => {
    expect([...V1_AUTHORED_ITEM_TYPES]).toEqual(['SINGLE_CORRECT_MCQ', 'NUMERIC']);
  });

  it('recognises each type and rejects anything else', () => {
    for (const type of ITEM_TYPES) expect(isItemType(type)).toBe(true);
    expect(isItemType('ASSERTION_REASON')).toBe(false);
  });

  it('rejects an unknown item type at construction', () => {
    const rogue = { itemType: 'ASSERTION_REASON' } as unknown as CreateResponseSpecificationProps;
    expect(expectError(createResponseSpecification(rogue)).code).toBe('ITEM_TYPE_UNKNOWN');
  });
});

describe('an option body is ContentBody, not a string', () => {
  // The category's standard mistake. An option routinely *is* an equation, and
  // a string field forces either an image of it or markup in a text field —
  // both INV-14 violations that cannot be walked back later.
  it('declares option and member bodies as ContentBody', () => {
    expect(MODULE_SOURCE).toMatch(/readonly body: ContentBody;/u);
    expect(MODULE_SOURCE).not.toMatch(/readonly (body|text|label): string;/u);
  });

  it('carries an equation in an option', () => {
    const equation: Block = {
      kind: 'MATH_BLOCK',
      latex: '\\frac{1}{2}mv^2',
      textAlternative: 'one half m v squared',
    };
    const withMath: ItemOption = {
      optionId: 'a',
      ordinal: 1,
      body: expectValue(createContentBody([equation])),
    };
    const spec = expectValue(
      createResponseSpecification(singleCorrect({ options: [withMath, option('b', 2)], correctOptionId: 'a' })),
    );
    expect(optionsOf(spec)[0]?.body.blocks[0]).toMatchObject({ kind: 'MATH_BLOCK' });
  });
});

describe('SINGLE_CORRECT_MCQ', () => {
  it('constructs with four options and a key', () => {
    const spec = expectValue(createResponseSpecification(singleCorrect()));
    expect(optionsOf(spec)).toHaveLength(4);
  });

  it(`rejects fewer than ${MINIMUM_OPTIONS} options`, () => {
    expect(expectError(createResponseSpecification(singleCorrect({ options: [option('a', 1)] }))).code).toBe(
      'OPTIONS_TOO_FEW',
    );
  });

  it('rejects a blank option id', () => {
    const options = [option('  ', 1, 'an option whose id is blank'), option('b', 2)];
    expect(
      expectError(createResponseSpecification(singleCorrect({ options, correctOptionId: 'b' }))).code,
    ).toBe('OPTION_ID_REQUIRED');
  });

  it('rejects a duplicate option id, naming the repeat', () => {
    const options = [option('a', 1), option('a', 2)];
    const failure = expectError(createResponseSpecification(singleCorrect({ options, correctOptionId: 'a' })));
    expect(failure.code).toBe('OPTION_ID_DUPLICATE');
    expect(failure.location).toBe('responseSpec.options[1]');
  });

  // A gap means an option was deleted and the key may now point at a position
  // nobody sees.
  it('rejects an ordinal gap', () => {
    const options = [option('a', 1), option('b', 3)];
    expect(
      expectError(createResponseSpecification(singleCorrect({ options, correctOptionId: 'a' }))).code,
    ).toBe('OPTION_ORDINAL_GAP');
  });

  it('rejects ordinals not starting at 1', () => {
    const options = [option('a', 0), option('b', 1)];
    expect(
      expectError(createResponseSpecification(singleCorrect({ options, correctOptionId: 'a' }))).code,
    ).toBe('OPTION_ORDINAL_GAP');
  });

  it('accepts options supplied out of order, so long as the set is contiguous', () => {
    const options = [option('b', 2), option('a', 1)];
    expect(optionsOf(expectValue(createResponseSpecification(singleCorrect({ options }))))).toHaveLength(2);
  });

  it('rejects a blank key', () => {
    expect(expectError(createResponseSpecification(singleCorrect({ correctOptionId: '' }))).code).toBe(
      'CORRECT_OPTION_REQUIRED',
    );
  });

  it('rejects a key naming an option the item does not have', () => {
    expect(expectError(createResponseSpecification(singleCorrect({ correctOptionId: 'z' }))).code).toBe(
      'CORRECT_OPTION_UNKNOWN',
    );
  });

  it('reports every option but the correct one as a distractor', () => {
    const spec = expectValue(createResponseSpecification(singleCorrect()));
    expect(incorrectOptionIdsOf(spec)).toEqual(['a', 'c', 'd']);
  });
});

describe('MULTIPLE_CORRECT_MCQ', () => {
  function multi(
    overrides: Partial<Extract<CreateResponseSpecificationProps, { itemType: 'MULTIPLE_CORRECT_MCQ' }>> = {},
  ): CreateResponseSpecificationProps {
    return {
      itemType: 'MULTIPLE_CORRECT_MCQ',
      options: FOUR_OPTIONS,
      correctOptionIds: ['a', 'c'],
      ...overrides,
    };
  }

  it('constructs with several correct options', () => {
    expect(optionsOf(expectValue(createResponseSpecification(multi())))).toHaveLength(4);
  });

  it('rejects an empty correct set', () => {
    expect(expectError(createResponseSpecification(multi({ correctOptionIds: [] }))).code).toBe(
      'CORRECT_OPTIONS_REQUIRED',
    );
  });

  it('rejects the same option marked correct twice', () => {
    expect(expectError(createResponseSpecification(multi({ correctOptionIds: ['a', 'a'] }))).code).toBe(
      'CORRECT_OPTION_DUPLICATE',
    );
  });

  it('rejects a correct option the item does not have', () => {
    expect(expectError(createResponseSpecification(multi({ correctOptionIds: ['a', 'z'] }))).code).toBe(
      'CORRECT_OPTION_UNKNOWN',
    );
  });

  // Scores full marks for selecting everything, which teaches the opposite of
  // what it asks.
  it('rejects an item where every option is correct', () => {
    expect(
      expectError(createResponseSpecification(multi({ correctOptionIds: ['a', 'b', 'c', 'd'] }))).code,
    ).toBe('CORRECT_OPTIONS_EXHAUSTIVE');
  });

  it('reports the unselected options as distractors', () => {
    expect(incorrectOptionIdsOf(expectValue(createResponseSpecification(multi())))).toEqual(['b', 'd']);
  });

  it('rejects too few options', () => {
    const options = [option('a', 1)];
    expect(
      expectError(createResponseSpecification(multi({ options, correctOptionIds: ['a'] }))).code,
    ).toBe('OPTIONS_TOO_FEW');
  });
});

describe('MATCHING', () => {
  const LEFT = [member('l1', 1), member('l2', 2)];
  const RIGHT = [member('r1', 1), member('r2', 2)];

  function matching(
    overrides: Partial<Extract<CreateResponseSpecificationProps, { itemType: 'MATCHING' }>> = {},
  ): CreateResponseSpecificationProps {
    return {
      itemType: 'MATCHING',
      left: LEFT,
      right: RIGHT,
      pairs: [
        { left: 'l1', right: 'r2' },
        { left: 'l2', right: 'r1' },
      ],
      ...overrides,
    };
  }

  it('constructs with members on both sides and a pairing', () => {
    const spec = expectValue(createResponseSpecification(matching()));
    expect(spec.itemType).toBe('MATCHING');
  });

  it(`rejects fewer than ${MINIMUM_MATCHING_MEMBERS} left members`, () => {
    expect(expectError(createResponseSpecification(matching({ left: [member('l1', 1)] }))).code).toBe(
      'MATCHING_MEMBERS_TOO_FEW',
    );
  });

  it(`rejects fewer than ${MINIMUM_MATCHING_MEMBERS} right members`, () => {
    const failure = expectError(createResponseSpecification(matching({ right: [member('r1', 1)] })));
    expect(failure.code).toBe('MATCHING_MEMBERS_TOO_FEW');
    expect(failure.location).toBe('responseSpec.right');
  });

  it('rejects a duplicate member id', () => {
    const left = [member('l1', 1), member('l1', 2)];
    expect(expectError(createResponseSpecification(matching({ left }))).code).toBe(
      'MATCHING_MEMBER_ID_DUPLICATE',
    );
  });

  it('rejects a member ordinal gap', () => {
    const left = [member('l1', 1), member('l2', 3)];
    expect(expectError(createResponseSpecification(matching({ left }))).code).toBe(
      'MATCHING_MEMBER_ORDINAL_GAP',
    );
  });

  it('rejects an empty pairing', () => {
    expect(expectError(createResponseSpecification(matching({ pairs: [] }))).code).toBe(
      'MATCHING_PAIRS_REQUIRED',
    );
  });

  it('rejects a pair naming an unknown left member', () => {
    const pairs = [{ left: 'nope', right: 'r1' }];
    expect(expectError(createResponseSpecification(matching({ pairs }))).code).toBe(
      'MATCHING_PAIR_MEMBER_UNKNOWN',
    );
  });

  it('rejects a pair naming an unknown right member', () => {
    const pairs = [{ left: 'l1', right: 'nope' }];
    expect(expectError(createResponseSpecification(matching({ pairs }))).code).toBe(
      'MATCHING_PAIR_MEMBER_UNKNOWN',
    );
  });

  it('rejects a left member matched twice', () => {
    const pairs = [
      { left: 'l1', right: 'r1' },
      { left: 'l1', right: 'r2' },
    ];
    const failure = expectError(createResponseSpecification(matching({ pairs })));
    expect(failure.code).toBe('MATCHING_PAIR_LEFT_DUPLICATE');
    expect(failure.location).toBe('responseSpec.pairs[1]');
  });

  it('permits a right member matched twice, which is a legitimate item shape', () => {
    const pairs = [
      { left: 'l1', right: 'r1' },
      { left: 'l2', right: 'r1' },
    ];
    expect(expectValue(createResponseSpecification(matching({ pairs }))).itemType).toBe('MATCHING');
  });

  it('has no distractor options', () => {
    expect(incorrectOptionIdsOf(expectValue(createResponseSpecification(matching())))).toEqual([]);
    expect(optionsOf(expectValue(createResponseSpecification(matching())))).toEqual([]);
  });
});

describe('NUMERIC', () => {
  it('constructs with a specification', () => {
    const spec = expectValue(
      createResponseSpecification({ itemType: 'NUMERIC', spec: NUMERIC_SPEC }),
    );
    expect(spec.itemType).toBe('NUMERIC');
  });

  it('rejects a missing specification', () => {
    const rogue = { itemType: 'NUMERIC' } as unknown as CreateResponseSpecificationProps;
    expect(expectError(createResponseSpecification(rogue)).code).toBe('NUMERIC_SPEC_REQUIRED');
  });

  // ADR-0007 and D-001 rule 4 both rest on the authored literal surviving.
  // Parsing it into a double here would lose the exactness the whole scoring
  // pipeline exists to preserve.
  it('carries expected value and bounds as decimal strings, never numbers', () => {
    expect(MODULE_SOURCE).toMatch(/readonly expectedValue: string;/u);
    expect(MODULE_SOURCE).not.toMatch(/readonly (expectedValue|rangeMin|rangeMax|toleranceValue)\??: number;/u);
  });

  it('preserves the authored literal exactly', () => {
    const spec = expectValue(
      createResponseSpecification({
        itemType: 'NUMERIC',
        spec: { ...NUMERIC_SPEC, expectedValue: '0.1000' },
      }),
    );
    expect(spec.itemType === 'NUMERIC' ? spec.spec.expectedValue : null).toBe('0.1000');
  });

  it('carries a unit and its accepted equivalents', () => {
    const spec = expectValue(
      createResponseSpecification({
        itemType: 'NUMERIC',
        spec: {
          ...NUMERIC_SPEC,
          unit: { canonical: 'm/s', acceptedEquivalents: ['ms^-1'], required: true },
        },
      }),
    );
    expect(spec.itemType === 'NUMERIC' ? spec.spec.unit?.canonical : null).toBe('m/s');
  });

  it('has no distractor options', () => {
    const spec = expectValue(createResponseSpecification({ itemType: 'NUMERIC', spec: NUMERIC_SPEC }));
    expect(incorrectOptionIdsOf(spec)).toEqual([]);
    expect(optionsOf(spec)).toEqual([]);
  });
});

describe('immutability', () => {
  it('freezes a single-correct specification and its options', () => {
    const spec = expectValue(createResponseSpecification(singleCorrect()));
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(optionsOf(spec))).toBe(true);
    expect(Object.isFrozen(optionsOf(spec)[0])).toBe(true);
  });

  it('freezes a multi-correct key set', () => {
    const spec = expectValue(
      createResponseSpecification({
        itemType: 'MULTIPLE_CORRECT_MCQ',
        options: FOUR_OPTIONS,
        correctOptionIds: ['a'],
      }),
    );
    expect(Object.isFrozen(spec.itemType === 'MULTIPLE_CORRECT_MCQ' ? spec.correctOptionIds : null)).toBe(true);
  });

  it('freezes matching members and pairs', () => {
    const spec = expectValue(
      createResponseSpecification({
        itemType: 'MATCHING',
        left: [member('l1', 1), member('l2', 2)],
        right: [member('r1', 1), member('r2', 2)],
        pairs: [{ left: 'l1', right: 'r1' }],
      }),
    );
    if (spec.itemType !== 'MATCHING') throw new Error('unreachable');
    expect(Object.isFrozen(spec.left)).toBe(true);
    expect(Object.isFrozen(spec.left[0])).toBe(true);
    expect(Object.isFrozen(spec.pairs[0])).toBe(true);
  });

  it('freezes a numeric spec, its accepted forms and its unit equivalents', () => {
    const spec = expectValue(
      createResponseSpecification({
        itemType: 'NUMERIC',
        spec: { ...NUMERIC_SPEC, unit: { canonical: 'm', acceptedEquivalents: ['metre'], required: false } },
      }),
    );
    if (spec.itemType !== 'NUMERIC') throw new Error('unreachable');
    expect(Object.isFrozen(spec.spec)).toBe(true);
    expect(Object.isFrozen(spec.spec.acceptedForms)).toBe(true);
    expect(Object.isFrozen(spec.spec.unit?.acceptedEquivalents)).toBe(true);
  });

  it('does not alias the caller’s option array', () => {
    const options = [...FOUR_OPTIONS];
    const spec = expectValue(createResponseSpecification(singleCorrect({ options })));
    options.push(option('e', 5));
    expect(optionsOf(spec)).toHaveLength(4);
  });
});
