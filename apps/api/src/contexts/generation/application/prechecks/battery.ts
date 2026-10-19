import type { VerdictOutcome, GenerationCandidate } from '../../domain/generation-candidate.js';
import type { PrecheckId, PrecheckSeverity } from '../../domain/precheck-vocabulary.js';
import type { Result } from '../../domain/result.js';
import type { ApplicationError } from '../authorization.js';
import type { ApplicationContext } from '../ports.js';

/**
 * The pre-check battery's vocabulary (AI-ARCHITECTURE §11): what a check
 * returns, how a check is declared unrunnable, and what the battery reports.
 *
 * **A check that did not run is not a check that passed.** That sentence is the
 * whole design. `acceptCandidate` requires a *recorded* passing verdict for
 * every blocking check, so the only way a candidate becomes acceptable is for
 * each blocking check to have actually run and passed. Anything that lets "did
 * not run" look like "passed" — a default, a skipped entry, a verdict recorded
 * for convenience — would quietly turn a gap into an approval. So a check that
 * cannot run records *nothing*, and says so in the report.
 */

export interface CheckOutcome {
  readonly outcome: VerdictOutcome;
  /** The working, not only the verdict: a reviewer sees why (§11). */
  readonly detail?: string;
}

/** One check that can run. It returns a result or a typed reason it could not; it never records. */
export interface PrecheckRunner {
  readonly check: PrecheckId;
  run(candidate: GenerationCandidate, context: ApplicationContext): Promise<Result<CheckOutcome, ApplicationError>>;
}

/**
 * A check that cannot run, and why — named, with the single successor that
 * would unblock it. Declared in one place so the report can say it plainly, and
 * so a check is never merely absent.
 */
export interface BlockedPrecheck {
  readonly check: PrecheckId;
  readonly reason: string;
  /** The work, in whoever's own task, that would let this check run. */
  readonly successor: string;
}

export const CHECK_STATUSES = [
  /** Ran, and its verdict was recorded by this run. */
  'recorded',
  /** A verdict for it was already on the candidate, so it was not run again. */
  'already_recorded',
  /** Ran into a reason it could not produce a result; nothing was recorded. */
  'could_not_run',
  /** Produced a result but recording it failed; nothing was recorded. */
  'could_not_record',
  /** Declared unrunnable; nothing was recorded. */
  'blocked',
  /** Neither implemented nor declared blocked. A defect in the battery's configuration, reported rather than hidden. */
  'unaccounted',
] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckReport {
  readonly check: PrecheckId;
  readonly severity: PrecheckSeverity;
  readonly status: CheckStatus;
  readonly outcome?: VerdictOutcome;
  readonly detail?: string;
  /** For `blocked`: why, and what unblocks it. */
  readonly blocked?: { readonly reason: string; readonly successor: string };
  /** For `could_not_run` and `could_not_record`: the typed reason. */
  readonly error?: { readonly code: string; readonly message: string };
}

/**
 * What the pipeline did with the candidate once the checks had run (ADR-0029).
 * `failed` means it tried and could not — the error, and for an acceptance that was
 * interrupted the draft it left behind, are in `error`.
 */
export type DispositionReport =
  | { readonly status: 'accepted'; readonly contentItemId: string }
  | { readonly status: 'rejected' }
  | { readonly status: 'undecided' }
  | { readonly status: 'failed'; readonly error: { readonly code: string; readonly message: string } };

/** One entry per check in the vocabulary, in vocabulary order — a report with twelve lines, always. */
export interface BatteryReport {
  readonly candidateId: string;
  readonly checks: readonly CheckReport[];
  readonly disposition: DispositionReport;
}
