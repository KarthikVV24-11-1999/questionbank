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

export type AssessmentEvent = AttemptSubmitted;
export const ASSESSMENT_EVENT_TYPES = ['AttemptSubmitted'] as const;
