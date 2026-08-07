import type { Condition, MarkingRuleData } from './marking-rule-data.js';
import type { ResponseSnapshot, ScoredSlot } from './scoring-input.js';
import { isNegative, isZero, makeRational, rationalToDecimalString, type Rational } from './numeric/decimal.js';

/**
 * One slot's result (DOMAIN-MODEL §7).
 *
 * **`ruleApplied` is not optional.** F47 requires every outcome to name the
 * rule that produced it, and a type that cannot be constructed without one
 * enforces that at compile time rather than leaving it to a checker to notice
 * afterwards. An outcome nobody can explain is a score nobody can defend
 * (FR-MOCK-07).
 */

export const CORRECTNESS_VALUES = [
  'correct',
  'incorrect',
  'unattempted',
  'dropped',
  'bonus',
  'indeterminate',
] as const;

export type Correctness = (typeof CORRECTNESS_VALUES)[number];

export interface RuleAttribution {
  readonly ruleId: string;
  readonly explanation: string;
}

export interface ItemOutcome {
  readonly slotId: string;
  /** Position in the paper. Carried so a reconstituted record reads in paper order. */
  readonly sectionOrdinal: number;
  readonly slotOrdinal: number;
  readonly itemVersionId: string;
  /** Absent when the slot was unattempted. Never carries key or solution material (§9 rule 10). */
  readonly responseSnapshot?: ResponseSnapshot;
  readonly correctness: Correctness;
  readonly marksAwarded: Rational;
  /** What the slot was worth. Zero for a dropped slot, which leaves the total available. */
  readonly marksAvailable: Rational;
  readonly ruleApplied: RuleAttribution;
}

/** Overrides are not rules, so they are attributed under their own reserved ids. */
export const OVERRIDE_RULE_IDS = Object.freeze({
  DROPPED: 'override:DROPPED',
  BONUS: 'override:BONUS',
});

function marksPhrase(marks: Rational): string {
  const rendered = rationalToDecimalString(marks);
  const magnitude = rendered.replace('-', '');
  const noun = magnitude === '1' ? 'mark' : 'marks';
  if (isZero(marks)) return `0 ${noun}`;
  return isNegative(marks) ? `−${magnitude} ${noun}` : `+${magnitude} ${noun}`;
}

function conditionPhrase(condition: Condition): string {
  switch (condition.kind) {
    case 'UNATTEMPTED':
      return 'unattempted';
    case 'EXACT_MATCH':
      return 'correct';
    case 'NO_MATCH':
      return 'incorrect';
    case 'ALL_CORRECT_SELECTED':
      return 'every correct option selected';
    case 'PARTIAL_CORRECT_SELECTED':
      return `at least ${condition.minCorrect} correct selected${condition.noIncorrect ? ', none incorrect' : ''}`;
    case 'ANY_INCORRECT_SELECTED':
      return 'an incorrect option selected';
    case 'MATCHING_PAIRS_CORRECT':
      return `${condition.count} pairs matched correctly`;
    case 'ALWAYS':
      return 'no other rule applied';
    default:
      return 'condition not recognised';
  }
}

/**
 * The explanation a learner reads next to the mark. Derived from the condition
 * and the award rather than written per rule, so it can never disagree with
 * what actually happened.
 */
export function explain(condition: Condition, marks: Rational, sawIndeterminate: boolean): string {
  const base = `${conditionPhrase(condition)} → ${marksPhrase(marks)}`;
  return sawIndeterminate ? `${base} (the response could not be evaluated, so no mark was deducted)` : base;
}

function deriveCorrectness(condition: Condition, response: ResponseSnapshot | undefined, sawIndeterminate: boolean): Correctness {
  if (sawIndeterminate) return 'indeterminate';

  switch (condition.kind) {
    case 'UNATTEMPTED':
      return 'unattempted';
    case 'EXACT_MATCH':
    case 'ALL_CORRECT_SELECTED':
    case 'PARTIAL_CORRECT_SELECTED':
    case 'MATCHING_PAIRS_CORRECT':
      return 'correct';
    case 'NO_MATCH':
    case 'ANY_INCORRECT_SELECTED':
      return 'incorrect';
    default:
      // A terminal ALWAYS reached with a response present means no authored
      // rule described what the learner did. From the candidate's side that is
      // indeterminate, not wrong — and it awards 0 either way.
      return response === undefined ? 'unattempted' : 'indeterminate';
  }
}

export interface OutcomeFromRuleProps {
  readonly slot: ScoredSlot;
  readonly sectionOrdinal: number;
  readonly rule: MarkingRuleData;
  readonly marksAwarded: Rational;
  readonly marksAvailable: Rational;
  readonly sawIndeterminate: boolean;
}

export function outcomeFromRule(props: OutcomeFromRuleProps): ItemOutcome {
  const { slot, sectionOrdinal, rule, marksAwarded, marksAvailable, sawIndeterminate } = props;
  return Object.freeze({
    slotId: slot.slotId,
    sectionOrdinal,
    slotOrdinal: slot.ordinal,
    itemVersionId: slot.itemVersionId,
    ...(slot.response !== undefined ? { responseSnapshot: slot.response } : {}),
    correctness: deriveCorrectness(rule.condition, slot.response, sawIndeterminate),
    marksAwarded,
    marksAvailable,
    ruleApplied: Object.freeze({
      ruleId: rule.id,
      explanation: explain(rule.condition, marksAwarded, sawIndeterminate),
    }),
  });
}

/** A dropped slot leaves both the awarded and the available total (§2.5). */
export function droppedOutcome(slot: ScoredSlot, sectionOrdinal: number, reason: string): ItemOutcome {
  return Object.freeze({
    slotId: slot.slotId,
    sectionOrdinal,
    slotOrdinal: slot.ordinal,
    itemVersionId: slot.itemVersionId,
    ...(slot.response !== undefined ? { responseSnapshot: slot.response } : {}),
    correctness: 'dropped' as const,
    marksAwarded: makeRational(0n, 1n),
    marksAvailable: makeRational(0n, 1n),
    ruleApplied: Object.freeze({
      ruleId: OVERRIDE_RULE_IDS.DROPPED,
      explanation: `item dropped → excluded from the total (${reason})`,
    }),
  });
}

/** A bonus slot pays full marks to every attempt, answered or not (§2.5). */
export function bonusOutcome(
  slot: ScoredSlot,
  sectionOrdinal: number,
  marks: Rational,
  reason: string,
): ItemOutcome {
  return Object.freeze({
    slotId: slot.slotId,
    sectionOrdinal,
    slotOrdinal: slot.ordinal,
    itemVersionId: slot.itemVersionId,
    ...(slot.response !== undefined ? { responseSnapshot: slot.response } : {}),
    correctness: 'bonus' as const,
    marksAwarded: marks,
    marksAvailable: marks,
    ruleApplied: Object.freeze({
      ruleId: OVERRIDE_RULE_IDS.BONUS,
      explanation: `item marked bonus → ${marksPhrase(marks)} to every attempt (${reason})`,
    }),
  });
}
