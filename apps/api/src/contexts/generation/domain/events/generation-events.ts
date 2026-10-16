import type { ModelPin } from '../model-pin.js';

/**
 * Facts published for downstream contexts. Identifiers only — never the
 * proposed content, which is content's to hold once accepted (§9 rule 10).
 * The pin travels with the fact so "which items did prompt v7 touch?" is
 * answerable from the event stream as well as from the table.
 */
export const GENERATION_EVENT_TYPES = ['CandidateAccepted', 'CandidateRejected'] as const;
export type GenerationEventType = (typeof GENERATION_EVENT_TYPES)[number];

/**
 * Who the fact is attributed to. `domain/` imports nothing, so this restates
 * the platform's principal shape rather than importing it; the outbox column
 * it lands in is constrained to the same three kinds.
 */
export interface EventPrincipal {
  readonly kind: 'human' | 'ai_agent' | 'system';
  readonly id: string;
}

/**
 * What every event carries so the outbox can attribute and order it. The
 * timestamp is supplied (`domain/` has no clock): UTC, ISO-8601, in the
 * millisecond form `Date.prototype.toISOString` produces.
 */
interface GenerationEventEnvelope<TType extends GenerationEventType> {
  readonly eventType: TType;
  readonly schemaVersion: number;
  readonly occurredAt: string;
  readonly principal: EventPrincipal;
  readonly correlationId: string;
  readonly candidateId: string;
  readonly pin: ModelPin;
}

/**
 * Acceptance carries the link to the content draft it produced — an identifier,
 * not a join: the two contexts share no foreign key (§9 rule 3), and the id is
 * how an operator finds the draft a candidate became.
 */
export interface CandidateAccepted extends GenerationEventEnvelope<'CandidateAccepted'> {
  readonly contentItemId: string;
}
export type CandidateRejected = GenerationEventEnvelope<'CandidateRejected'>;

export type GenerationEvent = CandidateAccepted | CandidateRejected;
