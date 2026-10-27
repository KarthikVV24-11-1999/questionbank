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
 */
export interface PracticeSelectionInput {
  readonly candidates: readonly AssemblyCandidate[];
  readonly policy: PracticePolicy;
  /** For the targeted strategy: the concepts Learning named. Overrides the policy's own concept scope. */
  readonly targetConceptIds?: readonly string[];
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
  const eligible = input.candidates.filter(
    (candidate) =>
      candidate.isPublished &&
      !candidate.isAnchor &&
      !input.inRunItemIds.has(candidate.itemId) &&
      (!input.policy.excludeRecentlySeen || !input.seenItemIds.has(candidate.itemId)) &&
      (concepts.size === 0 || candidate.conceptIdentityIds.some((concept) => concepts.has(concept))) &&
      (types.size === 0 || types.has(candidate.itemType)) &&
      (input.policy.difficultyBand === null || candidate.difficultyBand === input.policy.difficultyBand),
  );
  const ordered = [...eligible].sort(
    (a, b) => (input.exposure.get(a.itemVersionId) ?? 0) - (input.exposure.get(b.itemVersionId) ?? 0) || (a.itemVersionId < b.itemVersionId ? -1 : 1),
  );
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
