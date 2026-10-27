import { decayedTo, deriveConceptState, type ConceptEvidence, type ConceptState } from './concept-state.js';
import type { MasteryThresholds } from './mastery-rule-set.js';

/**
 * `ConceptMap` — one learner's concept states under one taxonomy version (M7-14, D7): the product's core state, and the source of the north-star metric.
 *
 * One aggregate per learner and taxonomy version, because the learner's whole state is what changes together after an attempt. It holds no evidence of its own
 * beyond the identifiers each state is derived from: the evidence rows are stored durably and the map is **rebuilt from them** (`conceptMapOf`), which is
 * what makes it safe to change this logic and recompute (D-007). DOMAIN-MODEL keeps a bounded window of evidence inline; that is the aggregate's shape, and
 * the rows behind it are what M7's first acceptance line — every concept state is traceable to the specific responses that produced it — rests on.
 *
 * It is read with decay (`readConceptMap`), computed against the instant of the read, so a strong state that has gone quiet reads as developing without
 * anything having been scheduled (DEC-M7-8).
 */
export interface ConceptMap {
  readonly learnerRef: string;
  readonly taxonomyVersionId: string;
  /** Ordered by concept identity, so the same map always serialises the same way. */
  readonly conceptStates: readonly ConceptState[];
  readonly lastRecomputedAt: string;
}

/** Builds the map from each concept's evidence. A concept with no evidence is not in it: unassessed is the absence of a state. */
export function conceptMapOf(
  learnerRef: string,
  taxonomyVersionId: string,
  evidenceByConcept: ReadonlyMap<string, readonly ConceptEvidence[]>,
  thresholds: MasteryThresholds,
  asOf: string,
): ConceptMap {
  const states = [...evidenceByConcept]
    .filter(([, evidence]) => evidence.length > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([conceptIdentityId, evidence]) => deriveConceptState(conceptIdentityId, evidence, thresholds, asOf));
  return Object.freeze({ learnerRef, taxonomyVersionId, conceptStates: Object.freeze(states), lastRecomputedAt: asOf });
}

/** The same map read at another instant: every state decayed to it, nothing re-derived. */
export function readConceptMap(map: ConceptMap, thresholds: MasteryThresholds, asOf: string): ConceptMap {
  return Object.freeze({ ...map, conceptStates: Object.freeze(map.conceptStates.map((state) => decayedTo(state, thresholds, asOf))) });
}

/** One concept's state, or `null` where the learner has none: the caller says "unassessed", the map does not invent a row. */
export function stateOf(map: ConceptMap, conceptIdentityId: string): ConceptState | null {
  return map.conceptStates.find((state) => state.conceptIdentityId === conceptIdentityId) ?? null;
}
