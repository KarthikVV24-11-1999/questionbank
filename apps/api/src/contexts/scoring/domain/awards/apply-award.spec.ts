import { describe, expect, it } from 'vitest';
import { AWARD_KINDS, type Award } from '../marking-rule-data.js';
import { compareRational, isZero, makeRational, parseRational, type Rational } from '../numeric/decimal.js';
import { applyAward, type AwardContext } from './apply-award.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const context = (overrides: Partial<AwardContext> = {}): AwardContext => ({
  marksAvailable: 4,
  correctSelectionCount: 0,
  ...overrides,
});

function awarded(award: Award, ctx: AwardContext = context()): Rational {
  return expectValue(applyAward(award, ctx));
}

const equals = (value: Rational, text: string): boolean =>
  compareRational(value, expectValue(parseRational(text))) === 0;

describe('the closed set of three', () => {
  it('declares exactly the three awards the document names', () => {
    expect([...AWARD_KINDS]).toHaveLength(3);
  });

  it('applies every declared kind without throwing', () => {
    for (const kind of AWARD_KINDS) {
      const award = { kind, marks: 1 } as unknown as Award;
      expect(() => applyAward(award, context()), kind).not.toThrow();
    }
  });
});

describe('FIXED', () => {
  it('awards a positive value exactly', () => {
    expect(equals(awarded({ kind: 'FIXED', marks: 4 }), '4')).toBe(true);
  });

  it('awards a negative value exactly', () => {
    expect(equals(awarded({ kind: 'FIXED', marks: -1 }), '-1')).toBe(true);
  });

  it('awards zero', () => {
    expect(isZero(awarded({ kind: 'FIXED', marks: 0 }))).toBe(true);
  });

  it('awards a fractional value without floating-point drift', () => {
    expect(equals(awarded({ kind: 'FIXED', marks: 1.5 }), '3/2')).toBe(true);
    expect(equals(awarded({ kind: 'FIXED', marks: 0.1 }), '1/10')).toBe(true);
  });

  it('ignores the slot marks and the selection count', () => {
    const ctx = context({ marksAvailable: 99, correctSelectionCount: 7 });
    expect(equals(awarded({ kind: 'FIXED', marks: 4 }, ctx), '4')).toBe(true);
  });

  it('refuses a non-finite mark value rather than awarding one', () => {
    expect(expectError(applyAward({ kind: 'FIXED', marks: Number.NaN }, context())).code).toBe(
      'AWARD_MARKS_INVALID',
    );
    expect(expectError(applyAward({ kind: 'FIXED', marks: Number.POSITIVE_INFINITY }, context())).code).toBe(
      'AWARD_MARKS_INVALID',
    );
  });
});

describe('PER_CORRECT', () => {
  it('awards nothing for zero correct selections', () => {
    expect(isZero(awarded({ kind: 'PER_CORRECT', marks: 2 }, context({ correctSelectionCount: 0 })))).toBe(true);
  });

  it('awards nothing for zero correct selections even when the marks are negative', () => {
    const value = awarded({ kind: 'PER_CORRECT', marks: -2 }, context({ correctSelectionCount: 0 }));
    expect(isZero(value)).toBe(true);
  });

  it('awards the marks once for a single correct selection', () => {
    expect(equals(awarded({ kind: 'PER_CORRECT', marks: 2 }, context({ correctSelectionCount: 1 })), '2')).toBe(
      true,
    );
  });

  it('multiplies by the number of correct selections', () => {
    expect(equals(awarded({ kind: 'PER_CORRECT', marks: 2 }, context({ correctSelectionCount: 3 })), '6')).toBe(
      true,
    );
  });

  it('multiplies a fractional mark exactly', () => {
    // 0.1 x 3 is 0.30000000000000004 in binary floating point.
    const value = awarded({ kind: 'PER_CORRECT', marks: 0.1 }, context({ correctSelectionCount: 3 }));
    expect(equals(value, '3/10')).toBe(true);
    expect(equals(value, String(0.1 * 3))).toBe(false);
  });

  it('treats a negative selection count as zero rather than inverting the award', () => {
    const value = awarded({ kind: 'PER_CORRECT', marks: 2 }, context({ correctSelectionCount: -3 }));
    expect(isZero(value)).toBe(true);
  });

  it('refuses a non-finite mark value', () => {
    expect(
      expectError(applyAward({ kind: 'PER_CORRECT', marks: Number.NaN }, context({ correctSelectionCount: 2 })))
        .code,
    ).toBe('AWARD_MARKS_INVALID');
  });
});

describe('FULL_MARKS', () => {
  it('awards the slot marks regardless of the response', () => {
    expect(equals(awarded({ kind: 'FULL_MARKS' }, context({ marksAvailable: 4 })), '4')).toBe(true);
  });

  it('awards the slot marks to an unattempted slot — this is what a bonus item pays', () => {
    const ctx = context({ marksAvailable: 4, correctSelectionCount: 0 });
    expect(equals(awarded({ kind: 'FULL_MARKS' }, ctx), '4')).toBe(true);
  });

  it('awards fractional slot marks exactly', () => {
    expect(equals(awarded({ kind: 'FULL_MARKS' }, context({ marksAvailable: 2.5 })), '5/2')).toBe(true);
  });

  it('refuses non-finite slot marks', () => {
    expect(expectError(applyAward({ kind: 'FULL_MARKS' }, context({ marksAvailable: Number.NaN }))).code).toBe(
      'AWARD_MARKS_INVALID',
    );
  });
});

describe('an unknown award kind', () => {
  const unknown = { kind: 'PER_CORRECT_SCALED', marks: 3 } as unknown as Award;

  it('fails closed — no mark at all, rather than a guess', () => {
    const error = expectError(applyAward(unknown, context()));
    expect(error.code).toBe('AWARD_KIND_UNKNOWN');
    expect(error.kind).toBe('RuleViolation');
  });

  it('names the kind it did not recognise', () => {
    expect(expectError(applyAward(unknown, context())).message).toContain('PER_CORRECT_SCALED');
  });

  it('does not throw', () => {
    expect(() => applyAward(unknown, context())).not.toThrow();
  });
});

describe('exactness', () => {
  it('sums eighty fractional awards without drift', () => {
    // Eighty items at 0.1 is 8 exactly here; in binary floating point the same
    // sum is 8.000000000000002.
    let total = makeRational(0n, 1n);
    for (let index = 0; index < 80; index += 1) {
      const award = awarded({ kind: 'FIXED', marks: 0.1 });
      total = makeRational(total.num * award.den + award.num * total.den, total.den * award.den);
    }
    expect(equals(total, '8')).toBe(true);
  });
});
