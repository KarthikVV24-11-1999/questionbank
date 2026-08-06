import { err, ok, type Result } from '../result.js';
import type { TimingPolicy } from './timing-policy.js';

export interface CreateNavigationPolicyProps {
  readonly crossSectionNavigation: boolean;
  readonly allowMarkForReview: boolean;
  readonly allowAnswerChange: boolean;
  readonly allowClearResponse: boolean;
}

export type NavigationPolicyErrorCode = 'CONTRADICTORY_SECTION_LOCKING';

export interface NavigationPolicyError {
  readonly kind: 'Validation';
  readonly code: NavigationPolicyErrorCode;
  readonly message: string;
}

/** Declarative navigation rules for an exam profile (DOMAIN-MODEL §4). */
export class NavigationPolicy {
  private constructor(
    readonly crossSectionNavigation: boolean,
    readonly allowMarkForReview: boolean,
    readonly allowAnswerChange: boolean,
    readonly allowClearResponse: boolean,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateNavigationPolicyProps): Result<NavigationPolicy, NavigationPolicyError> {
    return ok(
      new NavigationPolicy(
        props.crossSectionNavigation,
        props.allowMarkForReview,
        props.allowAnswerChange,
        props.allowClearResponse,
      ),
    );
  }
}

/**
 * Locked sections and free cross-section navigation are mutually exclusive:
 * a candidate cannot be barred from returning to a section and free to move
 * between sections at the same time.
 */
export function checkDeliveryPoliciesCompatible(
  timing: TimingPolicy,
  navigation: NavigationPolicy,
): Result<true, NavigationPolicyError> {
  if (timing.sectionLocking && navigation.crossSectionNavigation) {
    return err({
      kind: 'Validation',
      code: 'CONTRADICTORY_SECTION_LOCKING',
      message: 'sectionLocking = true cannot be combined with crossSectionNavigation = true',
    });
  }

  return ok(true);
}
