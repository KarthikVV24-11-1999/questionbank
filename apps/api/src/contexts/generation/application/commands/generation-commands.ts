import type { GroundingExcerpt } from '../ports.js';

/**
 * What the generation context can be told to do. Imperative verb phrases (§2),
 * one per consequential act.
 *
 * A command carries what the **caller** decides and nothing the system knows
 * for itself: no run identifier, no timestamp, no principal. Those come from
 * the handler's ports and the application context, so a caller cannot backdate
 * a run, choose an identifier that collides, or act as somebody else.
 */

/**
 * Pins the model and prompt a run executes under, at the moment it starts. They
 * are pinned **data** the caller names — never configuration constants read
 * later (ARCHITECTURE §8) — so a run recorded under prompt v7 stays recorded
 * under prompt v7 whatever the deployment is later changed to.
 */
export interface StartGenerationRun {
  readonly modelVersionId: string;
  readonly promptVersionId: string;
  /** What was asked for. A JSON object whose shape is the pipeline's to define. */
  readonly request: Readonly<Record<string, unknown>>;
}

/**
 * One check's result. `check` and `outcome` are strings because a command is
 * untrusted input: the handler refuses a check the vocabulary does not know
 * rather than trusting the caller to have typed it.
 */
export interface RecordPrecheckVerdict {
  readonly candidateId: string;
  readonly check: string;
  readonly outcome: string;
  readonly detail?: string;
}

export interface AcceptCandidate {
  readonly candidateId: string;
}

export interface RejectCandidate {
  readonly candidateId: string;
}

/**
 * Asks the provider for a proposal against a run and stores it as a candidate.
 * The pin is the run's, never the caller's: a candidate's pin is the run it was
 * produced under, and a command that could name another would let a candidate
 * claim a model that did not write it.
 */
export interface ProposeCandidate {
  readonly runId: string;
  readonly grounding: readonly GroundingExcerpt[];
  /** What to produce — the item type, subject and band. The provider's recording is keyed on it. */
  readonly task: Readonly<Record<string, unknown>>;
}

/** Runs every pre-check that can run against a proposed candidate and records what ran. */
export interface RunPrecheckBattery {
  readonly candidateId: string;
}
