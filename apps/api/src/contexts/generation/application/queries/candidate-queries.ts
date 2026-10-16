import { err, ok, type Result } from '../../domain/result.js';
import type { GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationCandidateRepository } from '../../domain/repository-ports.js';
import { authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import { GET_CANDIDATE_POLICY, LIST_RUN_CANDIDATES_POLICY } from '../policies.js';
import type { ApplicationContext } from '../ports.js';

export interface GetCandidate {
  readonly candidateId: string;
}

export interface ListRunCandidates {
  readonly runId: string;
}

export interface CandidateQueryDependencies {
  readonly candidates: GenerationCandidateRepository;
}

/**
 * The deciding human reads a candidate with the battery's working beside it —
 * "the reviewer should see the verification's working, not just its verdict"
 * (AI-ARCHITECTURE §11). The proposal carries its own answer key, so these are
 * authoring-surface reads and `content_ops` only.
 */
export class GetCandidateHandler implements Handler<GetCandidate, GenerationCandidate> {
  readonly name = 'GetCandidate';
  readonly policy = GET_CANDIDATE_POLICY;

  constructor(private readonly deps: CandidateQueryDependencies) {}

  async handle(query: GetCandidate, context: ApplicationContext): Promise<Result<GenerationCandidate, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.candidates.findById(query.candidateId);
    return found.ok ? ok(found.value) : err(fromGeneration(found.error));
  }
}

export class ListRunCandidatesHandler implements Handler<ListRunCandidates, readonly GenerationCandidate[]> {
  readonly name = 'ListRunCandidates';
  readonly policy = LIST_RUN_CANDIDATES_POLICY;

  constructor(private readonly deps: CandidateQueryDependencies) {}

  async handle(
    query: ListRunCandidates,
    context: ApplicationContext,
  ): Promise<Result<readonly GenerationCandidate[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.candidates.findByRun(query.runId);
    return found.ok ? ok(found.value) : err(fromGeneration(found.error));
  }
}
