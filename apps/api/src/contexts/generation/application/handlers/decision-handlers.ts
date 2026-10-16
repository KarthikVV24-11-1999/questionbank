import { err, ok, type Result } from '../../domain/result.js';
import { acceptCandidate, rejectCandidate, type GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationCandidateRepository } from '../../domain/repository-ports.js';
import type { CandidateAccepted, CandidateRejected } from '../../domain/events/generation-events.js';
import { applicationError, authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { AcceptCandidate, RejectCandidate } from '../commands/generation-commands.js';
import { toContentDraft } from '../content-draft-acl.js';
import type { Handler } from '../handler-registry.js';
import { ACCEPT_CANDIDATE_POLICY, REJECT_CANDIDATE_POLICY } from '../policies.js';
import type { ApplicationContext, AuditRecorder, Clock, ContentAuthoring } from '../ports.js';

export interface DecisionDependencies {
  readonly candidates: GenerationCandidateRepository;
  readonly content: ContentAuthoring;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

const EVENT_SCHEMA_VERSION = 1;

/**
 * The envelope of an event, taken from the application context and nowhere
 * else. A handler that invented a principal or a correlation id would write a
 * fact into the outbox that nobody did and nobody can trace; there is no
 * constant, default or fallback here to invent one from.
 */
function envelopeOf(context: ApplicationContext, at: Date) {
  return {
    schemaVersion: EVENT_SCHEMA_VERSION,
    occurredAt: at.toISOString(),
    principal: { kind: context.principal.kind, id: context.principal.id },
    correlationId: context.correlationId,
  };
}

export interface AcceptedCandidate {
  readonly candidateId: string;
  /** The content draft the candidate became — an identifier, not a join (§9 rule 3). */
  readonly contentItemId: string;
}

/**
 * Content's domain assumes a well-typed command, and a proposal is untyped JSON
 * from a model: a malformed one can make content raise rather than return a
 * failure. Whatever content does, this handler returns a value — the throw is
 * contained here, at the seam, rather than becoming a 500 with a half-done
 * acceptance behind it.
 *
 * **This is containment, not a fix — debt D41.** Content owes a value where it
 * currently raises, and its own no-throw guard cannot see the gap because it
 * reads for the `throw` keyword rather than for a raise.
 */
async function guarded<T>(work: () => Promise<Result<T, ApplicationError>>): Promise<Result<T, ApplicationError>> {
  try {
    return await work();
  } catch (error) {
    return err(
      applicationError('Unavailable', 'CONTENT_AUTHORING_FAILED', 'content could not complete the request', undefined, {
        cause: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}

/** The same failure, plus the draft it left behind, so an interrupted acceptance can be found and finished by hand. */
function leftBehind(error: ApplicationError, contentItemId: string): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location, { contentItemId });
}

/**
 * Accept: the one act that turns a model's proposal into a content draft.
 *
 * The order is deliberate. Everything generation can check by itself is checked
 * first, in memory — the lifecycle, the pin, the pre-check battery, and that
 * content's provenance would take the candidate — so a candidate that cannot
 * succeed is refused before content is touched. Then content's own handlers
 * create the draft and submit it, under the accepting human's context; then the
 * decision is recorded with its event.
 *
 * Generation writes nothing in `content.*`. Content's handlers perform every
 * write, under content's invariants, and the draft joins the queue a human
 * author's draft joins — there is no second one.
 *
 * **Not atomic across the boundary (D40).** Two contexts, two transactions: if
 * recording the decision fails after content accepted the draft, the draft
 * exists and the candidate is still proposed. The error says so, naming the
 * draft.
 */
export class AcceptCandidateHandler implements Handler<AcceptCandidate, AcceptedCandidate> {
  readonly name = 'AcceptCandidate';
  readonly policy = ACCEPT_CANDIDATE_POLICY;

  constructor(private readonly deps: DecisionDependencies) {}

  async handle(command: AcceptCandidate, context: ApplicationContext): Promise<Result<AcceptedCandidate, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.candidates.findById(command.candidateId);
    if (!found.ok) return err(fromGeneration(found.error));

    const accepted = acceptCandidate(found.value);
    if (!accepted.ok) return err(fromGeneration(accepted.error));

    const draft = toContentDraft(accepted.value);
    if (!draft.ok) return err(fromGeneration(draft.error));

    const created = await guarded(() => this.deps.content.createDraft(draft.value, context));
    if (!created.ok) return err(created.error);
    const contentItemId = created.value.itemId;

    const submitted = await guarded(() => this.deps.content.submitForReview({ itemId: contentItemId }, context));
    if (!submitted.ok) return err(leftBehind(submitted.error, contentItemId));

    const at = this.deps.clock.now();
    const event: CandidateAccepted = {
      eventType: 'CandidateAccepted',
      ...envelopeOf(context, at),
      candidateId: accepted.value.candidateId,
      pin: accepted.value.pin,
      contentItemId,
    };
    const saved = await this.deps.candidates.save(accepted.value, [event]);
    if (!saved.ok) return err(leftBehind(fromGeneration(saved.error), contentItemId));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'GenerationCandidate',
      targetId: accepted.value.candidateId,
      correlationId: context.correlationId,
      occurredAt: at,
    });
    return ok({ candidateId: accepted.value.candidateId, contentItemId });
  }
}

export class RejectCandidateHandler implements Handler<RejectCandidate, GenerationCandidate> {
  readonly name = 'RejectCandidate';
  readonly policy = REJECT_CANDIDATE_POLICY;

  constructor(private readonly deps: DecisionDependencies) {}

  async handle(command: RejectCandidate, context: ApplicationContext): Promise<Result<GenerationCandidate, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.candidates.findById(command.candidateId);
    if (!found.ok) return err(fromGeneration(found.error));

    const rejected = rejectCandidate(found.value);
    if (!rejected.ok) return err(fromGeneration(rejected.error));

    const at = this.deps.clock.now();
    const event: CandidateRejected = {
      eventType: 'CandidateRejected',
      ...envelopeOf(context, at),
      candidateId: rejected.value.candidateId,
      pin: rejected.value.pin,
    };
    const saved = await this.deps.candidates.save(rejected.value, [event]);
    if (!saved.ok) return err(fromGeneration(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'generation',
      targetType: 'GenerationCandidate',
      targetId: rejected.value.candidateId,
      correlationId: context.correlationId,
      occurredAt: at,
    });
    return ok(saved.value);
  }
}
