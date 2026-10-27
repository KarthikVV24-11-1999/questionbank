/**
 * The learning context's only public surface (ENGINEERING-HANDBOOK §1, §9 rule 1). Types only so far: the evidence value and
 * the port it is assembled through. The aggregates arrive with the next track. The one value the composition root needs is
 * offered by `composition.ts`, which is the root's only door.
 */

export type { DifficultyEstimate, EvidenceOutcome, MasteryEvidence } from '../domain/mastery-evidence.js';
export type {
  AssembledEvidence,
  EvidenceSourceFailure,
  EvidenceSourceResult,
  MasteryEvidenceSource,
  ScoredAttemptRef,
} from '../application/ports.js';
