import type { Result } from './result.js';
import type { AdmissionErrorCode, AIBudget } from './ai-budget.js';
import type { SpendEntry } from './ai-spend.js';
import type { EvaluationRun, SubjectKind } from './evaluation-run.js';
import type { GenerationError } from './generation-error.js';
import type { GenerationCandidate } from './generation-candidate.js';
import type { GenerationRun } from './generation-run.js';
import type { ModelVersion, PromptVersion } from './version-registry.js';
import type { GenerationEvent } from './events/generation-events.js';

/**
 * What the application layer needs from persistence, declared by the domain so
 * the dependency points inward. Infrastructure implements these; nothing here
 * knows how anything is stored.
 *
 * **A candidate's `save` takes the events the change produces**, and writes
 * them in the same transaction as the candidate (§9 rule 4): write-then-publish
 * loses the event whenever the process dies between the two.
 *
 * Both repositories are **append-only in effect**. A run is written once; a
 * candidate is written once and afterwards only gains verdicts and a decision.
 * Saving an aggregate that disagrees with what is stored — one that has lost a
 * verdict the store holds, or carries a different decision — is a `CONFLICT`,
 * never an overwrite.
 */

export type RepositoryError = GenerationError<'CONFLICT' | 'NOT_FOUND' | 'PERSISTENCE_REJECTED'>;

export type RunAdmissionError = RepositoryError | GenerationError<AdmissionErrorCode>;

export interface GenerationRunRepository {
  /** Writes a run once. A run with this id already stored is a `CONFLICT`. */
  save(run: GenerationRun): Promise<Result<GenerationRun, RepositoryError>>;

  /**
   * Enqueue (M5-41): writes the run **only if it fits its period's budget**, and
   * decides that in the same transaction that writes it, so two runs enqueued at
   * once cannot both claim the last of a ceiling. A period with no declared budget
   * is `BUDGET_NOT_DECLARED`; one the run would overflow is `RUN_EXCEEDS_BUDGET`.
   * Either way nothing is written.
   */
  saveWithinBudget(run: GenerationRun, feature: string): Promise<Result<GenerationRun, RunAdmissionError>>;

  findById(runId: string): Promise<Result<GenerationRun, RepositoryError>>;
}

export interface AIBudgetRepository {
  /** Declares a period's ceiling once. A second declaration for the same feature and period is a `CONFLICT`. */
  declare(
    budget: AIBudget,
    declaredBy: { readonly kind: string; readonly id: string },
    declaredAt: string,
  ): Promise<Result<AIBudget, RepositoryError>>;

  find(feature: string, period: string): Promise<Result<AIBudget | undefined, RepositoryError>>;
}

export interface GenerationCandidateRepository {
  /**
   * One aggregate, one transaction: the candidate, its pin, its proposal, every
   * verdict and its decision. Saving a candidate already stored adds the
   * verdicts and the decision it has gained; anything that would change or
   * remove what is stored is a `CONFLICT`. A candidate pinned to a run that was
   * never saved, or to a run under a different model or prompt, is
   * `PERSISTENCE_REJECTED`.
   */
  save(
    candidate: GenerationCandidate,
    events?: readonly GenerationEvent[],
  ): Promise<Result<GenerationCandidate, RepositoryError>>;

  findById(candidateId: string): Promise<Result<GenerationCandidate, RepositoryError>>;

  /** Every candidate one run produced, oldest first — empty when it produced none. */
  findByRun(runId: string): Promise<Result<readonly GenerationCandidate[], RepositoryError>>;

  /**
   * The one query F28 exists to make answerable: every candidate produced under
   * a prompt version, whatever its state.
   */
  findByPromptVersion(promptVersionId: string): Promise<Result<readonly GenerationCandidate[], RepositoryError>>;
}

/**
 * Where published versions are written and read. A version is written once —
 * the table refuses an UPDATE from every role — so a second write of a version
 * already there is a `CONFLICT`, including the same model or prompt file under a
 * new id: two ids for one version is the very thing the registry prevents.
 */
export interface VersionRegistry {
  registerModelVersion(version: ModelVersion): Promise<Result<ModelVersion, RepositoryError>>;
  registerPromptVersion(version: PromptVersion): Promise<Result<PromptVersion, RepositoryError>>;
  findModelVersion(modelVersionId: string): Promise<Result<ModelVersion, RepositoryError>>;
  findPromptVersion(promptVersionId: string): Promise<Result<PromptVersion, RepositoryError>>;
}

/**
 * The spend ledger (M5-42): append-only, and the single source of what a run, a
 * month or a feature has consumed. Nothing keeps a counter beside it.
 */
export interface AISpendLedger {
  append(entry: SpendEntry): Promise<Result<SpendEntry, RepositoryError>>;

  /** Tokens, input plus output, charged to one run. Zero for a run that has spent nothing. */
  spentByRun(runId: string): Promise<Result<number, RepositoryError>>;

  /** Tokens charged to a feature in a UTC calendar month, `YYYY-MM`. */
  spentInPeriod(feature: string, period: string): Promise<Result<number, RepositoryError>>;
}

/**
 * Evaluation runs (M5-43). Written once and never changed; the gate on activating a
 * version reads only whether a *passing* one exists.
 */
export interface EvaluationRunRepository {
  save(
    run: EvaluationRun,
    evaluatedBy: { readonly kind: string; readonly id: string },
  ): Promise<Result<EvaluationRun, RepositoryError>>;

  findById(evaluationRunId: string): Promise<Result<EvaluationRun, RepositoryError>>;

  /** Whether a passing evaluation exists for this version. A failing one is not a pass. */
  hasPassing(kind: SubjectKind, versionId: string): Promise<Result<boolean, RepositoryError>>;
}
