/**
 * Events assessment publishes through the outbox (D17, D60). **Identifiers, version numbers, codes and timestamps only** — never a
 * stem, a key, a solution, a response or a reviewer's words (P4): the outbox drains to consumers that must not receive them, and the
 * relay refuses a payload that breaks the discipline. A fitness rule reads these declarations the day a field is typed.
 */
export interface EventPrincipal {
  readonly kind: 'human' | 'ai_agent' | 'system';
  readonly id: string;
}

/**
 * An attempt was submitted. Written in the same transaction as the state change, once: a retried submission writes nothing,
 * because it changes nothing. What scoring needs to find the attempt, and nothing it could read the attempt itself for.
 */
export interface AttemptSubmitted {
  readonly eventType: 'AttemptSubmitted';
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly principal: EventPrincipal;
  readonly correlationId: string;
  readonly payload: {
    readonly attemptId: string;
    readonly formId: string;
    readonly studentId: string;
    readonly examProfileVersionId: string;
    readonly markingRuleSetHash: string;
    readonly taxonomyVersionId: string;
    readonly reason: 'manual' | 'expiry' | 'recovered';
    readonly submittedAt: string;
  };
}

/**
 * A practice run was submitted (M8-25, closes D77). **A type of its own, not an `AttemptSubmitted` with a form that may be null**: a consumer written for mocks reads
 * `payload.formId` and dereferences it, so the same type with a hole in it would put a failure in every practice submission that a consumer for mocks cannot distinguish from
 * a fault. The relay's map from type to consumer is where the two are told apart, and `AttemptSubmitted` keeps its required `formId` and its `schemaVersion`.
 *
 * It names no form, because the run has none, and no section, total or pass mark, because it has none of those either. What scoring needs to find the run, and nothing it could read the attempt for.
 */
export interface PracticeAttemptSubmitted {
  readonly eventType: 'PracticeAttemptSubmitted';
  readonly schemaVersion: 1;
  readonly occurredAt: string;
  readonly principal: EventPrincipal;
  readonly correlationId: string;
  readonly payload: {
    readonly attemptId: string;
    readonly studentId: string;
    readonly examProfileVersionId: string;
    readonly markingRuleSetHash: string;
    readonly taxonomyVersionId: string;
    readonly reason: 'manual' | 'expiry' | 'recovered';
    readonly submittedAt: string;
  };
}

export type AssessmentEvent = AttemptSubmitted | PracticeAttemptSubmitted;
export const ASSESSMENT_EVENT_TYPES = ['AttemptSubmitted', 'PracticeAttemptSubmitted'] as const;
