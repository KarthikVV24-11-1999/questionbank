import { describe, expect, it } from 'vitest';
import { TimingPolicy, type CreateTimingPolicyProps } from './timing-policy.js';
import {
  NavigationPolicy,
  checkDeliveryPoliciesCompatible,
  type CreateNavigationPolicyProps,
} from './navigation-policy.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

const jeeMainTiming: CreateTimingPolicyProps = {
  totalDurationMinutes: 180,
  sectionLocking: false,
  warningThresholdsMinutes: [30, 10, 5],
  autoSubmitOnExpiry: true,
};

const jeeMainNavigation: CreateNavigationPolicyProps = {
  crossSectionNavigation: true,
  allowMarkForReview: true,
  allowAnswerChange: true,
  allowClearResponse: true,
};

function timing(overrides: Partial<CreateTimingPolicyProps> = {}): TimingPolicy {
  return expectValue(TimingPolicy.create({ ...jeeMainTiming, ...overrides }));
}

function navigation(overrides: Partial<CreateNavigationPolicyProps> = {}): NavigationPolicy {
  return expectValue(NavigationPolicy.create({ ...jeeMainNavigation, ...overrides }));
}

describe('TimingPolicy', () => {
  it('carries duration, locking, thresholds and auto-submit', () => {
    const policy = timing();

    expect(policy.totalDurationMinutes).toBe(180);
    expect(policy.sectionLocking).toBe(false);
    expect(policy.warningThresholdsMinutes).toEqual([30, 10, 5]);
    expect(policy.autoSubmitOnExpiry).toBe(true);
  });

  it('accepts an empty threshold list', () => {
    expect(timing({ warningThresholdsMinutes: [] }).warningThresholdsMinutes).toEqual([]);
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects total duration %s',
    (totalDurationMinutes) => {
      expect(
        expectError(TimingPolicy.create({ ...jeeMainTiming, totalDurationMinutes })).code,
      ).toBe('TOTAL_DURATION_INVALID');
    },
  );

  it.each([
    [[10, 30]],
    [[30, 30]],
    [[5, 10, 30]],
  ])('rejects thresholds %j that are not strictly descending', (warningThresholdsMinutes) => {
    expect(
      expectError(TimingPolicy.create({ ...jeeMainTiming, warningThresholdsMinutes })).code,
    ).toBe('WARNING_THRESHOLDS_NOT_DESCENDING');
  });

  it.each([180, 181])('rejects threshold %s that is not before the end', (threshold) => {
    expect(
      expectError(
        TimingPolicy.create({ ...jeeMainTiming, warningThresholdsMinutes: [threshold] }),
      ).code,
    ).toBe('WARNING_THRESHOLD_NOT_BEFORE_END');
  });

  it.each([0, -5, Number.NaN])('rejects threshold value %s', (threshold) => {
    expect(
      expectError(
        TimingPolicy.create({ ...jeeMainTiming, warningThresholdsMinutes: [threshold] }),
      ).code,
    ).toBe('WARNING_THRESHOLD_INVALID');
  });

  it('is immutable', () => {
    const policy = timing();

    expect(Object.isFrozen(policy)).toBe(true);
    expect(Object.isFrozen(policy.warningThresholdsMinutes)).toBe(true);
    expect(() => {
      (policy as unknown as Record<string, unknown>)['totalDurationMinutes'] = 1;
    }).toThrow(TypeError);
  });

  it('does not share the caller’s threshold array', () => {
    const warningThresholdsMinutes = [30, 10];
    const policy = timing({ warningThresholdsMinutes });

    warningThresholdsMinutes.push(1);

    expect(policy.warningThresholdsMinutes).toEqual([30, 10]);
  });
});

describe('NavigationPolicy', () => {
  it('carries all four navigation flags', () => {
    const policy = navigation({ allowClearResponse: false });

    expect(policy.crossSectionNavigation).toBe(true);
    expect(policy.allowMarkForReview).toBe(true);
    expect(policy.allowAnswerChange).toBe(true);
    expect(policy.allowClearResponse).toBe(false);
  });

  it('is immutable', () => {
    const policy = navigation();

    expect(Object.isFrozen(policy)).toBe(true);
    expect(() => {
      (policy as unknown as Record<string, unknown>)['crossSectionNavigation'] = false;
    }).toThrow(TypeError);
  });
});

describe('delivery policy compatibility', () => {
  it('rejects section locking combined with cross-section navigation', () => {
    const error = expectError(
      checkDeliveryPoliciesCompatible(timing({ sectionLocking: true }), navigation()),
    );

    expect(error.code).toBe('CONTRADICTORY_SECTION_LOCKING');
    expect(error.kind).toBe('Validation');
  });

  it.each([
    ['locked sections without cross-section navigation', true, false],
    ['unlocked sections with cross-section navigation', false, true],
    ['unlocked sections without cross-section navigation', false, false],
  ])('accepts %s', (_case, sectionLocking, crossSectionNavigation) => {
    expect(
      expectValue(
        checkDeliveryPoliciesCompatible(timing({ sectionLocking }), navigation({ crossSectionNavigation })),
      ),
    ).toBe(true);
  });

  it('accepts the JEE Main pairing: single timer, free navigation', () => {
    expect(expectValue(checkDeliveryPoliciesCompatible(timing(), navigation()))).toBe(true);
  });
});
