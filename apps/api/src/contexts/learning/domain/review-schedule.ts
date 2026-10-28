import type { ConceptEvidence } from './concept-state.js';
import type { ReviewThresholds } from './mastery-rule-set.js';

/**
 * `ReviewSchedule` — when a concept is next due for review, and how often it has lapsed (M7-47, M7-48, DEC-M7-24, DOMAIN-MODEL 12).
 *
 * **Per concept, never per item.** The learner must not memorise a particular question, and a schedule keyed by item is that failure in one line: this module is given a
 * concept's evidence and returns one schedule, and has no input from which an item could become its key. Items appear only as evidence, which it counts.
 *
 * **A fold over observations, so it is a function of evidence and nothing else.** An observation is the concept's responses in one study sitting (DEC-M7-2): they are one
 * act of studying, and a pass or a failure of it is what a review measures. It passes at or above the rule set's accuracy. Folded in the order the sittings happened:
 *
 * - **a pass** adds one consecutive success; the interval is the first interval for the first of a run and grows by the rule set's factor for each further, up to the most;
 * - **a failure** is a lapse: the count rises by one, the run of successes ends, and the interval is multiplied by the lapse factor, so it **shortens**, down to the least.
 *
 * Because it is derived from the evidence as it now stands, a corrected response corrects the schedule with it, and the same evidence in any arrival order gives the same
 * schedule. It does not read the error notebook: the notebook is not corrected by a re-score (D81), and a schedule that read it would inherit that.
 *
 * **Escalation is a threshold on the lapse count** (`escalationDue`). Past it a concept is not given a still shorter interval; it is a remediation finding (DOMAIN-MODEL:
 * escalate to remediation rather than more repetition). That a concept escalates once is the table's key, not this module's.
 */
export interface ReviewSchedule {
  readonly conceptIdentityId: string;
  readonly dueAt: string;
  readonly intervalDays: number;
  readonly consecutiveSuccesses: number;
  readonly lapseCount: number;
  /** The instant of the last response of the last sitting folded in. */
  readonly lastObservedAt: string;
}

export interface Observation {
  readonly sessionId: string;
  /** The instant of the sitting's last response of the concept. */
  readonly at: string;
  readonly correct: number;
  readonly total: number;
}

const DAY_MS = 86_400_000;

/** One observation per sitting, earliest first (ties by sitting, so the order is total). */
export function observationsOf(evidence: readonly ConceptEvidence[]): readonly Observation[] {
  const bySession = new Map<string, { at: string; correct: number; total: number }>();
  for (const response of evidence) {
    const held = bySession.get(response.sessionId) ?? { at: response.occurredAt, correct: 0, total: 0 };
    bySession.set(response.sessionId, {
      at: response.occurredAt > held.at ? response.occurredAt : held.at,
      correct: held.correct + (response.outcome === 'correct' ? 1 : 0),
      total: held.total + 1,
    });
  }
  return [...bySession.entries()]
    .map(([sessionId, held]) => Object.freeze({ sessionId, ...held }))
    .sort((a, b) => (a.at === b.at ? (a.sessionId < b.sessionId ? -1 : 1) : a.at < b.at ? -1 : 1));
}

/** The concept's schedule, or `null` for a concept with no evidence: there is nothing yet to schedule a review of. */
export function scheduleOf(conceptIdentityId: string, evidence: readonly ConceptEvidence[], review: ReviewThresholds): ReviewSchedule | null {
  const observations = observationsOf(evidence);
  if (observations.length === 0) return null;
  let intervalDays = review.firstIntervalDays;
  let consecutiveSuccesses = 0;
  let lapseCount = 0;
  for (const observation of observations) {
    if (observation.correct / observation.total >= review.passAccuracy) {
      consecutiveSuccesses += 1;
      intervalDays = consecutiveSuccesses === 1 ? review.firstIntervalDays : Math.min(review.maxIntervalDays, Math.ceil(intervalDays * review.growthFactor));
    } else {
      lapseCount += 1;
      consecutiveSuccesses = 0;
      intervalDays = Math.max(review.minIntervalDays, Math.floor(intervalDays * review.lapseFactor));
    }
  }
  const last = observations[observations.length - 1]!.at;
  return Object.freeze({
    conceptIdentityId,
    dueAt: new Date(Date.parse(last) + intervalDays * DAY_MS).toISOString(),
    intervalDays,
    consecutiveSuccesses,
    lapseCount,
    lastObservedAt: last,
  });
}

/** Whether the concept has lapsed often enough that it is escalated and not repeated again. */
export function escalationDue(schedule: ReviewSchedule, review: ReviewThresholds): boolean {
  return schedule.lapseCount >= review.escalateAtLapses;
}
