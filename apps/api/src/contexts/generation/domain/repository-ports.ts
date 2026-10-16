import type { Result } from './result.js';
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

export interface GenerationRunRepository {
  /** Writes a run once. A run with this id already stored is a `CONFLICT`. */
  save(run: GenerationRun): Promise<Result<GenerationRun, RepositoryError>>;

  findById(runId: string): Promise<Result<GenerationRun, RepositoryError>>;
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
