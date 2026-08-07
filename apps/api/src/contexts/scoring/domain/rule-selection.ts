import { err, ok, type Result } from './result.js';
import { ruleViolationError, type ScoringError } from './scoring-error.js';
import type { AnswerKey } from './answer-key.js';
import type { MarkingRuleData, MarkingRuleSetData } from './marking-rule-data.js';
import type { ScoredSlot } from './scoring-input.js';
import { evaluateCondition } from './conditions/evaluate-condition.js';

/**
 * Rule selection (ASSESSMENT-ENGINE §3): first matching rule wins, and
 * evaluation stops there. That is what makes every outcome attributable to
 * exactly one rule.
 *
 * **Order is semantic and is never touched.** The rules are evaluated in the
 * order the author wrote them, as persistence preserved them. Sorting them —
 * by specificity, by id, by anything — would silently rewrite the marking
 * scheme of every published profile.
 */

export type RuleSelectionErrorCode = 'RULE_SET_EXHAUSTED';

export type RuleSelectionError = ScoringError<RuleSelectionErrorCode>;

export interface SelectedRule {
  readonly rule: MarkingRuleData;
  /** How many rules were tried. The proof that evaluation stopped at the match. */
  readonly rulesEvaluated: number;
  /**
   * Whether any condition along the way could not be decided. The slot fell
   * through to the terminal rule because the engine could not read the
   * response, not because the response was wrong — a distinction the
   * `ItemOutcome` must record (ADR-0003).
   */
  readonly sawIndeterminate: boolean;
}

/** Whether a rule governs this slot at all, before its condition is considered. */
export function ruleApplies(rule: MarkingRuleData, itemType: string, sectionOrdinal: number): boolean {
  if (!rule.appliesTo.itemTypes.includes(itemType)) return false;
  const ordinals = rule.appliesTo.sectionOrdinals;
  // An absent ordinal list means every section, not no section.
  return ordinals === undefined || ordinals.includes(sectionOrdinal);
}

export function selectRule(
  ruleSet: MarkingRuleSetData,
  slot: ScoredSlot,
  sectionOrdinal: number,
  key: AnswerKey,
): Result<SelectedRule, RuleSelectionError> {
  let rulesEvaluated = 0;
  let sawIndeterminate = false;

  for (const rule of ruleSet.rules) {
    if (!ruleApplies(rule, slot.itemType, sectionOrdinal)) continue;

    rulesEvaluated += 1;
    const outcome = evaluateCondition(rule.condition, slot, key);

    if (outcome === 'indeterminate') {
      sawIndeterminate = true;
      continue;
    }
    if (outcome === 'matched') {
      return ok(Object.freeze({ rule, rulesEvaluated, sawIndeterminate }));
    }
  }

  // §3: a slot matching no rule is a hard error, not a zero. A silent zero is
  // an undetectable scoring defect — it looks exactly like a deliberate award
  // of nothing. F46 guarantees a terminal ALWAYS, so reaching here means the
  // rule set does not govern this slot at all.
  return err(
    ruleViolationError(
      'RULE_SET_EXHAUSTED',
      `no marking rule matched slot ${slot.slotId} (item type ${slot.itemType}, section ${sectionOrdinal})`,
    ),
  );
}
