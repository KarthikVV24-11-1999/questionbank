import type { ModelPin } from '../model-pin.js';

/**
 * Facts published for downstream contexts. Identifiers only — never the
 * proposed content, which is content's to hold once accepted (§9 rule 10).
 * The pin travels with the fact so "which items did prompt v7 touch?" is
 * answerable from the event stream as well as from the table.
 */
export const GENERATION_EVENT_TYPES = ['CandidateAccepted', 'CandidateRejected'] as const;
export type GenerationEventType = (typeof GENERATION_EVENT_TYPES)[number];

export interface CandidateAccepted {
  readonly eventType: 'CandidateAccepted';
  readonly candidateId: string;
  readonly pin: ModelPin;
}

export interface CandidateRejected {
  readonly eventType: 'CandidateRejected';
  readonly candidateId: string;
  readonly pin: ModelPin;
}

export type GenerationEvent = CandidateAccepted | CandidateRejected;
