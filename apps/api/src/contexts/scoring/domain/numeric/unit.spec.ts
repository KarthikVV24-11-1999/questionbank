import { describe, expect, it } from 'vitest';
import { DEFAULT_NORMALIZATION, type NumericAnswerSpecResolved, type UnitSpec } from '../answer-key.js';
import { compareNumeric } from './compare.js';
import { detectAnswerForm, isFormAccepted } from './answer-form.js';
import { checkUnit } from './unit.js';
import { expectValue } from '../../../../testing/expect-result.js';

function spec(unit?: UnitSpec, caseInsensitiveUnit = true): NumericAnswerSpecResolved {
  return {
    expectedValue: '9.81',
    comparisonMode: 'EXACT',
    acceptedForms: ['DECIMAL', 'FRACTION', 'SCIENTIFIC'],
    normalization: { ...DEFAULT_NORMALIZATION, caseInsensitiveUnit },
    ...(unit !== undefined ? { unit } : {}),
  };
}

const required: UnitSpec = { canonical: 'm/s^2', acceptedEquivalents: ['m s^-2', 'ms^-2'], required: true };
const optional: UnitSpec = { canonical: 'J', acceptedEquivalents: ['joule'], required: false };

describe('checkUnit', () => {
  it('ignores the unit when none is authored', () => {
    expect(checkUnit('kg', spec())).toBe('not_required');
  });

  it('ignores the unit when one is authored but not required (D-001 rule 3)', () => {
    expect(checkUnit('anything at all', spec(optional))).toBe('not_required');
    expect(checkUnit('', spec(optional))).toBe('not_required');
  });

  it('matches the canonical form', () => {
    expect(checkUnit('m/s^2', spec(required))).toBe('match');
  });

  it('matches each accepted equivalent', () => {
    expect(checkUnit('m s^-2', spec(required))).toBe('match');
    expect(checkUnit('ms^-2', spec(required))).toBe('match');
  });

  it('folds case when the flag is on', () => {
    expect(checkUnit('M/S^2', spec(required, true))).toBe('match');
  });

  it('does not fold case when the flag is off', () => {
    expect(checkUnit('M/S^2', spec(required, false))).toBe('mismatch');
    expect(checkUnit('m/s^2', spec(required, false))).toBe('match');
  });

  it('reports a wrong unit as a mismatch', () => {
    expect(checkUnit('kg', spec(required))).toBe('mismatch');
  });

  it('reports an omitted required unit as missing, never as a mismatch', () => {
    // The learner may have the right number. The engine cannot tell, so this
    // is indeterminate — and an indeterminate response must not cost a mark.
    expect(checkUnit('', spec(required))).toBe('missing');
    expect(checkUnit('   ', spec(required))).toBe('missing');
  });

  it('tolerates surrounding whitespace on a supplied unit', () => {
    expect(checkUnit('  m/s^2  ', spec(required))).toBe('match');
  });
});

describe('detectAnswerForm', () => {
  it('reads a plain decimal', () => {
    expect(detectAnswerForm('9.81')).toBe('DECIMAL');
    expect(detectAnswerForm('-42')).toBe('DECIMAL');
  });

  it('reads a fraction', () => {
    expect(detectAnswerForm('3/4')).toBe('FRACTION');
    expect(detectAnswerForm('-3/4')).toBe('FRACTION');
  });

  it('reads both scientific notations', () => {
    expect(detectAnswerForm('1.5e3')).toBe('SCIENTIFIC');
    expect(detectAnswerForm('1.5E-3')).toBe('SCIENTIFIC');
    expect(detectAnswerForm('1.5×10^3')).toBe('SCIENTIFIC');
    expect(detectAnswerForm('1.5 x 10 ^ 3')).toBe('SCIENTIFIC');
  });

  it('prefers FRACTION when both a slash and an exponent appear', () => {
    expect(detectAnswerForm('1.5e3/2')).toBe('FRACTION');
  });
});

describe('isFormAccepted', () => {
  it('accepts a listed form', () => {
    expect(isFormAccepted('DECIMAL', ['DECIMAL', 'SCIENTIFIC'])).toBe(true);
  });

  it('rejects an unlisted form rather than coercing it', () => {
    // `acceptedForms: [DECIMAL]` is a statement about what the item tests.
    expect(isFormAccepted('FRACTION', ['DECIMAL'])).toBe(false);
  });

  it('rejects every form against an empty list', () => {
    expect(isFormAccepted('DECIMAL', [])).toBe(false);
  });
});

describe('all three forms reduce to the same value', () => {
  const exact = spec();

  it('scores a decimal, a fraction and a scientific value identically', () => {
    const half = { ...exact, expectedValue: '0.5' };
    expect(expectValue(compareNumeric('0.5', half))).toBe(true);
    expect(expectValue(compareNumeric('1/2', half))).toBe(true);
    expect(expectValue(compareNumeric('5e-1', half))).toBe(true);
    expect(expectValue(compareNumeric('5×10^-1', half))).toBe(true);
  });

  it('handles a negative fraction', () => {
    const negative = { ...exact, expectedValue: '-0.75' };
    expect(expectValue(compareNumeric('-3/4', negative))).toBe(true);
  });

  it('reports a zero denominator rather than treating it as a mismatch', () => {
    const result = compareNumeric('1/0', exact);
    expect(result.ok).toBe(false);
  });
});
