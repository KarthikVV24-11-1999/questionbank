import { err, ok, type Result } from './result.js';
import { preconditionFailedError, type ScoringError } from './scoring-error.js';
import type { AggregationSpecData } from './aggregation-data.js';
import type { MarkingRuleSetData } from './marking-rule-data.js';
import type { ScoringInput } from './scoring-input.js';
import { disposeSlot, overridesBySlotId } from './overrides/apply-overrides.js';
import type { AnswerKey } from './answer-key.js';
import type { ScoredSlot } from './scoring-input.js';
import { selectRule } from './rule-selection.js';
import { applyAward } from './awards/apply-award.js';
import { bonusOutcome, droppedOutcome, outcomeFromRule, type ItemOutcome } from './item-outcome.js';
import { aggregateSection, aggregateTotal, type SectionScore } from './aggregate-scores.js';
import { createScoreRecord, type ScoreRecord, type ScoreRecordError } from './score-record.js';
import type { ApplyAwardError } from './awards/apply-award.js';
import type { RuleSelectionError } from './rule-selection.js';

/**
 * `(ScoringInput, MarkingRuleSetData, AggregationSpec) -> ScoreRecord`.
 *
 * ASSESSMENT-ENGINE §3's pure function. No clock, no randomness, no I/O, no
 * module-level state: determinism (REL-03) is only provable if nothing outside
 * the inputs can influence the output, so `computedAt` and the record id are
 * supplied by the caller rather than generated here.
 *
 * **Execution order is fixed** — overrides, then per-slot rule evaluation, then
 * sectional aggregation, then total. A fixed order removes the whole class of
 * ordering bugs, and the order is asserted by test rather than left to be read
 * off the code.
 */

export type ScoreAttemptErrorCode = 'RULE_SET_NOT_PINNED';

export type ScoreAttemptError =
  | ScoringError<ScoreAttemptErrorCode>
  | RuleSelectionError
  | ApplyAwardError
  | ScoreRecordError;

export interface ScoreAttemptProps {
  readonly input: ScoringInput;
  readonly ruleSet: MarkingRuleSetData;
  readonly ruleSetHash: string;
  readonly aggregation: AggregationSpecData;
  /** Supplied, never read from a clock (F45). */
  readonly computedAt: string;
  readonly scoreRecordId: string;
  readonly generation?: number;
  readonly supersedesScoreRecordId?: string;
  readonly reasonForRescore?: string;
}

export function scoreAttempt(props: ScoreAttemptProps): Result<ScoreRecord, ScoreAttemptError> {
  const { input, ruleSet, ruleSetHash, aggregation } = props;

  // Scoring under a rule set the attempt was not pinned to would produce a
  // record whose hash certifies rules that never ran.
  if (input.pin.markingRuleSetHash !== ruleSetHash) {
    return err(
      preconditionFailedError(
        'RULE_SET_NOT_PINNED',
        `attempt ${input.attemptId} is pinned to rule set ${input.pin.markingRuleSetHash}, not ${ruleSetHash}`,
      ),
    );
  }

  const overrides = overridesBySlotId(input);
  const allOutcomes: ItemOutcome[] = [];
  const sectionScores: SectionScore[] = [];

  for (const section of input.sections) {
    const outcomes: ItemOutcome[] = [];

    for (const slot of section.slots) {
      const marksAvailable = slot.marksAvailableExact;
      const disposition = disposeSlot(slot, overrides.get(slot.slotId));

      if (disposition.kind === 'DROPPED') {
        outcomes.push(droppedOutcome(slot, section.ordinal, disposition.reason));
        continue;
      }

      if (disposition.kind === 'BONUS') {
        outcomes.push(bonusOutcome(slot, section.ordinal, marksAvailable, disposition.reason));
        continue;
      }

      const selected = selectRule(ruleSet, slot, section.ordinal, disposition.key);
      if (!selected.ok) return err(selected.error);

      const correctSelectionCount = countCorrectSelections(slot, disposition.key);
      const awarded = applyAward(selected.value.rule.award, {
        marksAvailable: slot.marksAvailable,
        correctSelectionCount,
      });
      if (!awarded.ok) return err(awarded.error);

      outcomes.push(
        outcomeFromRule({
          slot,
          sectionOrdinal: section.ordinal,
          rule: selected.value.rule,
          marksAwarded: awarded.value,
          marksAvailable,
          sawIndeterminate: selected.value.sawIndeterminate,
        }),
      );
    }

    allOutcomes.push(...outcomes);
    sectionScores.push(aggregateSection({ sectionOrdinal: section.ordinal, outcomes }, aggregation));
  }

  return createScoreRecord({
    scoreRecordId: props.scoreRecordId,
    attemptId: input.attemptId,
    markingRuleSetHash: ruleSetHash,
    ruleSchemaVersion: input.pin.ruleSchemaVersion,
    generation: props.generation ?? 1,
    ...(props.supersedesScoreRecordId !== undefined
      ? { supersedesScoreRecordId: props.supersedesScoreRecordId }
      : {}),
    totalScore: aggregateTotal(sectionScores, aggregation),
    sectionScores,
    itemOutcomes: allOutcomes,
    computedAt: props.computedAt,
    ...(props.reasonForRescore !== undefined ? { reasonForRescore: props.reasonForRescore } : {}),
  });
}

/** `PER_CORRECT`'s multiplier. Zero for anything that is not an option selection. */
function countCorrectSelections(slot: ScoredSlot, key: AnswerKey): number {
  const response = slot.response;
  if (response === undefined || response.kind !== 'OPTION_SELECTION') return 0;

  if (key.kind === 'MULTI_CORRECT') {
    const correct = new Set(key.correctOptionIds);
    return response.optionIds.filter((option) => correct.has(option)).length;
  }
  if (key.kind === 'SINGLE_CORRECT') {
    return response.optionIds.filter((option) => option === key.optionId).length;
  }
  return 0;
}
