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
  /**
   * What the run reserves from its period's budget, in tokens (M5-41). A run that
   * would not fit is refused at enqueue and nothing is written.
   */
  readonly budgetTokens: number;
}

/**
 * Records the evidence a version may be activated on: scores for one model or prompt version against a
 * named corpus, compared with the passing run it replaces. The outcome is not in the command — the domain
 * derives it from the scores and the baseline, so a caller cannot assert a pass.
 */
export interface RecordEvaluationRun {
  readonly subject: { readonly kind: string; readonly versionId: string };
  readonly corpus: string;
  readonly scores: Readonly<Record<string, unknown>>;
  readonly baselineRunId?: string;
}

/**
 * Declares the ceiling, in tokens, that one feature's runs may reserve in one UTC
 * calendar month. Declared once; a period with no declaration admits nothing.
 */
export interface DeclareAIBudget {
  readonly feature: string;
  readonly period: string;
  readonly ceilingTokens: number;
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
 * Acts on the battery's result: accepts a candidate whose blocking checks all
 * passed, rejects one that failed a blocking check, leaves one the battery has not
 * finished with. The pipeline's route (ADR-0029); `AcceptCandidate` and
 * `RejectCandidate` stay the operator's override.
 */
export interface DisposeCandidate {
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
