import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { DEC_M4_1_DEFAULT_POLICY } from './review-policy.js';
import { ESCALATION_TARGET_ROLE, ageState, escalationTarget, leaseState } from './ageing.js';

const ENTERED_AT = '2026-08-10T00:00:00Z';

function hoursLater(hours: number): string {
  return new Date(Date.parse(ENTERED_AT) + hours * 60 * 60 * 1000).toISOString();
}

describe('ageState', () => {
  it('is fresh well before warnAfterHours', () => {
    expect(expectValue(ageState(ENTERED_AT, hoursLater(1), DEC_M4_1_DEFAULT_POLICY))).toBe('fresh');
  });

  it('is fresh just under warnAfterHours', () => {
    expect(expectValue(ageState(ENTERED_AT, hoursLater(47.99), DEC_M4_1_DEFAULT_POLICY))).toBe('fresh');
  });

  it('is warn exactly at warnAfterHours (inclusive)', () => {
    expect(expectValue(ageState(ENTERED_AT, hoursLater(48), DEC_M4_1_DEFAULT_POLICY))).toBe('warn');
  });

  it('is warn between the two thresholds', () => {
    expect(expectValue(ageState(ENTERED_AT, hoursLater(60), DEC_M4_1_DEFAULT_POLICY))).toBe('warn');
  });

  it('is warn just under escalateAfterHours', () => {
    expect(expectValue(ageState(ENTERED_AT, hoursLater(71.99), DEC_M4_1_DEFAULT_POLICY))).toBe('warn');
  });

  it('is escalated exactly at escalateAfterHours (inclusive)', () => {
    expect(expectValue(ageState(ENTERED_AT, hoursLater(72), DEC_M4_1_DEFAULT_POLICY))).toBe('escalated');
  });

  it('is escalated well past escalateAfterHours', () => {
    expect(expectValue(ageState(ENTERED_AT, hoursLater(200), DEC_M4_1_DEFAULT_POLICY))).toBe('escalated');
  });

  it('refuses a now before stateEnteredAt, as Validation, never a negative age', () => {
    const error = expectError(ageState(ENTERED_AT, hoursLater(-1), DEC_M4_1_DEFAULT_POLICY));
    expect(error.code).toBe('NOW_BEFORE_INSTANT');
    expect(error.kind).toBe('Validation');
  });

  it('refuses a stateEnteredAt that is not an ISO instant', () => {
    expect(expectError(ageState('not-a-date', ENTERED_AT, DEC_M4_1_DEFAULT_POLICY)).code).toBe(
      'INSTANT_NOT_A_TIMESTAMP',
    );
  });

  it('refuses a now that is not an ISO instant', () => {
    expect(expectError(ageState(ENTERED_AT, 'not-a-date', DEC_M4_1_DEFAULT_POLICY)).code).toBe(
      'INSTANT_NOT_A_TIMESTAMP',
    );
  });
});

describe('leaseState', () => {
  it('is live before leaseHours', () => {
    expect(expectValue(leaseState(ENTERED_AT, hoursLater(3.99), DEC_M4_1_DEFAULT_POLICY))).toBe('live');
  });

  it('is expired exactly at leaseHours (inclusive)', () => {
    expect(expectValue(leaseState(ENTERED_AT, hoursLater(4), DEC_M4_1_DEFAULT_POLICY))).toBe('expired');
  });

  it('is expired well past leaseHours', () => {
    expect(expectValue(leaseState(ENTERED_AT, hoursLater(10), DEC_M4_1_DEFAULT_POLICY))).toBe('expired');
  });

  it('refuses a now before claimedAt', () => {
    expect(expectError(leaseState(ENTERED_AT, hoursLater(-0.5), DEC_M4_1_DEFAULT_POLICY)).code).toBe(
      'NOW_BEFORE_INSTANT',
    );
  });
});

describe('escalationTarget', () => {
  it('returns a role, never a principal', () => {
    const target = escalationTarget();
    expect(target).toBe(ESCALATION_TARGET_ROLE);
    expect(target).toBe('content_ops');
    // A principal is an object with an id and a kind; this is a bare string.
    expect(typeof target).toBe('string');
  });

  it('takes no assignment to reassign — escalation carries no arguments', () => {
    expect(escalationTarget.length).toBe(0);
  });
});
