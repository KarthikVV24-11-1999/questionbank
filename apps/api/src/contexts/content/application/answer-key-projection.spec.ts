import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  createAnswerKey,
  createScoringInput,
  isKnownItemType,
  KEY_KIND_BY_ITEM_TYPE,
} from '../../scoring/public/index.js';
import { createContentBody, type Block, type ContentBody } from '../domain/content-body.js';
import {
  createResponseSpecification,
  ITEM_TYPES,
  type CreateResponseSpecificationProps,
  type ItemOption,
  type MatchingMember,
  type NumericAnswerSpecData,
  type ResponseSpecification,
} from '../domain/response-specification.js';
import { isKeyAcceptedByExecutor, projectAnswerKey, toAnswerKeyData } from './answer-key-projection.js';

const CONTENT_ROOT = fileURLToPath(new URL('../', import.meta.url));

function body(value: string): ContentBody {
  const block: Block = { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value, marks: [] }] };
  return expectValue(createContentBody([block]));
}

function option(optionId: string, ordinal: number): ItemOption {
  return { optionId, ordinal, body: body(optionId) };
}

function member(memberId: string, ordinal: number): MatchingMember {
  return { memberId, ordinal, body: body(memberId) };
}

function spec(props: CreateResponseSpecificationProps): ResponseSpecification {
  return expectValue(createResponseSpecification(props));
}

const SINGLE = spec({
  itemType: 'SINGLE_CORRECT_MCQ',
  options: [option('a', 1), option('b', 2), option('c', 3), option('d', 4)],
  correctOptionId: 'b',
});

const MULTI = spec({
  itemType: 'MULTIPLE_CORRECT_MCQ',
  options: [option('a', 1), option('b', 2), option('c', 3), option('d', 4)],
  correctOptionIds: ['a', 'c'],
});

const MATCHING = spec({
  itemType: 'MATCHING',
  left: [member('l1', 1), member('l2', 2)],
  right: [member('r1', 1), member('r2', 2)],
  pairs: [
    { left: 'l1', right: 'r2' },
    { left: 'l2', right: 'r1' },
  ],
});

const NUMERIC_SPEC: NumericAnswerSpecData = {
  expectedValue: '9.81',
  comparisonMode: 'ABSOLUTE_TOLERANCE',
  toleranceValue: '0.01',
  unit: { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2'], required: true },
  acceptedForms: ['DECIMAL', 'SCIENTIFIC'],
};

const NUMERIC = spec({ itemType: 'NUMERIC', spec: NUMERIC_SPEC });

const ALL: readonly ResponseSpecification[] = [SINGLE, MULTI, MATCHING, NUMERIC];

describe('the item-type vocabularies agree across the seam', () => {
  // The ratified DEC-3 condition: this fails if either side drifts. Content
  // adding a type shows up as a missing key in scoring's map; scoring adding
  // one shows up as an extra key content does not model.
  it('content’s ITEM_TYPES is exactly scoring’s KEY_KIND_BY_ITEM_TYPE key set', () => {
    expect([...ITEM_TYPES].sort()).toEqual(Object.keys(KEY_KIND_BY_ITEM_TYPE).sort());
  });

  it('every content item type is one the executor recognises', () => {
    for (const itemType of ITEM_TYPES) {
      expect(isKnownItemType(itemType)).toBe(true);
    }
  });

  it('maps each content item type to the key variant the executor expects', () => {
    expect(KEY_KIND_BY_ITEM_TYPE).toMatchObject({
      SINGLE_CORRECT_MCQ: 'SINGLE_CORRECT',
      MULTIPLE_CORRECT_MCQ: 'MULTI_CORRECT',
      MATCHING: 'MATCHING',
      NUMERIC: 'NUMERIC',
    });
  });
});

describe('projection produces a key the executor accepts', () => {
  for (const specification of ALL) {
    it(`projects ${specification.itemType} into a key createAnswerKey accepts`, () => {
      const data = expectValue(projectAnswerKey(specification));
      expect(createAnswerKey(data).ok).toBe(true);
    });

    it(`projects ${specification.itemType} into a key createScoringInput pairs with its item type`, () => {
      const data = expectValue(projectAnswerKey(specification));
      const key = expectValue(createAnswerKey(data));
      const input = createScoringInput({
        attemptId: 'attempt-1',
        pin: {
          examProfileVersionId: 'profile-1',
          markingRuleSetHash: 'hash-1',
          ruleSchemaVersion: 1,
          taxonomyVersionId: 'taxonomy-1',
          itemVersionIds: ['version-1'],
        },
        sections: [
          {
            ordinal: 1,
            slots: [
              {
                slotId: 'slot-1',
                ordinal: 1,
                itemType: specification.itemType,
                itemVersionId: 'version-1',
                marksAvailable: 4,
                answerKey: key,
              },
            ],
          },
        ],
        overrides: [],
      });
      expect(input.ok).toBe(true);
    });
  }

  it('projects the single-correct key as the correct option', () => {
    expect(toAnswerKeyData(SINGLE)).toEqual({ kind: 'SINGLE_CORRECT', optionId: 'b' });
  });

  it('projects the multi-correct key as its correct set', () => {
    expect(toAnswerKeyData(MULTI)).toEqual({ kind: 'MULTI_CORRECT', correctOptionIds: ['a', 'c'] });
  });

  it('projects the matching key as its pairs, in authored order', () => {
    expect(toAnswerKeyData(MATCHING)).toEqual({
      kind: 'MATCHING',
      pairs: [
        { left: 'l1', right: 'r2' },
        { left: 'l2', right: 'r1' },
      ],
    });
  });

  it('projects the numeric key as its specification', () => {
    expect(toAnswerKeyData(NUMERIC)).toEqual({ kind: 'NUMERIC', spec: NUMERIC_SPEC });
  });
});

describe('the authored decimal literal survives unchanged', () => {
  // ADR-0007 and D-001 rule 4. Reading it through a double anywhere on this
  // path would discard exactly what the scoring pipeline exists to preserve,
  // and SIGNIFICANT_FIGURES counts figures in the literal itself.
  it.each([['0.1'], ['0.1000'], ['4'], ['4.0000'], ['-0.0000001'], ['1e-9']])(
    'carries %s across as text',
    (expectedValue) => {
      const numeric = spec({
        itemType: 'NUMERIC',
        spec: { ...NUMERIC_SPEC, expectedValue, comparisonMode: 'EXACT' },
      });
      const data = expectValue(projectAnswerKey(numeric));
      expect(data.kind === 'NUMERIC' ? data.spec?.expectedValue : null).toBe(expectedValue);
    },
  );

  it('distinguishes 0.1 from 0.1000, which a double could not', () => {
    const authored = ['0.1', '0.1000'].map((expectedValue) =>
      toAnswerKeyData(
        spec({ itemType: 'NUMERIC', spec: { ...NUMERIC_SPEC, expectedValue, comparisonMode: 'EXACT' } }),
      ),
    );
    expect(authored[0]).not.toEqual(authored[1]);
  });

  it('carries the unit, its equivalents and the accepted forms', () => {
    const data = expectValue(projectAnswerKey(NUMERIC));
    expect(data.kind === 'NUMERIC' ? data.spec?.unit : null).toEqual({
      canonical: 'm/s^2',
      acceptedEquivalents: ['m s^-2'],
      required: true,
    });
    expect(data.kind === 'NUMERIC' ? data.spec?.acceptedForms : null).toEqual(['DECIMAL', 'SCIENTIFIC']);
  });

  it('leaves normalization flags for the executor to default', () => {
    const data = expectValue(projectAnswerKey(NUMERIC));
    expect(data.kind === 'NUMERIC' ? data.spec?.normalization : 'set').toBeUndefined();
    const key = expectValue(createAnswerKey(data));
    expect(key.kind === 'NUMERIC' ? Object.keys(key.spec.normalization).length : 0).toBe(4);
  });
});

describe('a specification the executor would refuse cannot be projected', () => {
  // D-001 rule 5, enforced by scoring's own constructor rather than
  // re-implemented here — two validators for one rule is how the editor and
  // the executor come to disagree about what is publishable.
  it.each([
    ['ABSOLUTE_TOLERANCE with no toleranceValue', { comparisonMode: 'ABSOLUTE_TOLERANCE' } as const],
    ['RELATIVE_TOLERANCE with no toleranceValue', { comparisonMode: 'RELATIVE_TOLERANCE' } as const],
    ['SIGNIFICANT_FIGURES with no figure count', { comparisonMode: 'SIGNIFICANT_FIGURES' } as const],
    ['RANGE with no bounds', { comparisonMode: 'RANGE' } as const],
  ])('refuses %s', (_label, overrides) => {
    const incomplete = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '1', acceptedForms: ['DECIMAL'], ...overrides },
    });
    const failure = expectError(projectAnswerKey(incomplete));
    expect(failure.code).toBe('ANSWER_KEY_REJECTED_BY_EXECUTOR');
  });

  it('refuses an inverted range', () => {
    const inverted = spec({
      itemType: 'NUMERIC',
      spec: {
        expectedValue: '5',
        comparisonMode: 'RANGE',
        rangeMin: '9',
        rangeMax: '1',
        acceptedForms: ['DECIMAL'],
      },
    });
    expect(expectError(projectAnswerKey(inverted)).code).toBe('ANSWER_KEY_REJECTED_BY_EXECUTOR');
  });

  it('names the executor’s own code in the failure, so the author sees why', () => {
    const incomplete = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '1', comparisonMode: 'RANGE', acceptedForms: ['DECIMAL'] },
    });
    expect(expectError(projectAnswerKey(incomplete)).message).toContain('RANGE_BOUNDS_REQUIRED');
  });

  // The drift gate, exercised the way M2 exercises its fitness checks: by
  // planting the violation. This is what a content item type that scoring
  // cannot score would do — caught at authoring, not when a candidate is
  // scored.
  it('refuses an item type the executor does not know', () => {
    const drifted = { itemType: 'ASSERTION_REASON' } as unknown as ResponseSpecification;
    const failure = expectError(projectAnswerKey(drifted));
    expect(failure.code).toBe('ITEM_TYPE_NOT_SCORABLE');
    expect(failure.message).toContain('ASSERTION_REASON');
  });

  it('reports a drifted item type through isKeyAcceptedByExecutor too', () => {
    const drifted = { itemType: 'ASSERTION_REASON' } as unknown as ResponseSpecification;
    expect(isKeyAcceptedByExecutor(drifted)).toBe(false);
  });

  it('reports the location it was given', () => {
    const incomplete = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '1', comparisonMode: 'RANGE', acceptedForms: ['DECIMAL'] },
    });
    expect(expectError(projectAnswerKey(incomplete, 'versions[2].responseSpec')).location).toBe(
      'versions[2].responseSpec',
    );
  });
});

describe('isKeyAcceptedByExecutor', () => {
  it.each(ALL.map((specification) => [specification.itemType, specification] as const))(
    'accepts a well-formed %s',
    (_label, specification) => {
      expect(isKeyAcceptedByExecutor(specification)).toBe(true);
    },
  );

  it('refuses a numeric specification missing its mode parameter', () => {
    const incomplete = spec({
      itemType: 'NUMERIC',
      spec: { expectedValue: '1', comparisonMode: 'ABSOLUTE_TOLERANCE', acceptedForms: ['DECIMAL'] },
    });
    expect(isKeyAcceptedByExecutor(incomplete)).toBe(false);
  });
});

describe('the projection is one-way', () => {
  // A reverse function could only invent the presentation the key does not
  // carry — option bodies, ordinals, matching member text.
  it('exposes no function reconstructing a specification from a key', () => {
    const sources = readdirSync(join(CONTENT_ROOT, 'application'))
      .filter((entry) => entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      .map((entry) => readFileSync(join(CONTENT_ROOT, 'application', entry), 'utf8'));

    for (const source of sources) {
      expect(source).not.toMatch(/function\s+(from|to)?ResponseSpecification|fromAnswerKey/u);
    }
  });
});

describe('the content context reaches scoring only through its barrel', () => {
  it('imports nothing from scoring outside public/', () => {
    function tsFiles(directory: string): string[] {
      return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return tsFiles(path);
        return path.endsWith('.ts') ? [path] : [];
      });
    }

    const offenders = tsFiles(CONTENT_ROOT).filter((file) =>
      /from\s+'[^']*scoring\/(?!public\/)/u.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });
});
