import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { DEC_M4_1_DEFAULT_POLICY, createReviewPolicy, type ReviewPolicy } from './review-policy.js';

function build(overrides: Partial<ReviewPolicy> = {}): ReviewPolicy {
  return { ...DEC_M4_1_DEFAULT_POLICY, ...overrides };
}

describe('createReviewPolicy', () => {
  it('accepts DEC-M4-1’s default thresholds', () => {
    expect(expectValue(createReviewPolicy(DEC_M4_1_DEFAULT_POLICY))).toEqual(DEC_M4_1_DEFAULT_POLICY);
  });

  it('refuses a non-positive warnAfterHours', () => {
    expect(expectError(createReviewPolicy(build({ warnAfterHours: 0 }))).code).toBe('WARN_AFTER_HOURS_INVALID');
    expect(expectError(createReviewPolicy(build({ warnAfterHours: -1 }))).code).toBe('WARN_AFTER_HOURS_INVALID');
    expect(expectError(createReviewPolicy(build({ warnAfterHours: Number.NaN }))).code).toBe(
      'WARN_AFTER_HOURS_INVALID',
    );
  });

  it('refuses a non-positive escalateAfterHours', () => {
    expect(expectError(createReviewPolicy(build({ escalateAfterHours: 0 }))).code).toBe(
      'ESCALATE_AFTER_HOURS_INVALID',
    );
  });

  it('refuses escalateAfterHours before warnAfterHours', () => {
    expect(
      expectError(createReviewPolicy(build({ warnAfterHours: 72, escalateAfterHours: 48 }))).code,
    ).toBe('ESCALATE_BEFORE_WARN');
  });

  it('accepts escalateAfterHours equal to warnAfterHours', () => {
    expectValue(createReviewPolicy(build({ warnAfterHours: 48, escalateAfterHours: 48 })));
  });

  it('refuses a non-positive leaseHours', () => {
    expect(expectError(createReviewPolicy(build({ leaseHours: 0 }))).code).toBe('LEASE_HOURS_INVALID');
  });

  it('refuses a sampleRate outside [0, 1]', () => {
    expect(expectError(createReviewPolicy(build({ sampleRate: -0.01 }))).code).toBe('SAMPLE_RATE_OUT_OF_RANGE');
    expect(expectError(createReviewPolicy(build({ sampleRate: 1.01 }))).code).toBe('SAMPLE_RATE_OUT_OF_RANGE');
  });

  it('accepts sampleRate at both bounds', () => {
    expectValue(createReviewPolicy(build({ sampleRate: 0 })));
    expectValue(createReviewPolicy(build({ sampleRate: 1 })));
  });

  it('freezes the constructed policy', () => {
    expect(Object.isFrozen(expectValue(createReviewPolicy(DEC_M4_1_DEFAULT_POLICY)))).toBe(true);
  });
});
