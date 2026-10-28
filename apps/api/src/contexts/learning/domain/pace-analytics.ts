import type { DifficultyEstimate, EvidenceOutcome } from './mastery-evidence.js';
import type { PaceThresholds } from './mastery-rule-set.js';

/**
 * Time against outcome — slow-and-correct, slow-and-wrong, and slow-and-not-known (M7-46, DEC-M7-23, ADR-0054).
 *
 * **The reading is a pair of bounds, not a number.** A slot's `timeOnItemMs` is a lower bound on the time the learner spent: each visit → leave interval is cut to the
 * cap, and a visit that never closed counts as nothing (M7-45). What was cut is known, so the time was at most `timeOnItemMs + discardedMs` — and not at all bounded if a
 * visit never closed. A response is then:
 *
 * - **slow** if even the lower bound is above the line for its band. Truncation only makes the number smaller, so this holds however much was discarded.
 * - **fast** if even the upper bound is at or below the line. A slot that lost nothing has equal bounds, so it is one or the other.
 * - **unknown** otherwise: the lower bound is under the line and what was lost could carry it over. It is reported as unknown and is **never rounded into fast**.
 *
 * Whether a response is slow-and-correct or slow-and-wrong leads to different remediation — one knows it but not fluently, the other does not know it — so the outcome
 * is kept on every reading, and `unknown` is split by outcome as well. Only a response that was given is read: an unattempted slot says nothing about pace.
 *
 * The line is the rule set's (`PaceThresholds`), per authored difficulty band; this module holds no number.
 */
export type Pace = 'slow' | 'fast' | 'unknown';

export interface PaceSlot {
  readonly slotRef: string;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly difficultyEstimate: DifficultyEstimate;
  readonly outcome: EvidenceOutcome;
  readonly timeOnItemMs: number;
  readonly discardedMs: number;
  readonly unclosedVisits: number;
}

export interface SlotPace {
  readonly slotRef: string;
  readonly conceptIdentityId: string;
  readonly outcome: EvidenceOutcome;
  readonly pace: Pace;
  /** What was counted. */
  readonly atLeastMs: number;
  /** The most it can have been; `null` where a visit never closed and there is no bound. */
  readonly atMostMs: number | null;
}

/** How the readings of one concept fall. Every response given is in exactly one of the six. */
export interface ConceptPace {
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly slowCorrect: number;
  readonly slowWrong: number;
  readonly fastCorrect: number;
  readonly fastWrong: number;
  readonly unknownCorrect: number;
  readonly unknownWrong: number;
}

export interface PaceAnalytics {
  readonly slots: readonly SlotPace[];
  /** Concepts ordered by taxonomy version and identifier. */
  readonly concepts: readonly ConceptPace[];
}

export function paceOf(slot: PaceSlot, pace: PaceThresholds): SlotPace {
  const line = pace.slowAboveMs[slot.difficultyEstimate];
  const atMost = slot.unclosedVisits > 0 ? null : slot.timeOnItemMs + slot.discardedMs;
  const reading: Pace = slot.timeOnItemMs > line ? 'slow' : atMost !== null && atMost <= line ? 'fast' : 'unknown';
  return Object.freeze({ slotRef: slot.slotRef, conceptIdentityId: slot.conceptIdentityId, outcome: slot.outcome, pace: reading, atLeastMs: slot.timeOnItemMs, atMostMs: atMost });
}

const COUNTER = { slow: { correct: 'slowCorrect', incorrect: 'slowWrong' }, fast: { correct: 'fastCorrect', incorrect: 'fastWrong' }, unknown: { correct: 'unknownCorrect', incorrect: 'unknownWrong' } } as const;

export function paceAnalytics(slots: readonly PaceSlot[], pace: PaceThresholds): PaceAnalytics {
  const readings = slots.map((slot) => paceOf(slot, pace));
  const byConcept = new Map<string, { -readonly [K in keyof ConceptPace]: ConceptPace[K] }>();
  slots.forEach((slot, index) => {
    const key = `${slot.taxonomyVersionId}:${slot.conceptIdentityId}`;
    const held = byConcept.get(key) ?? {
      conceptIdentityId: slot.conceptIdentityId,
      taxonomyVersionId: slot.taxonomyVersionId,
      slowCorrect: 0,
      slowWrong: 0,
      fastCorrect: 0,
      fastWrong: 0,
      unknownCorrect: 0,
      unknownWrong: 0,
    };
    held[COUNTER[readings[index]!.pace][slot.outcome]] += 1;
    byConcept.set(key, held);
  });
  const concepts = [...byConcept.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, held]) => Object.freeze(held));
  return Object.freeze({ slots: Object.freeze(readings), concepts: Object.freeze(concepts) });
}
