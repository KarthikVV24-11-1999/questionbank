import { err, ok, type Result } from '../result.js';

export interface CreateTimingPolicyProps {
  readonly totalDurationMinutes: number;
  readonly sectionLocking: boolean;
  readonly warningThresholdsMinutes: readonly number[];
  readonly autoSubmitOnExpiry: boolean;
}

export type TimingPolicyErrorCode =
  | 'TOTAL_DURATION_INVALID'
  | 'WARNING_THRESHOLD_INVALID'
  | 'WARNING_THRESHOLDS_NOT_DESCENDING'
  | 'WARNING_THRESHOLD_NOT_BEFORE_END';

export interface TimingPolicyError {
  readonly kind: 'Validation';
  readonly code: TimingPolicyErrorCode;
  readonly message: string;
}

function validationError(code: TimingPolicyErrorCode, message: string): TimingPolicyError {
  return { kind: 'Validation', code, message };
}

function validateThresholds(
  thresholds: readonly number[],
  totalDurationMinutes: number,
): Result<readonly number[], TimingPolicyError> {
  for (const threshold of thresholds) {
    if (!Number.isFinite(threshold) || threshold <= 0) {
      return err(
        validationError(
          'WARNING_THRESHOLD_INVALID',
          `warning thresholds must be finite and greater than 0, got ${threshold}`,
        ),
      );
    }
    if (threshold >= totalDurationMinutes) {
      return err(
        validationError(
          'WARNING_THRESHOLD_NOT_BEFORE_END',
          `warning threshold ${threshold} must be less than the total duration ${totalDurationMinutes}`,
        ),
      );
    }
  }

  const descending = thresholds.every(
    (threshold, index) => index === 0 || threshold < (thresholds[index - 1] as number),
  );
  if (!descending) {
    return err(
      validationError(
        'WARNING_THRESHOLDS_NOT_DESCENDING',
        `warning thresholds must be strictly descending, got ${thresholds.join(', ')}`,
      ),
    );
  }

  return ok(thresholds);
}

/**
 * Declarative delivery timing for an exam profile (DOMAIN-MODEL §4).
 * Thresholds are minutes remaining, in the order a candidate meets them.
 */
export class TimingPolicy {
  private constructor(
    readonly totalDurationMinutes: number,
    readonly sectionLocking: boolean,
    readonly warningThresholdsMinutes: readonly number[],
    readonly autoSubmitOnExpiry: boolean,
  ) {
    Object.freeze(this.warningThresholdsMinutes);
    Object.freeze(this);
  }

  static create(props: CreateTimingPolicyProps): Result<TimingPolicy, TimingPolicyError> {
    if (!Number.isFinite(props.totalDurationMinutes) || props.totalDurationMinutes <= 0) {
      return err(
        validationError(
          'TOTAL_DURATION_INVALID',
          `totalDurationMinutes must be greater than 0, got ${props.totalDurationMinutes}`,
        ),
      );
    }

    const thresholds = validateThresholds(props.warningThresholdsMinutes, props.totalDurationMinutes);
    if (!thresholds.ok) return thresholds;

    return ok(
      new TimingPolicy(
        props.totalDurationMinutes,
        props.sectionLocking,
        [...thresholds.value],
        props.autoSubmitOnExpiry,
      ),
    );
  }
}
