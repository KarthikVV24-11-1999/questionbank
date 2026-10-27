/**
 * The learning context's composition seam (DEC-M0-5, ADR-0015). The composition root imports this module and nothing else of
 * the context, so what the root needs to implement Learning's port is offered here: the port and the shapes it speaks in, and
 * the one constructor that makes evidence. Everything the root assembles it assembles from the other contexts' seams.
 *
 * It has no `register` yet: the context has no routes, handlers or consumers until the next track builds the aggregates.
 */
export { EVIDENCE_OUTCOMES, createMasteryEvidence } from '../domain/mastery-evidence.js';
export type { DifficultyEstimate, EvidenceOutcome, MasteryEvidence } from '../domain/mastery-evidence.js';
export type {
  AssembledEvidence,
  EvidenceSourceFailure,
  EvidenceSourceResult,
  MasteryEvidenceSource,
  ScoredAttemptRef,
} from '../application/ports.js';
