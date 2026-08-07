import type { PrincipalRef } from '@questionbank/domain-types';

/**
 * Facts published for downstream contexts (EVENT-TAXONOMY, §9 rule 4).
 * Identifiers only — never a full record, and never an answer key or a
 * response payload (§9 rules 10 and 12). Psychometrics and Learning read the
 * owning context rather than trusting a copy.
 */
export const SCORING_EVENT_TYPES = ['AttemptScored', 'AttemptsRescored'] as const;

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

export type AttemptScored = DomainEvent<'AttemptScored', AttemptScoredPayload>;
export type AttemptsRescored = DomainEvent<'AttemptsRescored', AttemptsRescoredPayload>;

export type ScoringEvent = AttemptScored | AttemptsRescored;
