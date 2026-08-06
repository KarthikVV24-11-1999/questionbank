import { describe, expect, it } from 'vitest';
import {
  COMPARISON_MODES,
  DEFAULT_NORMALIZATION,
  NumericAnswerSpec,
  type CreateNumericAnswerSpecProps,
} from './numeric-answer-spec.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const base: CreateNumericAnswerSpecProps = {
  expectedValue: '9.81',
  comparisonMode: 'EXACT',
  acceptedForms: ['DECIMAL'],
};

const validPerMode: Record<string, CreateNumericAnswerSpecProps> = {
  EXACT: base,
  ABSOLUTE_TOLERANCE: { ...base, comparisonMode: 'ABSOLUTE_TOLERANCE', toleranceValue: '0.01' },
  RELATIVE_TOLERANCE: { ...base, comparisonMode: 'RELATIVE_TOLERANCE', toleranceValue: '0.001' },
  SIGNIFICANT_FIGURES: { ...base, comparisonMode: 'SIGNIFICANT_FIGURES', significantFigures: 3 },
  RANGE: { ...base, comparisonMode: 'RANGE', rangeMin: '9.7', rangeMax: '9.9' },
};

describe('NumericAnswerSpec comparison modes', () => {
  it('represents all five modes', () => {
    expect([...COMPARISON_MODES]).toEqual([
      'EXACT',
      'ABSOLUTE_TOLERANCE',
      'RELATIVE_TOLERANCE',
      'SIGNIFICANT_FIGURES',
      'RANGE',
    ]);
  });

  it.each(COMPARISON_MODES)('constructs a valid %s spec', (mode) => {
    const spec = expectValue(NumericAnswerSpec.create(validPerMode[mode] as CreateNumericAnswerSpecProps));

    expect(spec.comparisonMode).toBe(mode);
    expect(spec.expectedValue).toBe('9.81');
  });

  it('preserves the authored decimal literal, including trailing zeros', () => {
    expect(expectValue(NumericAnswerSpec.create({ ...base, expectedValue: '9.800' })).expectedValue).toBe(
      '9.800',
    );
  });

  it.each(['', 'abc', '9.8.1', '1,000', ' '])('rejects expectedValue %j', (expectedValue) => {
    expect(expectError(NumericAnswerSpec.create({ ...base, expectedValue })).code).toBe(
      'EXPECTED_VALUE_INVALID',
    );
  });

  it.each(['-3', '0', '1e5', '2.5E-3'])('accepts expectedValue %j', (expectedValue) => {
    expect(expectValue(NumericAnswerSpec.create({ ...base, expectedValue })).expectedValue).toBe(expectedValue);
  });
});

describe('NumericAnswerSpec mode-required parameters', () => {
  it.each(['ABSOLUTE_TOLERANCE', 'RELATIVE_TOLERANCE'] as const)(
    'rejects %s without toleranceValue',
    (comparisonMode) => {
      const error = expectError(NumericAnswerSpec.create({ ...base, comparisonMode }));

      expect(error.code).toBe('TOLERANCE_VALUE_REQUIRED');
      expect(error.kind).toBe('Validation');
    },
  );

  it.each(['0', '-0.5', 'wide'])('rejects toleranceValue %j', (toleranceValue) => {
    expect(
      expectError(
        NumericAnswerSpec.create({ ...base, comparisonMode: 'ABSOLUTE_TOLERANCE', toleranceValue }),
      ).code,
    ).toBe('TOLERANCE_VALUE_INVALID');
  });

  it('rejects SIGNIFICANT_FIGURES without significantFigures', () => {
    expect(
      expectError(NumericAnswerSpec.create({ ...base, comparisonMode: 'SIGNIFICANT_FIGURES' })).code,
    ).toBe('SIGNIFICANT_FIGURES_REQUIRED');
  });

  it.each([0, -1, 2.5])('rejects significantFigures %s', (significantFigures) => {
    expect(
      expectError(
        NumericAnswerSpec.create({ ...base, comparisonMode: 'SIGNIFICANT_FIGURES', significantFigures }),
      ).code,
    ).toBe('SIGNIFICANT_FIGURES_INVALID');
  });

  it.each([
    ['both bounds', {}],
    ['only rangeMin', { rangeMin: '1' }],
    ['only rangeMax', { rangeMax: '2' }],
  ])('rejects RANGE missing %s', (_case, bounds) => {
    expect(
      expectError(NumericAnswerSpec.create({ ...base, comparisonMode: 'RANGE', ...bounds })).code,
    ).toBe('RANGE_BOUNDS_REQUIRED');
  });

  it('rejects rangeMin greater than rangeMax', () => {
    const error = expectError(
      NumericAnswerSpec.create({ ...base, comparisonMode: 'RANGE', rangeMin: '9.9', rangeMax: '9.7' }),
    );

    expect(error.code).toBe('RANGE_BOUNDS_INVERTED');
  });

  it('accepts rangeMin equal to rangeMax', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({ ...base, comparisonMode: 'RANGE', rangeMin: '9.8', rangeMax: '9.8' }),
    );

    expect([spec.rangeMin, spec.rangeMax]).toEqual(['9.8', '9.8']);
  });

  it('rejects a non-decimal range bound', () => {
    expect(
      expectError(
        NumericAnswerSpec.create({ ...base, comparisonMode: 'RANGE', rangeMin: 'low', rangeMax: '9.9' }),
      ).code,
    ).toBe('RANGE_BOUND_INVALID');
  });

  it.each([
    ['toleranceValue on EXACT', { toleranceValue: '0.1' }],
    ['significantFigures on EXACT', { significantFigures: 3 }],
    ['rangeMin on EXACT', { rangeMin: '1' }],
    ['significantFigures on ABSOLUTE_TOLERANCE', { comparisonMode: 'ABSOLUTE_TOLERANCE' as const, toleranceValue: '0.1', significantFigures: 2 }],
  ])('rejects %s as meaningless for the mode', (_case, overrides) => {
    expect(expectError(NumericAnswerSpec.create({ ...base, ...overrides })).code).toBe(
      'IRRELEVANT_PARAMETER',
    );
  });
});

describe('NumericAnswerSpec accepted forms', () => {
  it('rejects an empty set', () => {
    expect(expectError(NumericAnswerSpec.create({ ...base, acceptedForms: [] })).code).toBe(
      'ACCEPTED_FORMS_EMPTY',
    );
  });

  it('accepts any non-empty subset', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({ ...base, acceptedForms: ['SCIENTIFIC', 'DECIMAL'] }),
    );

    expect(spec.acceptedForms).toEqual(['DECIMAL', 'SCIENTIFIC']);
  });

  it('rejects a repeated form', () => {
    expect(
      expectError(NumericAnswerSpec.create({ ...base, acceptedForms: ['DECIMAL', 'DECIMAL'] })).code,
    ).toBe('ACCEPTED_FORMS_DUPLICATED');
  });

  it('rejects an unknown form', () => {
    expect(
      expectError(
        NumericAnswerSpec.create({
          ...base,
          acceptedForms: ['ROMAN'] as unknown as CreateNumericAnswerSpecProps['acceptedForms'],
        }),
      ).code,
    ).toBe('ACCEPTED_FORM_UNKNOWN');
  });
});

describe('NumericAnswerSpec unit', () => {
  it('carries canonical form, accepted equivalents and the required flag', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({
        ...base,
        unit: { canonical: 'm/s^2', acceptedEquivalents: [' ms^-2 ', 'm s^-2'], required: true },
      }),
    );

    expect(spec.unit?.canonical).toBe('m/s^2');
    expect(spec.unit?.acceptedEquivalents).toEqual(['ms^-2', 'm s^-2']);
    expect(spec.unit?.required).toBe(true);
  });

  it('is optional', () => {
    expect(expectValue(NumericAnswerSpec.create(base)).unit).toBeUndefined();
  });

  it('rejects an empty canonical form', () => {
    expect(
      expectError(
        NumericAnswerSpec.create({ ...base, unit: { canonical: ' ', acceptedEquivalents: [], required: false } }),
      ).code,
    ).toBe('UNIT_CANONICAL_REQUIRED');
  });
});

describe('NumericAnswerSpec normalization flags', () => {
  it('applies all four defaults when none are supplied', () => {
    expect(expectValue(NumericAnswerSpec.create(base)).normalization).toEqual(DEFAULT_NORMALIZATION);
    expect(Object.keys(DEFAULT_NORMALIZATION)).toEqual([
      'trimWhitespace',
      'stripThousandsSeparator',
      'unicodeMinusToAscii',
      'caseInsensitiveUnit',
    ]);
  });

  it('keeps every flag present when one is overridden', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({ ...base, normalization: { caseInsensitiveUnit: false } }),
    );

    expect(spec.normalization).toEqual({ ...DEFAULT_NORMALIZATION, caseInsensitiveUnit: false });
  });
});

describe('NumericAnswerSpec immutability', () => {
  it('freezes the spec, its unit, its forms and its flags', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({
        ...base,
        unit: { canonical: 'm', acceptedEquivalents: ['metre'], required: false },
      }),
    );

    expect(Object.isFrozen(spec)).toBe(true);
    expect(Object.isFrozen(spec.unit)).toBe(true);
    expect(Object.isFrozen(spec.acceptedForms)).toBe(true);
    expect(Object.isFrozen(spec.normalization)).toBe(true);
  });

  it('rejects reassignment of a field', () => {
    const spec = expectValue(NumericAnswerSpec.create(base));

    expect(() => {
      (spec as unknown as Record<string, unknown>)['expectedValue'] = '0';
    }).toThrow(TypeError);
  });

  it('does not share the caller’s arrays', () => {
    const acceptedForms: CreateNumericAnswerSpecProps['acceptedForms'] = ['DECIMAL'];
    const spec = expectValue(NumericAnswerSpec.create({ ...base, acceptedForms }));

    expect(() => (spec.acceptedForms as string[]).push('FRACTION')).toThrow(TypeError);
    expect(spec.acceptedForms).toEqual(['DECIMAL']);
  });
});
