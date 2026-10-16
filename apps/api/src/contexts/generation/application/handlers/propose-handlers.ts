import { err, ok, type Result } from '../../domain/result.js';
import { createGenerationCandidate, type GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationCandidateRepository, GenerationRunRepository } from '../../domain/repository-ports.js';
import { authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { ProposeCandidate } from '../commands/generation-commands.js';
import { checkProposalBody } from '../content-draft-acl.js';
import type { Handler } from '../handler-registry.js';
import { PROPOSE_CANDIDATE_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory, ProposalProvider } from '../ports.js';

export interface ProposeDependencies {
  readonly runs: GenerationRunRepository;
  readonly candidates: GenerationCandidateRepository;
  readonly provider: ProposalProvider;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

/**
 * The first creator of a candidate: asks the provider for a proposal against a
 * run and stores what comes back, `proposed`, with no verdicts.
 *
 * - **The pin is the run's.** It is read from the stored run and handed to the
 *   provider, and the candidate is pinned to the same — so a candidate can only
 *   ever claim the model and prompt version that actually produced it.
 * - **The confidence is the provider's.** M5-13 made it mandatory; this is where
 *   it is filled, and the domain refuses one outside [0, 1].
 * - **A proposal that could never become a draft is refused here**, naming the
 *   missing key, rather than at accept time or by content: a candidate that
 *   cannot be accepted is a generation wasted, and the key is cheapest to name
 *   while the provider's answer is in hand.
 *
 * The provider is called only after the run is found and the caller is allowed,
 * so a refused command costs no generation.
 */
export class ProposeCandidateHandler implements Handler<ProposeCandidate, GenerationCandidate> {
  readonly name = 'ProposeCandidate';
  readonly policy = PROPOSE_CANDIDATE_POLICY;

  constructor(private readonly deps: ProposeDependencies) {}

  async handle(command: ProposeCandidate, context: ApplicationContext): Promise<Result<GenerationCandidate, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const run = await this.deps.runs.findById(command.runId);
    if (!run.ok) return err(fromGeneration(run.error));

    const proposed = await this.deps.provider.propose({
      pin: run.value.pin,
      grounding: command.grounding,
      task: command.task,
    });
    if (!proposed.ok) return err(proposed.error);

    const shaped = checkProposalBody(proposed.value.body);
    if (!shaped.ok) return err(fromGeneration(shaped.error));

    const candidate = createGenerationCandidate({
      candidateId: this.deps.identifiers.next(),
      pin: run.value.pin,
      content: { itemType: proposed.value.itemType, body: proposed.value.body },
      confidence: proposed.value.confidence,
      verdicts: [],
    });
    if (!candidate.ok) return err(fromGeneration(candidate.error));

    const saved = await this.deps.candidates.save(candidate.value);
    if (!saved.ok) return err(fromGeneration(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'GenerationCandidate',
      targetId: candidate.value.candidateId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
    return ok(saved.value);
  }
}
