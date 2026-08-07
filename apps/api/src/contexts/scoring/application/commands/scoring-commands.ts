import type { AggregationSpecData } from '../../domain/aggregation-data.js';
import type { MarkingRuleSetData } from '../../domain/marking-rule-data.js';
import type { ScoringInput } from '../../domain/scoring-input.js';

/** Imperative verb phrases (§2). One command per consequential act. */

export interface ScoreAttempt {
  readonly input: ScoringInput;
  readonly ruleSet: MarkingRuleSetData;
  readonly ruleSetHash: string;
  readonly aggregation: AggregationSpecData;
  /** Repeating a submission must not create a second generation (REL-02). */
  readonly idempotencyKey: string;
}

export interface DraftRescoring {
  readonly trigger: 'CHALLENGE_UPHELD' | 'KEY_DEFECT_CONFIRMED' | 'RULE_CORRECTION';
  readonly scope: 'ITEM_VERSION' | 'RULE_CHANGE' | 'FORM';
  readonly scopeRef: string;
  readonly reason: string;
}

export interface RunRescoringDryRun {
  readonly operationId: string;
  /** The attempts in scope, each with the inputs needed to re-score it. */
  readonly attempts: readonly ScoreAttempt[];
}

export interface ApproveRescoring {
  readonly operationId: string;
}

export interface ExecuteRescoring {
  readonly operationId: string;
  readonly attempts: readonly ScoreAttempt[];
}
