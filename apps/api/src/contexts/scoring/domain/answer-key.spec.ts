import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { NumericAnswerSpecData as BarrelNumericAnswerSpecData } from '../../curriculum/public/index.js';
import {
  ANSWER_FORMS,
  checkKeyMatchesItemType,
  COMPARISON_MODES,
  createAnswerKey,
  DEFAULT_NORMALIZATION,
  isKnownItemType,
  KEY_KIND_BY_ITEM_TYPE,
  type ComparisonMode,
  type NumericAnswerSpecData,
} from './answer-key.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const CONTEXTS_DIR = fileURLToPath(new URL('../../', import.meta.url));
const OPENAPI_DIR = fileURLToPath(new URL('../../../../../../packages/contracts/openapi/', import.meta.url));

type SpecOverrides = { [K in keyof NumericAnswerSpecData]?: NumericAnswerSpecData[K] | undefined };

/**
 * `exactOptionalPropertyTypes` distinguishes an absent key from one set to
 * `undefined`; a test that wants to drop a mode's parameter means the former,
 * so undefined overrides delete rather than assign.
 */
function numericSpec(overrides: SpecOverrides = {}): NumericAnswerSpecData {
  const merged: Record<string, unknown> = {
    expectedValue: '9.81',
    comparisonMode: 'ABSOLUTE_TOLERANCE',
    toleranceValue: '0.01',
    acceptedForms: ['DECIMAL'],
    ...overrides,
  };
  for (const key of Object.keys(merged)) {
    if (merged[key] === undefined) delete merged[key];
  }
  return merged as unknown as NumericAnswerSpecData;
}

describe('SINGLE_CORRECT keys', () => {
  it('constructs', () => {
    const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
    expect(key).toEqual({ kind: 'SINGLE_CORRECT', optionId: 'B' });
  });

  it('rejects a blank optionId', () => {
    expect(expectError(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: ' ' })).code).toBe(
      'OPTION_ID_REQUIRED',
    );
  });

  it('rejects an absent optionId', () => {
    expect(expectError(createAnswerKey({ kind: 'SINGLE_CORRECT' })).code).toBe('OPTION_ID_REQUIRED');
  });
});

describe('MULTI_CORRECT keys', () => {
  it('constructs', () => {
    const key = expectValue(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: ['A', 'C'] }));
    expect(key).toEqual({ kind: 'MULTI_CORRECT', correctOptionIds: ['A', 'C'] });
  });

  it('rejects an empty correct-option set', () => {
    expect(expectError(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: [] })).code).toBe(
      'CORRECT_OPTIONS_REQUIRED',
    );
  });

  it('rejects an absent correct-option set', () => {
    expect(expectError(createAnswerKey({ kind: 'MULTI_CORRECT' })).code).toBe('CORRECT_OPTIONS_REQUIRED');
  });

  it('rejects a blank option', () => {
    expect(expectError(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: ['A', ' '] })).code).toBe(
      'CORRECT_OPTION_BLANK',
    );
  });

  it('rejects a duplicated option', () => {
    const error = expectError(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: ['A', 'A'] }));
    expect(error.code).toBe('CORRECT_OPTION_DUPLICATE');
    expect(error.message).toContain('A');
  });
});

describe('MATCHING keys', () => {
  const pairs = [
    { left: 'P', right: 'ii' },
    { left: 'Q', right: 'iv' },
  ];

  it('constructs', () => {
    expect(expectValue(createAnswerKey({ kind: 'MATCHING', pairs }))).toEqual({ kind: 'MATCHING', pairs });
  });

  it('rejects an empty pair set', () => {
    expect(expectError(createAnswerKey({ kind: 'MATCHING', pairs: [] })).code).toBe('PAIRS_REQUIRED');
  });

  it('rejects an absent pair set', () => {
    expect(expectError(createAnswerKey({ kind: 'MATCHING' })).code).toBe('PAIRS_REQUIRED');
  });

  it('rejects a blank left member', () => {
    expect(expectError(createAnswerKey({ kind: 'MATCHING', pairs: [{ left: ' ', right: 'ii' }] })).code).toBe(
      'PAIR_MEMBER_BLANK',
    );
  });

  it('rejects a blank right member', () => {
    expect(expectError(createAnswerKey({ kind: 'MATCHING', pairs: [{ left: 'P', right: '' }] })).code).toBe(
      'PAIR_MEMBER_BLANK',
    );
  });

  it('rejects a duplicated left member — one prompt cannot match twice', () => {
    const duplicated = [
      { left: 'P', right: 'ii' },
      { left: 'P', right: 'iv' },
    ];
    const error = expectError(createAnswerKey({ kind: 'MATCHING', pairs: duplicated }));
    expect(error.code).toBe('PAIR_LEFT_DUPLICATE');
    expect(error.message).toContain('P');
  });

  it('permits a repeated right member — two prompts may share an answer', () => {
    const shared = [
      { left: 'P', right: 'ii' },
      { left: 'Q', right: 'ii' },
    ];
    expect(expectValue(createAnswerKey({ kind: 'MATCHING', pairs: shared })).kind).toBe('MATCHING');
  });
});

describe('NUMERIC keys', () => {
  it('constructs from a specification', () => {
    const key = expectValue(createAnswerKey({ kind: 'NUMERIC', spec: numericSpec() }));
    expect(key.kind === 'NUMERIC' ? key.spec.expectedValue : null).toBe('9.81');
  });

  it('rejects an absent specification', () => {
    expect(expectError(createAnswerKey({ kind: 'NUMERIC' })).code).toBe('EXPECTED_VALUE_REQUIRED');
  });

  it('rejects a blank expectedValue', () => {
    expect(
      expectError(createAnswerKey({ kind: 'NUMERIC', spec: numericSpec({ expectedValue: ' ' }) })).code,
    ).toBe('EXPECTED_VALUE_REQUIRED');
  });

  it('rejects an unknown comparison mode', () => {
    const spec = numericSpec({ comparisonMode: 'VIBES' as never });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('COMPARISON_MODE_UNKNOWN');
  });

  it('preserves the expected value as the authored literal, not a float', () => {
    const key = expectValue(
      createAnswerKey({ kind: 'NUMERIC', spec: numericSpec({ expectedValue: '0.10' }) }),
    );
    expect(key.kind === 'NUMERIC' ? key.spec.expectedValue : null).toBe('0.10');
  });

  it('constructs in every comparison mode', () => {
    const byMode: Record<ComparisonMode, NumericAnswerSpecData> = {
      EXACT: numericSpec({ comparisonMode: 'EXACT', toleranceValue: undefined }),
      ABSOLUTE_TOLERANCE: numericSpec({ comparisonMode: 'ABSOLUTE_TOLERANCE', toleranceValue: '0.01' }),
      RELATIVE_TOLERANCE: numericSpec({ comparisonMode: 'RELATIVE_TOLERANCE', toleranceValue: '0.02' }),
      SIGNIFICANT_FIGURES: numericSpec({
        comparisonMode: 'SIGNIFICANT_FIGURES',
        toleranceValue: undefined,
        significantFigures: 3,
      }),
      RANGE: numericSpec({
        comparisonMode: 'RANGE',
        toleranceValue: undefined,
        rangeMin: '9.7',
        rangeMax: '9.9',
      }),
    };
    for (const mode of COMPARISON_MODES) {
      expect(expectValue(createAnswerKey({ kind: 'NUMERIC', spec: byMode[mode] })).kind, mode).toBe('NUMERIC');
    }
  });

  it('rejects each mode missing its required parameter (D-001 rule 5)', () => {
    const cases = [
      ['ABSOLUTE_TOLERANCE', 'TOLERANCE_VALUE_REQUIRED', numericSpec({ comparisonMode: 'ABSOLUTE_TOLERANCE', toleranceValue: undefined })],
      ['RELATIVE_TOLERANCE', 'TOLERANCE_VALUE_REQUIRED', numericSpec({ comparisonMode: 'RELATIVE_TOLERANCE', toleranceValue: undefined })],
      ['SIGNIFICANT_FIGURES', 'SIGNIFICANT_FIGURES_REQUIRED', numericSpec({ comparisonMode: 'SIGNIFICANT_FIGURES', toleranceValue: undefined })],
      ['RANGE', 'RANGE_BOUNDS_REQUIRED', numericSpec({ comparisonMode: 'RANGE', toleranceValue: undefined })],
    ] as const;
    for (const [mode, code, spec] of cases) {
      expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code, mode).toBe(code);
    }
  });

  it('rejects a blank tolerance value', () => {
    const spec = numericSpec({ toleranceValue: ' ' });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('TOLERANCE_VALUE_REQUIRED');
  });

  it('rejects a non-integer significantFigures', () => {
    const spec = numericSpec({ comparisonMode: 'SIGNIFICANT_FIGURES', toleranceValue: undefined, significantFigures: 2.5 });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('SIGNIFICANT_FIGURES_REQUIRED');
  });

  it('rejects significantFigures below 1', () => {
    const spec = numericSpec({ comparisonMode: 'SIGNIFICANT_FIGURES', toleranceValue: undefined, significantFigures: 0 });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('SIGNIFICANT_FIGURES_REQUIRED');
  });

  it('rejects a blank range bound', () => {
    const spec = numericSpec({ comparisonMode: 'RANGE', toleranceValue: undefined, rangeMin: ' ', rangeMax: '9.9' });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('RANGE_BOUNDS_REQUIRED');
  });

  it('rejects an inverted range', () => {
    const spec = numericSpec({ comparisonMode: 'RANGE', toleranceValue: undefined, rangeMin: '9.9', rangeMax: '9.7' });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('RANGE_BOUNDS_INVERTED');
  });

  it('accepts a range whose bounds are equal', () => {
    const spec = numericSpec({ comparisonMode: 'RANGE', toleranceValue: undefined, rangeMin: '9.8', rangeMax: '9.8' });
    expect(expectValue(createAnswerKey({ kind: 'NUMERIC', spec })).kind).toBe('NUMERIC');
  });

  it('rejects an empty acceptedForms', () => {
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec: numericSpec({ acceptedForms: [] }) })).code).toBe(
      'ACCEPTED_FORMS_REQUIRED',
    );
  });

  it('rejects an unknown accepted form', () => {
    const spec = numericSpec({ acceptedForms: ['ROMAN' as never] });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('ACCEPTED_FORM_UNKNOWN');
  });

  it('accepts every declared answer form', () => {
    const spec = numericSpec({ acceptedForms: [...ANSWER_FORMS] });
    expect(expectValue(createAnswerKey({ kind: 'NUMERIC', spec })).kind).toBe('NUMERIC');
  });

  it('rejects a unit without a canonical form', () => {
    const spec = numericSpec({ unit: { canonical: ' ', acceptedEquivalents: [], required: true } });
    expect(expectError(createAnswerKey({ kind: 'NUMERIC', spec })).code).toBe('UNIT_CANONICAL_REQUIRED');
  });

  it('carries a valid unit through', () => {
    const unit = { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2'], required: true };
    const key = expectValue(createAnswerKey({ kind: 'NUMERIC', spec: numericSpec({ unit }) }));
    expect(key.kind === 'NUMERIC' ? key.spec.unit?.canonical : null).toBe('m/s^2');
  });

  it('resolves every normalization flag when none are authored', () => {
    const key = expectValue(createAnswerKey({ kind: 'NUMERIC', spec: numericSpec() }));
    expect(key.kind === 'NUMERIC' ? key.spec.normalization : null).toEqual(DEFAULT_NORMALIZATION);
  });

  it('lets an authored flag override its default', () => {
    const spec = numericSpec({ normalization: { caseInsensitiveUnit: false } });
    const key = expectValue(createAnswerKey({ kind: 'NUMERIC', spec }));
    expect(key.kind === 'NUMERIC' ? key.spec.normalization : null).toEqual({
      ...DEFAULT_NORMALIZATION,
      caseInsensitiveUnit: false,
    });
  });

  it('freezes the resolved specification and its arrays', () => {
    const unit = { canonical: 'J', acceptedEquivalents: ['joule'], required: false };
    const key = expectValue(createAnswerKey({ kind: 'NUMERIC', spec: numericSpec({ unit }) }));
    const spec = key.kind === 'NUMERIC' ? key.spec : null;
    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec?.acceptedForms)).toBe(true);
    expect(Object.isFrozen(spec?.normalization)).toBe(true);
    expect(Object.isFrozen(spec?.unit)).toBe(true);
    expect(Object.isFrozen(spec?.unit?.acceptedEquivalents)).toBe(true);
  });
});

describe('the curriculum barrel DTO', () => {
  it('remains assignable to the shape this context declares', () => {
    // `domain/` imports nothing, so the numeric shape is mirrored rather than
    // imported. If M1's DTO changes, this stops compiling — which is the point.
    const fromBarrel: BarrelNumericAnswerSpecData = {
      expectedValue: '9.81',
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      toleranceValue: '0.01',
      acceptedForms: ['DECIMAL'],
    };
    const asScoring: NumericAnswerSpecData = fromBarrel;
    expect(expectValue(createAnswerKey({ kind: 'NUMERIC', spec: asScoring })).kind).toBe('NUMERIC');
  });

  it('declares the same five comparison modes and three answer forms', () => {
    expect([...COMPARISON_MODES]).toEqual([
      'EXACT',
      'ABSOLUTE_TOLERANCE',
      'RELATIVE_TOLERANCE',
      'SIGNIFICANT_FIGURES',
      'RANGE',
    ]);
    expect([...ANSWER_FORMS]).toEqual(['DECIMAL', 'FRACTION', 'SCIENTIFIC']);
  });
});

describe('key variant against item type', () => {
  it('accepts each item type paired with its own variant', () => {
    const keyByKind = {
      SINGLE_CORRECT: expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' })),
      MULTI_CORRECT: expectValue(createAnswerKey({ kind: 'MULTI_CORRECT', correctOptionIds: ['A'] })),
      MATCHING: expectValue(createAnswerKey({ kind: 'MATCHING', pairs: [{ left: 'P', right: 'i' }] })),
      NUMERIC: expectValue(createAnswerKey({ kind: 'NUMERIC', spec: numericSpec() })),
    };
    for (const [itemType, expectedKind] of Object.entries(KEY_KIND_BY_ITEM_TYPE)) {
      expect(expectValue(checkKeyMatchesItemType(keyByKind[expectedKind], itemType))).toBe(true);
    }
  });

  it('rejects a variant that does not match the item type', () => {
    const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
    const error = expectError(checkKeyMatchesItemType(key, 'NUMERIC'));
    expect(error.code).toBe('KEY_VARIANT_MISMATCH');
    expect(error.message).toContain('NUMERIC');
  });

  it('refuses an item type it does not know rather than guessing', () => {
    const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
    const error = expectError(checkKeyMatchesItemType(key, 'ASSERTION_REASON'));
    expect(error.code).toBe('ITEM_TYPE_UNKNOWN');
  });

  it('recognises exactly the four item types it maps', () => {
    expect(Object.keys(KEY_KIND_BY_ITEM_TYPE).sort()).toEqual([
      'MATCHING',
      'MULTIPLE_CORRECT_MCQ',
      'NUMERIC',
      'SINGLE_CORRECT_MCQ',
    ]);
    expect(isKnownItemType('SINGLE_CORRECT_MCQ')).toBe(true);
    expect(isKnownItemType('constructor')).toBe(false);
  });
});

function filesUnder(directory: string, extensions: readonly string[]): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return filesUnder(path, extensions);
    return extensions.some((extension) => path.endsWith(extension)) ? [path] : [];
  });
}

/** Every client-facing surface: each context's `api/` layer plus the OpenAPI documents. */
function clientFacingFiles(): string[] {
  const dtoFiles = readdirSync(CONTEXTS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .flatMap((entry) => {
      const apiDirectory = join(CONTEXTS_DIR, entry.name, 'api');
      return statSync(apiDirectory, { throwIfNoEntry: false })?.isDirectory() === true
        ? filesUnder(apiDirectory, ['.ts'])
        : [];
    })
    .filter((file) => !file.endsWith('.spec.ts'));
  return [...dtoFiles, ...filesUnder(OPENAPI_DIR, ['.yaml', '.yml'])];
}

/**
 * **Amended by [ADR-0009](../../../../../docs/adr/ADR-0009-authoring-dtos-carry-the-answer-key.md).**
 *
 * M3's authoring surface is where an answer key is written, so the key must
 * reach the author's browser. The blanket rule cannot survive that, and the
 * dangerous way to handle it is to narrow the check until it passes. Instead
 * the exception is a single **enumerated** document, and the content contract
 * spec asserts the split in both directions over that document's own routes —
 * keys absent from every delivery schema and *present* on the authoring ones.
 *
 * Anything not on this list is still checked exactly as before.
 */
const AUTHORING_SURFACE_ADR_0009 = ['packages/contracts/openapi/content.yaml'];

function nonAuthoringClientFacingFiles(): string[] {
  return clientFacingFiles().filter(
    (file) => !AUTHORING_SURFACE_ADR_0009.some((allowed) => file.endsWith(allowed)),
  );
}

describe('answer keys never reach a client (§9 rule 10)', () => {
  /** Naming any of these in a client payload leaks the key outright. */
  const NEVER_CLIENT_FACING = ['answerKey', 'answer_key', 'correctOptionId', 'correctOptionIds'];

  /**
   * `expectedValue` is the exception that has to be named rather than dropped.
   * On an *item's* `NumericAnswerSpec` it is the answer. On the exam profile's
   * `toleranceDefault` it is a template placeholder and harmless — and M1 ships
   * exactly that, in the two files below.
   *
   * The hazard is that both are the same schema. Reusing `NumericAnswerSpec`
   * for an item key on a client-facing DTO would leak the answer under a name
   * that already looks approved, so every occurrence is pinned here: a new one
   * fails this test until someone justifies it. M2-27 must define scoring's
   * response schemas without it.
   */
  const EXPECTED_VALUE_ALLOWED = [
    'contexts/curriculum/api/dto/curriculum-schemas.ts',
    'packages/contracts/openapi/curriculum.yaml',
  ];

  it('scans a client-facing surface that actually exists', () => {
    expect(clientFacingFiles().length).toBeGreaterThan(0);
  });

  it('names no answer-key field in any DTO, controller or contract document', () => {
    const offenders = nonAuthoringClientFacingFiles().filter((file) => {
      const source = readFileSync(file, 'utf8');
      return NEVER_CLIENT_FACING.some((field) => source.includes(field));
    });
    expect(offenders).toEqual([]);
  });

  it('exposes expectedValue only as the exam profile tolerance default', () => {
    const offenders = nonAuthoringClientFacingFiles()
      .filter((file) => readFileSync(file, 'utf8').includes('expectedValue'))
      .filter((file) => !EXPECTED_VALUE_ALLOWED.some((allowed) => file.endsWith(allowed)))
      .map((file) => file.replace(/^.*\/(apps|packages)\//u, '$1/'));
    expect(offenders).toEqual([]);
  });

  // The exemption is one file, and it is the one ADR-0009 names. A second
  // entry would mean the amendment had become "keys allowed where needed",
  // which the ADR rejects explicitly.
  it('exempts exactly one document, the one ADR-0009 enumerates', () => {
    expect(AUTHORING_SURFACE_ADR_0009).toEqual(['packages/contracts/openapi/content.yaml']);
    expect(clientFacingFiles().length - nonAuthoringClientFacingFiles().length).toBe(1);
  });

  // And the exemption is not a hole: the exempted document does carry the key,
  // so the content contract spec's both-direction check has something to check.
  it('exempts a document that genuinely carries the key', () => {
    const exempted = clientFacingFiles().filter((file) =>
      AUTHORING_SURFACE_ADR_0009.some((allowed) => file.endsWith(allowed)),
    );
    expect(exempted).toHaveLength(1);
    expect(readFileSync(exempted[0]!, 'utf8')).toContain('correctOptionId');
  });
});
