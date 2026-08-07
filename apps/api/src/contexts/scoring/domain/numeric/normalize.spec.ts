import { describe, expect, it } from 'vitest';
import { DEFAULT_NORMALIZATION, type NormalizationFlags } from '../answer-key.js';
import { normalizeNumericEntry } from './normalize.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const ALL_ON = DEFAULT_NORMALIZATION;
const ALL_OFF: NormalizationFlags = Object.freeze({
  trimWhitespace: false,
  stripThousandsSeparator: false,
  unicodeMinusToAscii: false,
  caseInsensitiveUnit: false,
});

function flags(overrides: Partial<NormalizationFlags> = {}): NormalizationFlags {
  return { ...ALL_OFF, ...overrides };
}

function normalized(raw: string, f: NormalizationFlags = ALL_ON): { value: string; unit: string } {
  const result = expectValue(normalizeNumericEntry(raw, f));
  return { value: result.value, unit: result.unit };
}

describe('splitting the value from the unit', () => {
  it('reads a bare integer', () => {
    expect(normalized('42')).toEqual({ value: '42', unit: '' });
  });

  it('reads a decimal', () => {
    expect(normalized('9.81')).toEqual({ value: '9.81', unit: '' });
  });

  it('reads a leading-point decimal', () => {
    expect(normalized('.5')).toEqual({ value: '.5', unit: '' });
  });

  it('reads a trailing-point decimal', () => {
    expect(normalized('5.')).toEqual({ value: '5.', unit: '' });
  });

  it('stops at a second decimal point', () => {
    expect(normalized('1.2.3')).toEqual({ value: '1.2', unit: '.3' });
  });

  it('reads a positive sign', () => {
    expect(normalized('+7')).toEqual({ value: '+7', unit: '' });
  });

  it('reads a negative sign', () => {
    expect(normalized('-7')).toEqual({ value: '-7', unit: '' });
  });

  it('separates a simple unit', () => {
    expect(normalized('5 m')).toEqual({ value: '5', unit: 'm' });
  });

  it('separates a compound unit', () => {
    expect(normalized('9.81 m/s^2')).toEqual({ value: '9.81', unit: 'm/s^2' });
  });

  it('separates a unit written without a space', () => {
    expect(normalized('50kg')).toEqual({ value: '50', unit: 'kg' });
  });

  it('reads a fraction', () => {
    expect(normalized('2/3')).toEqual({ value: '2/3', unit: '' });
  });

  it('reads a spaced fraction', () => {
    expect(normalized('2 / 3')).toEqual({ value: '2 / 3', unit: '' });
  });

  it('reads a negative fraction denominator', () => {
    expect(normalized('2/-3')).toEqual({ value: '2/-3', unit: '' });
  });

  it('reads a fraction carrying a unit', () => {
    expect(normalized('3/4 m')).toEqual({ value: '3/4', unit: 'm' });
  });

  it('leaves a bare slash with the unit when no denominator follows', () => {
    expect(normalized('2/x')).toEqual({ value: '2', unit: '/x' });
  });

  it('reads a lowercase scientific exponent', () => {
    expect(normalized('1.5e3')).toEqual({ value: '1.5e3', unit: '' });
  });

  it('reads an uppercase scientific exponent', () => {
    expect(normalized('1.5E3')).toEqual({ value: '1.5E3', unit: '' });
  });

  it('reads a signed exponent', () => {
    expect(normalized('1.5e-3')).toEqual({ value: '1.5e-3', unit: '' });
  });

  it('leaves a dangling exponent marker with the unit', () => {
    expect(normalized('1.5e')).toEqual({ value: '1.5', unit: 'e' });
  });

  it('reads the ×10^ exponent form', () => {
    expect(normalized('1.5×10^3')).toEqual({ value: '1.5×10^3', unit: '' });
  });

  it('reads the x10^ and *10^ exponent forms', () => {
    expect(normalized('1.5x10^3')).toEqual({ value: '1.5x10^3', unit: '' });
    expect(normalized('1.5*10^3')).toEqual({ value: '1.5*10^3', unit: '' });
  });

  it('reads a spaced ×10^ exponent', () => {
    expect(normalized('1.5 × 10 ^ 3')).toEqual({ value: '1.5 × 10 ^ 3', unit: '' });
  });

  it('leaves ×10 without a caret to the unit', () => {
    expect(normalized('1.5×10')).toEqual({ value: '1.5', unit: '×10' });
  });

  it('leaves ×5 to the unit — only ten is a base', () => {
    expect(normalized('1.5×5')).toEqual({ value: '1.5', unit: '×5' });
  });

  it('leaves ×10^ with no exponent digits to the unit', () => {
    expect(normalized('1.5×10^')).toEqual({ value: '1.5', unit: '×10^' });
  });

  it('keeps a unit beginning with e separate from an exponent', () => {
    expect(normalized('5 eV')).toEqual({ value: '5', unit: 'ev' });
  });
});

describe('the four flags, each honoured independently', () => {
  it('trims surrounding whitespace only when the flag is on', () => {
    expect(normalized('  42  ', flags({ trimWhitespace: true }))).toEqual({ value: '42', unit: '' });
    // With the flag off, surrounding whitespace is not forgiven: the entry is
    // unreadable rather than silently accepted, so the slot falls through to
    // the terminal rule and awards 0 rather than being judged wrong.
    expect(expectError(normalizeNumericEntry('  42  ', flags())).code).toBe('NO_NUMERIC_VALUE');
  });

  it('recognises an exotic space as a space only when trimming', () => {
    // A non-breaking space used as a grouping separator is the case that
    // distinguishes the flag: folded, it groups; unfolded, it ends the number.
    expect(normalized('1\u00A0234', flags({ trimWhitespace: true, stripThousandsSeparator: true })).value).toBe(
      '1234',
    );
    expect(normalized('1\u00A0234', flags({ stripThousandsSeparator: true }))).toEqual({
      value: '1',
      unit: '234',
    });
  });

  it('folds every exotic space it recognises', () => {
    for (const space of ['\u00A0', '\u2000', '\u200A', '\u202F', '\u205F', '\u3000']) {
      expect(normalized(`${space}42${space}`, flags({ trimWhitespace: true })).value, space).toBe('42');
    }
  });

  it('strips grouping separators only when the flag is on', () => {
    expect(normalized('1,234.5', flags({ stripThousandsSeparator: true })).value).toBe('1234.5');
    expect(normalized('1,234.5', flags()).value).toBe('1,234.5');
  });

  it('strips a space used as a grouping separator only when the flag is on', () => {
    expect(normalized('1 234', flags({ stripThousandsSeparator: true })).value).toBe('1234');
    expect(normalized('1 234', flags()).value).toBe('1 234');
  });

  it('folds a Unicode minus to ASCII only when the flag is on', () => {
    expect(normalized('−7', flags({ unicodeMinusToAscii: true })).value).toBe('-7');
    expect(expectError(normalizeNumericEntry('−7', flags())).code).toBe('NO_NUMERIC_VALUE');
  });

  it('folds every dash form it recognises', () => {
    for (const dash of ['−', '‒', '–', '—', '―', '﹣', '－']) {
      expect(normalized(`${dash}7`, flags({ unicodeMinusToAscii: true })).value, dash).toBe('-7');
    }
  });

  it('case-folds the unit only when the flag is on', () => {
    expect(normalized('5 KG', flags({ caseInsensitiveUnit: true })).unit).toBe('kg');
    expect(normalized('5 KG', flags()).unit).toBe('KG');
  });

  it('leaves every flag off as a no-op on input that needs none', () => {
    expect(normalized('42kg', ALL_OFF)).toEqual({ value: '42', unit: 'kg' });
  });

  it('applies all four together', () => {
    expect(normalized('  −1,234.5 KG  ', ALL_ON)).toEqual({ value: '-1234.5', unit: 'kg' });
  });
});

describe('grouping separators are removed only between digits', () => {
  it('never removes a comma acting as a decimal point', () => {
    // `1,5` must not silently become `15` — a fifteen-fold error scored correct.
    expect(normalized('1,5 m', ALL_ON).value).toBe('1,5');
  });

  it('keeps a separator followed by more than three digits', () => {
    expect(normalized('1,2345', ALL_ON).value).toBe('1,2345');
  });

  it('leaves two-digit Indian grouping in place rather than guessing', () => {
    // `1,23,456` and a decimal comma are indistinguishable. Left alone the
    // entry fails to parse, so the slot awards 0 instead of scoring a value
    // the learner did not write (ADR-0003).
    expect(normalized('1,23,456', ALL_ON).value).toBe('1,23,456');
  });

  it('keeps a trailing comma with the unit', () => {
    expect(normalized('42, m', ALL_ON)).toEqual({ value: '42', unit: ', m' });
  });

  it('does not strip a leading comma', () => {
    expect(expectError(normalizeNumericEntry(',5', ALL_ON)).code).toBe('NO_NUMERIC_VALUE');
  });

  it('strips separators across several groups', () => {
    expect(normalized('1,234,567', ALL_ON).value).toBe('1234567');
  });
});

describe('rejection rather than a silent zero', () => {
  it('rejects an empty entry', () => {
    expect(expectError(normalizeNumericEntry('', ALL_ON)).code).toBe('ENTRY_EMPTY');
  });

  it('rejects a whitespace-only entry when trimming', () => {
    expect(expectError(normalizeNumericEntry('   ', ALL_ON)).code).toBe('ENTRY_EMPTY');
  });

  it('rejects a whitespace-only entry when not trimming', () => {
    expect(expectError(normalizeNumericEntry('   ', ALL_OFF)).code).toBe('ENTRY_EMPTY');
  });

  it('rejects an entry with no numeric value at all', () => {
    const error = expectError(normalizeNumericEntry('abc', ALL_ON));
    expect(error.code).toBe('NO_NUMERIC_VALUE');
    expect(error.kind).toBe('Validation');
  });

  it('names the original entry in the error, not a coerced form', () => {
    expect(expectError(normalizeNumericEntry('not a number', ALL_ON)).message).toContain('not a number');
  });

  it('returns a value rather than throwing on any input', () => {
    for (const raw of ['', ' ', 'abc', '.', '-', '+', ',', '/', 'e', '×10^']) {
      expect(() => normalizeNumericEntry(raw, ALL_ON)).not.toThrow();
    }
  });

  it('rejects a lone decimal point', () => {
    expect(expectError(normalizeNumericEntry('.', ALL_ON)).code).toBe('NO_NUMERIC_VALUE');
  });

  it('rejects a lone sign', () => {
    expect(expectError(normalizeNumericEntry('-', ALL_ON)).code).toBe('NO_NUMERIC_VALUE');
  });
});

describe('idempotence', () => {
  const samples = [
    '  −1,234.5 KG  ',
    '9.81 m/s^2',
    '1.5e-3',
    '2/3',
    '42',
    '1 234 567 J',
  ];

  for (const raw of samples) {
    it(`normalizing ${JSON.stringify(raw)} twice changes nothing`, () => {
      const once = normalized(raw, ALL_ON);
      const rejoined = once.unit.length > 0 ? `${once.value} ${once.unit}` : once.value;
      expect(normalized(rejoined, ALL_ON)).toEqual(once);
    });
  }
});

describe('immutability', () => {
  it('freezes the normalized entry', () => {
    expect(Object.isFrozen(expectValue(normalizeNumericEntry('42', ALL_ON)))).toBe(true);
  });
});
