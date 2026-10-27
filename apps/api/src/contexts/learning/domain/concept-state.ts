import { DIFFICULTY_ESTIMATES, type DifficultyEstimate, type EvidenceOutcome } from './mastery-evidence.js';
import type { MasteryThresholds } from './mastery-rule-set.js';

/**
 * `ConceptState` — what one learner knows about one concept, derived from the evidence and from nothing else (M7-14, DOMAIN-MODEL 12.2).
 *
 * **A pure function of evidence, thresholds and an instant.** The state is never edited: it is derived, so it can be rebuilt from the evidence rows after a
 * defect in this logic (D-007), and every state is traceable to the specific responses that produced it (`evidenceIds`) — M7's first acceptance line.
 *
 * **Promotion to `strong` needs all of** (D-002): enough responses, across enough distinct items, across enough distinct sessions, with recent accuracy at or
 * above the floor, and enough of the recent responses on items at or above the band the learner has demonstrated. Every number is the rule set's.
 *
 * **`difficultyBandDemonstrated`** is the highest authored band the learner answered correctly among the recent responses (DEC-M7-3). It is an author's
 * estimate and not a measured value (D71). "Distinct items" counts item versions: evidence carries no item identity above its version.
 *
 * **Decay is computed at read, not applied by a sweep** (DEC-M7-8). Confidence is its evidence-built part, `baseConfidence`, times a recency factor that
 * halves every half-life since the last evidence. A `strong` state whose confidence falls below the floor reads as `developing`. Nothing is scheduled, no row
 * goes stale, and `decayAppliedAt` records the instant a read was computed against, not when a job ran. `decayedTo` and `deriveConceptState` are two paths to
 * that read, and `concept-state.spec.ts` holds them to each other.
 *
 * Distinct, in one place: `weak` is a state with evidence whose recent accuracy is below the rule set's line, `developing` is any other state with evidence
 * that has not been promoted, and `unassessed` is no evidence at all.
 */
export const MASTERY_STATES = ['unassessed', 'weak', 'developing', 'strong'] as const;
export type MasteryState = (typeof MASTERY_STATES)[number];

/** What a concept's state is derived from: one response, with the session it was placed in. */
export interface ConceptEvidence {
  readonly evidenceId: string;
  readonly itemVersionRef: string;
  readonly outcome: EvidenceOutcome;
  readonly difficultyEstimate: DifficultyEstimate;
  /** The instant of the response (M7-11). */
  readonly occurredAt: string;
  readonly sessionId: string;
}

export interface ConceptState {
  readonly conceptIdentityId: string;
  /** What a read at `decayAppliedAt` says. */
  readonly state: MasteryState;
  /** The state before decay: what the evidence alone supports. */
  readonly rawState: MasteryState;
  /** `baseConfidence` times the recency factor at `decayAppliedAt`, in [0, 1]. */
  readonly confidence: number;
  readonly baseConfidence: number;
  /** FR-STU-04: below the evidence threshold a state is reported as low-confidence, never asserted. */
  readonly lowConfidence: boolean;
  readonly evidenceCount: number;
  readonly distinctItemCount: number;
  readonly distinctSessionCount: number;
  readonly lastEvidenceAt: string | null;
  readonly difficultyBandDemonstrated: DifficultyEstimate | null;
  /** The instant this read was computed against. */
  readonly decayAppliedAt: string;
  /** Every response the state is derived from, in the order they were given. */
  readonly evidenceIds: readonly string[];
}

const DAY_MS = 86_400_000;
const bandRank = (band: DifficultyEstimate): number => DIFFICULTY_ESTIMATES.indexOf(band);
const at = (instant: string): number => Date.parse(instant);

/** The canonical order: when they were given, then by identifier, so the same evidence always derives the same state. */
export function inGivenOrder<T extends { readonly occurredAt: string; readonly evidenceId: string }>(evidence: readonly T[]): T[] {
  return [...evidence].sort((a, b) => at(a.occurredAt) - at(b.occurredAt) || (a.evidenceId < b.evidenceId ? -1 : 1));
}

export interface Promotion {
  readonly qualifies: boolean;
  /** The recent responses the accuracy and the band clause were measured over. */
  readonly window: readonly ConceptEvidence[];
  readonly band: DifficultyEstimate | null;
}

/** Whether the five clauses of D-002 hold for this evidence, in the given order. */
export function assessPromotion(ordered: readonly ConceptEvidence[], thresholds: MasteryThresholds): Promotion {
  const p = thresholds.promotion;
  const window = ordered.slice(-p.recentWindow);
  const correct = window.filter((e) => e.outcome === 'correct');
  const band = correct.length === 0 ? null : correct.map((e) => e.difficultyEstimate).reduce((a, b) => (bandRank(a) >= bandRank(b) ? a : b));
  const atBand = band === null ? 0 : window.filter((e) => bandRank(e.difficultyEstimate) >= bandRank(band)).length;
  const accuracy = window.length === 0 ? 0 : correct.length / window.length;
  const qualifies =
    ordered.length >= p.minResponses &&
    new Set(ordered.map((e) => e.itemVersionRef)).size >= p.minDistinctItems &&
    new Set(ordered.map((e) => e.sessionId)).size >= p.minDistinctSessions &&
    accuracy >= p.minRecentAccuracy &&
    atBand >= p.minRecentAtDemonstratedBand;
  return Object.freeze({ qualifies, window: Object.freeze(window), band });
}

function recency(lastEvidenceAt: string, asOf: string, thresholds: MasteryThresholds): number {
  const days = Math.max(0, (at(asOf) - at(lastEvidenceAt)) / DAY_MS);
  return Math.pow(0.5, days / thresholds.decay.halfLifeDays);
}

function read(
  raw: MasteryState,
  baseConfidence: number,
  lastEvidenceAt: string | null,
  asOf: string,
  thresholds: MasteryThresholds,
): { state: MasteryState; confidence: number } {
  if (lastEvidenceAt === null) return { state: raw, confidence: 0 };
  const confidence = baseConfidence * recency(lastEvidenceAt, asOf, thresholds);
  return { state: raw === 'strong' && confidence < thresholds.decay.confidenceFloor ? 'developing' : raw, confidence };
}

export function deriveConceptState(
  conceptIdentityId: string,
  evidence: readonly ConceptEvidence[],
  thresholds: MasteryThresholds,
  asOf: string,
): ConceptState {
  const ordered = inGivenOrder(evidence);
  const last = ordered.at(-1);
  const p = thresholds.promotion;

  const items = new Set(ordered.map((e) => e.itemVersionRef)).size;
  const sessions = new Set(ordered.map((e) => e.sessionId)).size;
  const promotion = assessPromotion(ordered, thresholds);
  const accuracy = promotion.window.length === 0 ? 0 : promotion.window.filter((e) => e.outcome === 'correct').length / promotion.window.length;

  const rawState: MasteryState =
    last === undefined ? 'unassessed' : promotion.qualifies ? 'strong' : accuracy < thresholds.states.weakBelowAccuracy ? 'weak' : 'developing';

  const bands = new Set(ordered.map((e) => e.difficultyEstimate)).size;
  const baseConfidence =
    last === undefined
      ? 0
      : (Math.min(1, ordered.length / p.minResponses) + Math.min(1, sessions / p.minDistinctSessions) + Math.min(1, items / p.minDistinctItems) + bands / DIFFICULTY_ESTIMATES.length) / 4;

  const lastEvidenceAt = last?.occurredAt ?? null;
  const decayed = read(rawState, baseConfidence, lastEvidenceAt, asOf, thresholds);

  return Object.freeze({
    conceptIdentityId,
    state: decayed.state,
    rawState,
    confidence: decayed.confidence,
    baseConfidence,
    lowConfidence: ordered.length < p.minResponses,
    evidenceCount: ordered.length,
    distinctItemCount: items,
    distinctSessionCount: sessions,
    lastEvidenceAt,
    difficultyBandDemonstrated: promotion.band,
    decayAppliedAt: asOf,
    evidenceIds: Object.freeze(ordered.map((e) => e.evidenceId)),
  });
}

/** The same state read at a later instant, from the state alone: the second path to a decayed read. */
export function decayedTo(state: ConceptState, thresholds: MasteryThresholds, asOf: string): ConceptState {
  const decayed = read(state.rawState, state.baseConfidence, state.lastEvidenceAt, asOf, thresholds);
  return Object.freeze({ ...state, state: decayed.state, confidence: decayed.confidence, decayAppliedAt: asOf });
}
