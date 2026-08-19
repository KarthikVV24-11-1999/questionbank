import { err, ok, type Result } from '../result.js';
import { validationError, type ContentError } from '../content-error.js';
import type { ReviewPolicy } from './review-policy.js';

/**
 * Ageing, escalation and the stale-claim rule (DEC-M4-1) — pure arithmetic
 * over supplied instants, never a clock.
 *
 * **Two clocks, because they measure different failures.** `ageState`
 * measures how long an item has waited for anyone to pick it up —
 * `warn` at 48h, `escalated` at 72h by default, both boundaries inclusive.
 * `leaseState` measures how long a specific reviewer has held a claim
 * without deciding — `expired` past `leaseHours`. Conflating the two is how
 * a queue stalls: an item nobody has touched and a claim someone abandoned
 * are different problems with different remedies.
 *
 * **Escalation targets a role, never a principal.** `escalationTarget`
 * returns `'content_ops'` and takes no assignment to reassign — DEC-M4-1 is
 * explicit that escalation makes an item visible, it does not hand it to
 * anyone. Auto-reassignment is how items ping-pong between reviewers who
 * each assume the other is handling it.
 *
 * **`Date.parse` on a supplied string is not a clock read.** It converts an
 * instant this module was handed into a number so two instants can be
 * subtracted; nothing here calls `Date.now()`, constructs `new Date()` with
 * no argument, or otherwise asks the process what time it is.
 */

export const AGE_STATES = ['fresh', 'warn', 'escalated'] as const;
export type AgeState = (typeof AGE_STATES)[number];

export const LEASE_STATES = ['live', 'expired'] as const;
export type LeaseState = (typeof LEASE_STATES)[number];

/** The one target escalation ever names — a role, not a principal (DEC-M4-1). */
export const ESCALATION_TARGET_ROLE = 'content_ops';

export type AgeingErrorCode = 'INSTANT_NOT_A_TIMESTAMP' | 'NOW_BEFORE_INSTANT';
export type AgeingError = ContentError<AgeingErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;
const MILLIS_PER_HOUR = 1000 * 60 * 60;

function invalid(code: AgeingErrorCode, message: string, location: string): AgeingError {
  return validationError(code, message, location);
}

/**
 * Hours from `from` to `to`, or an error — never a negative number. A `now`
 * earlier than the instant it is measured against is malformed input, not a
 * fact this module represents as a negative age.
 */
function hoursSince(from: string, now: string, location: string): Result<number, AgeingError> {
  if (!ISO_INSTANT.test(from)) {
    return err(invalid('INSTANT_NOT_A_TIMESTAMP', `"${from}" is not an ISO-8601 instant`, `${location}.from`));
  }
  if (!ISO_INSTANT.test(now)) {
    return err(invalid('INSTANT_NOT_A_TIMESTAMP', `"${now}" is not an ISO-8601 instant`, `${location}.now`));
  }
  const hours = (Date.parse(now) - Date.parse(from)) / MILLIS_PER_HOUR;
  if (hours < 0) {
    return err(invalid('NOW_BEFORE_INSTANT', `now ("${now}") is before "${from}"`, location));
  }
  return ok(hours);
}

/** `fresh` below `warnAfterHours`, `warn` from `warnAfterHours`, `escalated` from `escalateAfterHours` — both boundaries inclusive. */
export function ageState(
  stateEnteredAt: string,
  now: string,
  policy: ReviewPolicy,
  location = 'ageState',
): Result<AgeState, AgeingError> {
  const hours = hoursSince(stateEnteredAt, now, location);
  if (!hours.ok) return hours;
  if (hours.value >= policy.escalateAfterHours) return ok('escalated');
  if (hours.value >= policy.warnAfterHours) return ok('warn');
  return ok('fresh');
}

/** `expired` from `leaseHours`, inclusive — the lease releases automatically; this is a lock timing out, not a judgement. */
export function leaseState(
  claimedAt: string,
  now: string,
  policy: ReviewPolicy,
  location = 'leaseState',
): Result<LeaseState, AgeingError> {
  const hours = hoursSince(claimedAt, now, location);
  if (!hours.ok) return hours;
  return ok(hours.value >= policy.leaseHours ? 'expired' : 'live');
}

/** Escalation makes an item visible to Content Ops; it does not reassign it (DEC-M4-1). */
export function escalationTarget(): typeof ESCALATION_TARGET_ROLE {
  return ESCALATION_TARGET_ROLE;
}
