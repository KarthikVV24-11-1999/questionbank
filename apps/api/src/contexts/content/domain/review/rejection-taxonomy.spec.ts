import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import {
  DUPLICATE_REASON_CODE,
  REJECTION_REASONS,
  REVIEW_OUTCOMES_TAKING_A_REASON,
  assertDuplicateHasTarget,
  assertReasonPermitted,
  type OutcomeTakingAReason,
} from './rejection-taxonomy.js';

describe('REJECTION_REASONS', () => {
  it('has exactly DEC-M4-11’s ten entries', () => {
    expect(REJECTION_REASONS).toHaveLength(10);
  });

  it('gives every reason a unique key', () => {
    const keys = REJECTION_REASONS.map((reason) => reason.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('gives every reason a unique code', () => {
    const codes = REJECTION_REASONS.map((reason) => reason.code);
    expect(new Set(codes).size).toBe(codes.length);
  });

  it.each(REJECTION_REASONS)('$code constructs with at least one eligible outcome', (reason) => {
    expect(reason.eligibleOutcomes.length).toBeGreaterThan(0);
  });
});

describe('assertReasonPermitted', () => {
  it.each(
    REJECTION_REASONS.flatMap((reason) =>
      REVIEW_OUTCOMES_TAKING_A_REASON.map(
        (outcome) => [reason.code, outcome, (reason.eligibleOutcomes as readonly string[]).includes(outcome)] as const,
      ),
    ),
  )('reason %s for outcome %s is eligible: %s', (code, outcome, eligible) => {
    const result = assertReasonPermitted(code, outcome);
    if (eligible) {
      expect(expectValue(result).code).toBe(code);
    } else {
      expect(expectError(result).code).toBe('REASON_NOT_ELIGIBLE_FOR_OUTCOME');
    }
  });

  it('refuses an unknown code outright, never coerced', () => {
    const outcome: OutcomeTakingAReason = 'reject';
    expect(expectError(assertReasonPermitted('NOT_A_REAL_CODE', outcome)).code).toBe('REASON_CODE_UNKNOWN');
  });
});

describe('assertDuplicateHasTarget', () => {
  it('refuses DUPLICATE with no target', () => {
    expect(expectError(assertDuplicateHasTarget(DUPLICATE_REASON_CODE, undefined)).code).toBe(
      'DUPLICATE_REQUIRES_A_TARGET',
    );
  });

  it('refuses DUPLICATE with a blank target', () => {
    expect(expectError(assertDuplicateHasTarget(DUPLICATE_REASON_CODE, '   ')).code).toBe(
      'DUPLICATE_REQUIRES_A_TARGET',
    );
  });

  it('accepts DUPLICATE with a target', () => {
    expectValue(assertDuplicateHasTarget(DUPLICATE_REASON_CODE, 'item-42'));
  });

  it('ignores the target entirely for any other reason', () => {
    expectValue(assertDuplicateHasTarget('FACTUALLY_INCORRECT', undefined));
    expectValue(assertDuplicateHasTarget('FACTUALLY_INCORRECT', 'item-42'));
  });
});
