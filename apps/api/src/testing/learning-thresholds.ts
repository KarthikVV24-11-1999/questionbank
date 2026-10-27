import type { MasteryThresholds } from '../contexts/learning/domain/mastery-rule-set.js';

/**
 * D-002's thresholds, as a test would state them — and as the migration seeds the platform default. A spec states them here, in `src/testing/`,
 * because production source carries no threshold at all (`mastery-threshold-rules.ts`); `mastery-rule-set.integration.spec.ts` holds this object to the
 * row the migration wrote, so the two statements of one set of numbers cannot drift (session rule 5).
 *
 * The first block is D-002 (§12.2). `weakBelowAccuracy`, `halfLifeDays` and `confidenceFloor` are not in D-002 and were chosen (DEC-M7-7).
 */
export const D002_THRESHOLDS: MasteryThresholds = Object.freeze({
  promotion: Object.freeze({ minResponses: 8, minDistinctItems: 4, minDistinctSessions: 2, recentWindow: 8, minRecentAccuracy: 0.8, minRecentAtDemonstratedBand: 3 }),
  verification: Object.freeze({ minVerifyingResponses: 2, minGapHours: 48 }),
  session: Object.freeze({ idleGapMinutes: 30 }),
  states: Object.freeze({ weakBelowAccuracy: 0.5 }),
  decay: Object.freeze({ halfLifeDays: 60, confidenceFloor: 0.5 }),
});

/** The defaults with some values changed; each group is replaced field by field, so a spec names only what it changes. */
export function thresholdsWith(changes: {
  readonly [G in keyof MasteryThresholds]?: Partial<MasteryThresholds[G]>;
}): MasteryThresholds {
  return {
    promotion: { ...D002_THRESHOLDS.promotion, ...changes.promotion },
    verification: { ...D002_THRESHOLDS.verification, ...changes.verification },
    session: { ...D002_THRESHOLDS.session, ...changes.session },
    states: { ...D002_THRESHOLDS.states, ...changes.states },
    decay: { ...D002_THRESHOLDS.decay, ...changes.decay },
  };
}
