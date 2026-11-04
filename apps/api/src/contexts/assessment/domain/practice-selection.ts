import type { AssemblyCandidate } from './assembly.js';
import type { PracticePolicy } from './delivery-policy.js';

/**
 * **Which items a practice run is given** (M7-28, M7-29). A pure function of the published catalogue, the exposure counts, what the learner has been
 * given before, and the policy — it reads no clock, no random source and no store, so the same inputs choose the same items.
 *
 * What it will not do, and why:
 *
 *  - **It never offers an anchor.** Anchors are the items that tie one mock to the next; a practice run that burned them would defeat the reason they
 *    exist. The exposure ledger counts a practice delivery (M7-30), so an anchor offered here would spend its cap.
 *  - **It never repeats an item inside a run**, whatever the policy says.
 *  - **It knows concepts only as identifiers.** For the targeted strategy the concepts arrive from Learning as `conceptIdentityIds`; this function does
 *    not know why they were chosen, and Learning never learns which items they led to.
 *
 * The order is the least-exposed first, then by version id: a deterministic spread of the load across the corpus rather than a random one, which a
 * test can assert and a reviewer can reason about. Randomness, when a product reason for it appears, is an input and not a call.
 *
 * **`breadth` takes that same order round-robin across concepts** (M8-31, FR-STU-03 rule 1, the diagnostic): one item for each concept in force before a second for any, the concepts in identifier order, and
 * within a concept the order above. Eligibility is not touched; only the order items are taken in. The concepts in force are those the policy or the learner's declared scope names (where both are given, the
 * ones in both), or, with neither, every concept the eligible items are about. An item about several concepts is taken once and counts for the one whose turn took it; an item whose concepts are none of those in
 * force cannot be placed in a round and is not taken. Rule 1 also says *high-leverage* concepts, and nothing here honours that: no per-concept weight exists to order by, and a proxy for one would be a guess
 * that reads as a fact (D115 in docs/DEBT.md). Which concepts a short run reaches is therefore decided by identifier order, and the run is breadth within scope and no more.
 */
export interface PracticeSelectionInput {
  readonly candidates: readonly AssemblyCandidate[];
  readonly policy: PracticePolicy;
  /** For the targeted strategy: the concepts Learning named. Overrides the policy's own concept scope. */
  readonly targetConceptIds?: readonly string[];
  /**
   * The concepts the learner declared they have studied (M8-21). When present, an item is eligible only if it is about one of them, on top of whatever else the policy asks.
   * Absent means no scope is in force. This function is only ever called for a practice run; the assembly of a mock does not pass through it.
   */
  readonly scopeConceptIds?: readonly string[];
  /** Item ids the learner has been given in an earlier run. Honoured only when the policy excludes recently seen items. */
  readonly seenItemIds: ReadonlySet<string>;
  /** Item ids already in this run. */
  readonly inRunItemIds: ReadonlySet<string>;
  /** Placements per item version, from the ledger. Absent means none. */
  readonly exposure: ReadonlyMap<string, number>;
  readonly count: number;
}

export function selectPracticeItems(input: PracticeSelectionInput): readonly AssemblyCandidate[] {
  const concepts = new Set(input.targetConceptIds ?? input.policy.scopeFilter.conceptIdentityIds);
  const types = new Set(input.policy.scopeFilter.itemTypes);
  const studied = input.scopeConceptIds === undefined ? null : new Set(input.scopeConceptIds);
  const eligible = input.candidates.filter(
    (candidate) =>
      candidate.isPublished &&
      !candidate.isAnchor &&
      !input.inRunItemIds.has(candidate.itemId) &&
      (!input.policy.excludeRecentlySeen || !input.seenItemIds.has(candidate.itemId)) &&
      (concepts.size === 0 || candidate.conceptIdentityIds.some((concept) => concepts.has(concept))) &&
      (studied === null || candidate.conceptIdentityIds.some((concept) => studied.has(concept))) &&
      (types.size === 0 || types.has(candidate.itemType)) &&
      (input.policy.difficultyBand === null || candidate.difficultyBand === input.policy.difficultyBand),
  );
  const ordered = [...eligible].sort(
    (a, b) => (input.exposure.get(a.itemVersionId) ?? 0) - (input.exposure.get(b.itemVersionId) ?? 0) || (a.itemVersionId < b.itemVersionId ? -1 : 1),
  );
  if (input.policy.selectionStrategy === 'breadth') {
    const inForce = (candidate: AssemblyCandidate): string[] =>
      candidate.conceptIdentityIds.filter((concept) => (concepts.size === 0 || concepts.has(concept)) && (studied === null || studied.has(concept)));
    return Object.freeze(roundRobin(ordered, inForce, input.count));
  }
  // One item once, even where the catalogue lists two versions of it.
  const taken = new Set<string>();
  const chosen: AssemblyCandidate[] = [];
  for (const candidate of ordered) {
    if (chosen.length === input.count) break;
    if (taken.has(candidate.itemId)) continue;
    taken.add(candidate.itemId);
    chosen.push(candidate);
  }
  return Object.freeze(chosen);
}

/**
 * One item for each concept before a second for any. Each concept has a queue of the items about it, in the order they arrived in; a round gives every concept, in identifier order, the first item of its queue that is
 * not already taken (by another concept, or as another version of the same item). It ends when `count` are chosen or no queue has an item left.
 */
function roundRobin(ordered: readonly AssemblyCandidate[], conceptsOf: (candidate: AssemblyCandidate) => string[], count: number): AssemblyCandidate[] {
  const queues = new Map<string, AssemblyCandidate[]>();
  for (const candidate of ordered) {
    for (const concept of conceptsOf(candidate)) queues.set(concept, [...(queues.get(concept) ?? []), candidate]);
  }
  const turns = [...queues.keys()].sort();
  const taken = new Set<string>();
  const chosen: AssemblyCandidate[] = [];
  let progressed = true;
  while (chosen.length < count && progressed) {
    progressed = false;
    for (const concept of turns) {
      if (chosen.length === count) break;
      const queue = queues.get(concept) as AssemblyCandidate[];
      while (queue.length > 0 && taken.has((queue[0] as AssemblyCandidate).itemId)) queue.shift();
      const next = queue.shift();
      if (next === undefined) continue;
      taken.add(next.itemId);
      chosen.push(next);
      progressed = true;
    }
  }
  return chosen;
}
