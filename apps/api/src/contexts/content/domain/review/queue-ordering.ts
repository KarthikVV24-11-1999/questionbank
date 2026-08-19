/**
 * Queue ordering (DEC-M4-9) — UX §10.2's "batched by concept,
 * confidence-ordered", as one pure, total ordering function.
 *
 * **Precedence, in order:** escalated first → same primary concept as the
 * reviewer's last decision (batching) → confidence descending →
 * `stateEnteredAt` ascending (oldest first) → `itemVersionId` ascending, the
 * final tiebreak that makes the order total. Two candidates never compare
 * equal: if every other term ties, `itemVersionId` never does, because
 * assignment identity is unique by construction.
 *
 * **`confidence` is a declared input, not a computed one** (M4-03's
 * acceptance criterion). The caller supplies `blockingCount`, `warningCount`
 * and `duplicateCandidateCount` from M3's validation report and M4-10's
 * fingerprint match; this module folds them into one score and documents
 * that folding here so M5's AI pre-check confidence becomes an additional
 * term **in this function**, never a second ordering the two have to be kept
 * in sync with by hand.
 *
 * **`escalated` is a declared input for the same reason `confidence` is.**
 * Whether an item has crossed DEC-M4-1's escalation threshold is a function
 * of `stateEnteredAt`, `now` and a `ReviewPolicy` — M4-05's job, and M4-05
 * depends on M4-02, not the other way around. Computing it a second time
 * here would be exactly the duplicate-ordering trap the confidence note
 * above exists to avoid, so the assembler (M4-27) resolves it once and
 * supplies the fact. **No clock is read here** — there is nothing in this
 * module `now` could be read for.
 */

export interface QueueOrderingCandidate {
  readonly itemVersionId: string;
  readonly primaryConceptId?: string;
  readonly escalated: boolean;
  readonly blockingCount: number;
  readonly warningCount: number;
  readonly duplicateCandidateCount: number;
  /** ISO-8601 instant — when the version entered `in_review`. */
  readonly stateEnteredAt: string;
}

export interface QueueOrderingContext {
  /** The primary concept of the reviewer's last decision, or absent at the start of a session. */
  readonly lastDecidedConcept?: string;
}

/**
 * Lower is cleaner, so ascending order on this score puts the most confident
 * candidate first — "confidence descending" read the other way round.
 */
function confidenceScore(candidate: QueueOrderingCandidate): number {
  return candidate.blockingCount + candidate.warningCount + candidate.duplicateCandidateCount;
}

function escalationRank(candidate: QueueOrderingCandidate): 0 | 1 {
  return candidate.escalated ? 0 : 1;
}

function conceptRank(candidate: QueueOrderingCandidate, context: QueueOrderingContext): 0 | 1 {
  if (context.lastDecidedConcept === undefined) return 1;
  return candidate.primaryConceptId === context.lastDecidedConcept ? 0 : 1;
}

function compare(a: QueueOrderingCandidate, b: QueueOrderingCandidate, context: QueueOrderingContext): number {
  const escalation = escalationRank(a) - escalationRank(b);
  if (escalation !== 0) return escalation;

  const concept = conceptRank(a, context) - conceptRank(b, context);
  if (concept !== 0) return concept;

  const confidence = confidenceScore(a) - confidenceScore(b);
  if (confidence !== 0) return confidence;

  if (a.stateEnteredAt !== b.stateEnteredAt) {
    return a.stateEnteredAt < b.stateEnteredAt ? -1 : 1;
  }

  if (a.itemVersionId === b.itemVersionId) return 0;
  return a.itemVersionId < b.itemVersionId ? -1 : 1;
}

/**
 * Total and deterministic: two calls over the same input, in any starting
 * order, produce byte-identical results — proven over a shuffled fixture
 * across 100 runs in `queue-ordering.spec.ts`.
 */
export function orderCandidates(
  candidates: readonly QueueOrderingCandidate[],
  context: QueueOrderingContext,
): readonly QueueOrderingCandidate[] {
  return [...candidates].sort((a, b) => compare(a, b, context));
}
