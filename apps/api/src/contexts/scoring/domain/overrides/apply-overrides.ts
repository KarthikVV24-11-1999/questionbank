import type { AnswerKey } from '../answer-key.js';
import type { ScoredSlot, ScoringInput, SlotOverride } from '../scoring-input.js';

/**
 * Item-level overrides (ASSESSMENT-ENGINE §2.5), applied **before** rule
 * evaluation — the first step of §3's fixed execution order.
 *
 * `DROPPED` and `BONUS` slots never reach the rule loop at all. That is not an
 * optimisation: a dropped slot has no rule outcome to record, and a bonus slot
 * must pay regardless of what any rule would have said. Routing them through
 * the loop would mean a rule could contradict the override.
 *
 * An override naming an unknown slot, or two overrides on one slot, cannot
 * reach this function: `createScoringInput` rejects both, so the invalid state
 * is unconstructible rather than merely unhandled (DEC-3).
 */
export type SlotDisposition =
  | { readonly kind: 'SCORE_NORMALLY'; readonly key: AnswerKey }
  | { readonly kind: 'DROPPED'; readonly reason: string }
  | { readonly kind: 'BONUS'; readonly reason: string };

export function disposeSlot(slot: ScoredSlot, override: SlotOverride | undefined): SlotDisposition {
  if (override === undefined) {
    return { kind: 'SCORE_NORMALLY', key: slot.answerKey };
  }

  switch (override.kind) {
    case 'DROPPED':
      return { kind: 'DROPPED', reason: override.reason };

    case 'BONUS':
      return { kind: 'BONUS', reason: override.reason };

    case 'KEY_CORRECTED':
      // The corrected key replaces the authored one and rules then evaluate
      // normally. An upheld key challenge changes what "correct" means, not
      // how the paper is marked.
      return { kind: 'SCORE_NORMALLY', key: override.replacementKey };
  }
}

/** Overrides indexed by slot, for the executor's single pass. */
export function overridesBySlotId(input: ScoringInput): ReadonlyMap<string, SlotOverride> {
  return new Map(input.overrides.map((override) => [override.slotId, override]));
}
