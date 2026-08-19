import { err, ok, type Result } from '../result.js';
import { validationError, type ContentError } from '../content-error.js';

/**
 * `ReviewPolicy` — the thresholds DEC-M4-1 and DEC-M4-14 name, read through
 * the typed config module (F16) at the application layer (M4-26) and
 * supplied to every function here as a value. The domain owns no default and
 * reads no config; a policy with the DEC-M4-1 defaults is a value a caller
 * constructs, not a fallback this module reaches for.
 */

export interface ReviewPolicy {
  readonly warnAfterHours: number;
  readonly escalateAfterHours: number;
  readonly leaseHours: number;
  readonly sampleRate: number;
}

export const DEC_M4_1_DEFAULT_POLICY: ReviewPolicy = Object.freeze({
  warnAfterHours: 48,
  escalateAfterHours: 72,
  leaseHours: 4,
  sampleRate: 0.05,
});

export type ReviewPolicyErrorCode =
  | 'WARN_AFTER_HOURS_INVALID'
  | 'ESCALATE_AFTER_HOURS_INVALID'
  | 'ESCALATE_BEFORE_WARN'
  | 'LEASE_HOURS_INVALID'
  | 'SAMPLE_RATE_OUT_OF_RANGE';

export type ReviewPolicyError = ContentError<ReviewPolicyErrorCode>;

function invalid(code: ReviewPolicyErrorCode, message: string, location: string): ReviewPolicyError {
  return validationError(code, message, location);
}

export function createReviewPolicy(
  props: ReviewPolicy,
  location = 'reviewPolicy',
): Result<ReviewPolicy, ReviewPolicyError> {
  if (!Number.isFinite(props.warnAfterHours) || props.warnAfterHours <= 0) {
    return err(
      invalid('WARN_AFTER_HOURS_INVALID', 'warnAfterHours must be a positive number', `${location}.warnAfterHours`),
    );
  }
  if (!Number.isFinite(props.escalateAfterHours) || props.escalateAfterHours <= 0) {
    return err(
      invalid(
        'ESCALATE_AFTER_HOURS_INVALID',
        'escalateAfterHours must be a positive number',
        `${location}.escalateAfterHours`,
      ),
    );
  }
  if (props.escalateAfterHours < props.warnAfterHours) {
    return err(
      invalid(
        'ESCALATE_BEFORE_WARN',
        `escalateAfterHours (${props.escalateAfterHours}) is before warnAfterHours (${props.warnAfterHours})`,
        `${location}.escalateAfterHours`,
      ),
    );
  }
  if (!Number.isFinite(props.leaseHours) || props.leaseHours <= 0) {
    return err(
      invalid('LEASE_HOURS_INVALID', 'leaseHours must be a positive number', `${location}.leaseHours`),
    );
  }
  if (!Number.isFinite(props.sampleRate) || props.sampleRate < 0 || props.sampleRate > 1) {
    return err(
      invalid('SAMPLE_RATE_OUT_OF_RANGE', 'sampleRate must be within [0, 1]', `${location}.sampleRate`),
    );
  }

  return ok(Object.freeze({ ...props }));
}
