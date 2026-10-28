import type { PrincipalRef } from '@questionbank/domain-types';

/**
 * Facts published for downstream contexts (EVENT-TAXONOMY, §9 rule 4).
 * Identifiers only — never a full record, and never an answer key or a
 * response payload (§9 rules 10 and 12). Psychometrics and Learning read the
 * owning context rather than trusting a copy.
 */
export const SCORING_EVENT_TYPES = ['AttemptScored', 'AttemptsRescored', 'AttemptScoreSuperseded'] as const;

export type ScoringEventType = (typeof SCORING_EVENT_TYPES)[number];

export interface DomainEvent<TType extends string, TPayload> {
  readonly eventId: string;
  readonly eventType: TType;
  readonly schemaVersion: number;
  readonly occurredAt: Date;
  readonly principal: PrincipalRef;
  readonly correlationId: string;
  readonly payload: TPayload;
}

export interface AttemptScoredPayload {
  readonly scoreRecordId: string;
  readonly attemptId: string;
  readonly generation: number;
  readonly markingRuleSetHash: string;
  readonly ruleSchemaVersion: number;
  /** The total as decimal text, so no consumer reads a mark through a double. */
  readonly totalRaw: string;
  readonly totalMaxAvailable: string;
}

export interface AttemptsRescoredPayload {
  readonly rescoringOperationId: string;
  readonly attemptCount: number;
  readonly trigger: string;
  readonly scope: string;
}

/**
 * One attempt's score was superseded by a re-score (D72, ADR-0053, DEC-M7-19). `AttemptsRescored` says an operation finished and how many attempts it touched; this says
 * which, one message each, so a consumer holding what it derived from the earlier generation learns exactly what to reassemble — and a delivery that fails
 * fails for one attempt and not for the thousands beside it.
 */
export interface AttemptScoreSupersededPayload {
  readonly rescoringOperationId: string;
  readonly attemptId: string;
  /** The score record that now stands. */
  readonly scoreRecordId: string;
  readonly supersededScoreRecordId: string;
  readonly generation: number;
}

export type AttemptScored = DomainEvent<'AttemptScored', AttemptScoredPayload>;
export type AttemptsRescored = DomainEvent<'AttemptsRescored', AttemptsRescoredPayload>;

export type AttemptScoreSuperseded = DomainEvent<'AttemptScoreSuperseded', AttemptScoreSupersededPayload>;

export type ScoringEvent = AttemptScored | AttemptsRescored | AttemptScoreSuperseded;
