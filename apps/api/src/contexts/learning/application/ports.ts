import type { MasteryEvidence } from '../domain/mastery-evidence.js';

/**
 * Where Learning's evidence comes from — a port Learning defines and does not implement (M7-04).
 *
 * The implementation lives in `platform/composition/`, which reads scoring and content through the two seams each offers and
 * joins them (M7-05). Learning therefore has no production import of either context, and no event it consumes has to carry a
 * copy of what the owning context knows (DEC-M7-1).
 */

/** The `AttemptScored` fact the evidence is assembled for: identifiers and an instant, nothing of the score. */
export interface ScoredAttemptRef {
  readonly attemptId: string;
  readonly scoreRecordId: string;
  /** When the attempt was scored; the instant the evidence is attributed to. */
  readonly occurredAt: string;
}

/** What assembly decided about a scored attempt, so a response left out is counted and not silently lost. */
export interface AssembledEvidence {
  readonly evidence: readonly MasteryEvidence[];
  /** Slots that were not evidence: unattempted, dropped, bonus, indeterminate. */
  readonly notEvidence: number;
}

export type EvidenceSourceFailure =
  | { readonly code: 'ATTEMPT_NOT_SCORED'; readonly message: string }
  | { readonly code: 'ITEM_VERSION_UNRESOLVED'; readonly message: string; readonly itemVersionIds: readonly string[] }
  | { readonly code: 'SOURCE_UNAVAILABLE'; readonly message: string };

export type EvidenceSourceResult =
  | { readonly ok: true; readonly value: AssembledEvidence }
  | { readonly ok: false; readonly error: EvidenceSourceFailure };

export interface MasteryEvidenceSource {
  /**
   * The evidence one scored attempt implies. **All or nothing**: an attempt with a slot whose item version cannot be resolved
   * yields a failure naming it, never the evidence for the others, because a mastery update from part of an attempt is a
   * wrong update that nothing would flag.
   */
  evidenceForScoredAttempt(attempt: ScoredAttemptRef): Promise<EvidenceSourceResult>;
}
