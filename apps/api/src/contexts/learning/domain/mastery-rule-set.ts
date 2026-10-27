import { createHash } from 'node:crypto';
import { err, ok, type Result } from './result.js';
import type { LearningError } from './mastery-evidence.js';

/**
 * D-002's thresholds, as versioned data (M7-12).
 *
 * DECISIONS D-002 says the thresholds are *tunable per exam*, DOMAIN-MODEL §12.2 says they are "configuration, not code", and BACKEND-ARCHITECTURE
 * puts mastery thresholds in the database with the marking rules. So there is **no threshold anywhere in this context's source**: the values live in
 * `learning.mastery_rule_set`, one immutable row per version, and a rule (`mastery-threshold-rules.ts`) fails the build on a literal that looks like one.
 *
 * **A version is pinned on what it produced.** A `MasteryTransition` names the rule set it was decided under, so changing a threshold publishes a new
 * version and never restates history, which is the curriculum's marking-rule-set precedent.
 *
 * **Scope.** A rule set applies to a taxonomy version, the exam-shaped identifier evidence carries; a rule set with no scope is the platform default
 * that applies where none is published for the taxonomy.
 *
 * The `StudySession` idle gap (DEC-M7-2) is one of these values, not a separate setting.
 *
 * Values D-002 gives: `minResponses`, `minDistinctItems`, `minDistinctSessions`, `recentWindow`, `minRecentAccuracy`, `minRecentAtDemonstratedBand`,
 * `minVerifyingResponses`, `minVerifyingGapHours`, and (DEC-M7-2) `idleGapMinutes`. Values it does not give, and which were chosen: `weakBelowAccuracy`,
 * `confidenceFloor` and `halfLifeDays` (DEC-M7-7).
 */
export interface MasteryThresholds {
  readonly promotion: {
    /** Scored responses on the concept. */
    readonly minResponses: number;
    readonly minDistinctItems: number;
    readonly minDistinctSessions: number;
    /** The window the accuracy is taken over: the most recent N responses. */
    readonly recentWindow: number;
    /** A fraction in (0, 1]. */
    readonly minRecentAccuracy: number;
    /** Of the recent window, how many must be on items at or above the demonstrated band. */
    readonly minRecentAtDemonstratedBand: number;
  };
  readonly verification: {
    /** Further correct responses on different items, in a different session. */
    readonly minVerifyingResponses: number;
    /** After the qualifying evidence. */
    readonly minGapHours: number;
  };
  readonly session: {
    /** A learner's study sitting is closed by an idle gap this long (DEC-M7-2). */
    readonly idleGapMinutes: number;
  };
  readonly states: {
    /** With evidence, recent accuracy below this is `weak`; otherwise `developing` until promoted. A fraction in (0, 1). */
    readonly weakBelowAccuracy: number;
  };
  readonly decay: {
    /** Confidence halves every this many days since the last evidence. */
    readonly halfLifeDays: number;
    /** A `strong` state whose confidence falls below this is `developing`. A fraction in (0, 1). */
    readonly confidenceFloor: number;
  };
}

export type MasteryRuleSetErrorCode = 'RULE_SET_THRESHOLDS_INVALID' | 'RULE_SET_REFERENCE_INVALID';

/** A published version: immutable, and named by the hash of what it says. */
export interface MasteryRuleSet {
  readonly ruleSetId: string;
  /** The taxonomy version it applies to; `null` for the platform default. */
  readonly taxonomyVersionId: string | null;
  readonly versionNo: number;
  readonly thresholds: MasteryThresholds;
  /** SHA-256 of the canonical JSON of `thresholds`. */
  readonly thresholdsHash: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const isWhole = (value: unknown, min: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min;
const isPositive = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value > 0;
const isFraction = (value: unknown, inclusiveOne: boolean): value is number =>
  typeof value === 'number' && value > 0 && (inclusiveOne ? value <= 1 : value < 1);

function invalid(message: string): LearningError<MasteryRuleSetErrorCode> {
  return Object.freeze({ kind: 'Validation', code: 'RULE_SET_THRESHOLDS_INVALID', message });
}

/** Keys sorted at every depth (they are unique, so there is no tie to break), so the same thresholds always hash to the same bytes however they were assembled. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, inner]) => `${JSON.stringify(key)}:${canonicalJson(inner)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function hashThresholds(thresholds: MasteryThresholds): string {
  return createHash('sha256').update(canonicalJson(thresholds)).digest('hex');
}

/**
 * Checks the shape and the relations between values that make a rule set mean something: a recent window cannot be smaller than the responses a
 * promotion needs *of it*, the band clause cannot ask for more of the window than the window holds, and a floor of 1 would decay a state the moment it
 * was made.
 */
export function validateThresholds(input: unknown): Result<MasteryThresholds, LearningError<MasteryRuleSetErrorCode>> {
  const t = input as Partial<Record<keyof MasteryThresholds, Record<string, unknown>>> | null;
  if (t === null || typeof t !== 'object') return err(invalid('thresholds must be an object'));
  const { promotion: p, verification: v, session: s, states: st, decay: d } = t;
  if (!p || !v || !s || !st || !d) return err(invalid('thresholds name promotion, verification, session, states and decay'));

  const faults: string[] = [];
  for (const key of ['minResponses', 'minDistinctItems', 'minDistinctSessions', 'recentWindow', 'minRecentAtDemonstratedBand'] as const) {
    if (!isWhole(p[key], 1)) faults.push(`promotion.${key} is a whole number from 1`);
  }
  if (!isFraction(p['minRecentAccuracy'], true)) faults.push('promotion.minRecentAccuracy is a fraction above 0 and at most 1');
  if (!isWhole(v['minVerifyingResponses'], 1)) faults.push('verification.minVerifyingResponses is a whole number from 1');
  if (!isPositive(v['minGapHours'])) faults.push('verification.minGapHours is above 0');
  if (!isPositive(s['idleGapMinutes'])) faults.push('session.idleGapMinutes is above 0');
  if (!isFraction(st['weakBelowAccuracy'], false)) faults.push('states.weakBelowAccuracy is a fraction above 0 and below 1');
  if (!isPositive(d['halfLifeDays'])) faults.push('decay.halfLifeDays is above 0');
  if (!isFraction(d['confidenceFloor'], false)) faults.push('decay.confidenceFloor is a fraction above 0 and below 1');
  if (faults.length > 0) return err(invalid(faults.join('; ')));

  const promotion = p as unknown as MasteryThresholds['promotion'];
  if (promotion.recentWindow > promotion.minResponses) faults.push('promotion.recentWindow cannot exceed promotion.minResponses');
  if (promotion.minRecentAtDemonstratedBand > promotion.recentWindow) faults.push('promotion.minRecentAtDemonstratedBand cannot exceed promotion.recentWindow');
  if (promotion.minDistinctItems > promotion.minResponses) faults.push('promotion.minDistinctItems cannot exceed promotion.minResponses');
  if ((st as { weakBelowAccuracy: number }).weakBelowAccuracy > promotion.minRecentAccuracy) faults.push('states.weakBelowAccuracy cannot exceed promotion.minRecentAccuracy');
  if (faults.length > 0) return err(invalid(faults.join('; ')));

  return ok(
    Object.freeze({
      promotion: Object.freeze({ ...promotion }),
      verification: Object.freeze({ ...(v as unknown as MasteryThresholds['verification']) }),
      session: Object.freeze({ ...(s as unknown as MasteryThresholds['session']) }),
      states: Object.freeze({ ...(st as unknown as MasteryThresholds['states']) }),
      decay: Object.freeze({ ...(d as unknown as MasteryThresholds['decay']) }),
    }),
  );
}

export interface MasteryRuleSetProps {
  readonly ruleSetId: unknown;
  readonly taxonomyVersionId: unknown;
  readonly versionNo: unknown;
  readonly thresholds: unknown;
}

/** Builds a version from validated parts and names it by the hash of what it says. */
export function createMasteryRuleSet(props: MasteryRuleSetProps): Result<MasteryRuleSet, LearningError<MasteryRuleSetErrorCode>> {
  if (typeof props.ruleSetId !== 'string' || !UUID.test(props.ruleSetId)) {
    return err(Object.freeze({ kind: 'Validation', code: 'RULE_SET_REFERENCE_INVALID', message: 'ruleSetId is not an identifier' }));
  }
  if (props.taxonomyVersionId !== null && (typeof props.taxonomyVersionId !== 'string' || !UUID.test(props.taxonomyVersionId))) {
    return err(Object.freeze({ kind: 'Validation', code: 'RULE_SET_REFERENCE_INVALID', message: 'taxonomyVersionId is neither an identifier nor null' }));
  }
  if (!isWhole(props.versionNo, 1)) {
    return err(Object.freeze({ kind: 'Validation', code: 'RULE_SET_REFERENCE_INVALID', message: 'versionNo is a whole number from 1' }));
  }
  const thresholds = validateThresholds(props.thresholds);
  if (!thresholds.ok) return thresholds;
  return ok(
    Object.freeze({
      ruleSetId: props.ruleSetId,
      taxonomyVersionId: props.taxonomyVersionId,
      versionNo: props.versionNo,
      thresholds: thresholds.value,
      thresholdsHash: hashThresholds(thresholds.value),
    }),
  );
}
