import { err, ok, type Result } from '../../domain/result.js';
import { acceptCandidate, dispositionOf, rejectCandidate, type CandidateDisposition, type GenerationCandidate } from '../../domain/generation-candidate.js';
import type { GenerationCandidateRepository } from '../../domain/repository-ports.js';
import type { CandidateAccepted, CandidateRejected } from '../../domain/events/generation-events.js';
import { applicationError, authorize, fromGeneration, type ApplicationError } from '../authorization.js';
import type { AcceptCandidate, DisposeCandidate, RejectCandidate } from '../commands/generation-commands.js';
import { toContentDraft } from '../content-draft-acl.js';
import type { Handler } from '../handler-registry.js';
import { ACCEPT_CANDIDATE_POLICY, DISPOSE_CANDIDATE_POLICY, REJECT_CANDIDATE_POLICY } from '../policies.js';
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
 * **Defence in depth now, not the only defence — debt D41.** The constructors a
 * proposal passes through return a value for malformed input (proved by a sweep),
 * and the pre-checks run content's validator before a candidate can be accepted,
 * so a malformed proposal is stopped well before this seam. The containment stays
 * because the rest of content's domain still has the pattern.
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
 * Accepting: the one act that turns a model's proposal into a content draft.
 * Shared by the operator's `AcceptCandidate` and the pipeline's `DisposeCandidate`,
 * so there is one acceptance and two ways to ask for it; the caller has already
 * been authorized, and `action` names who asked in the audit record.
 *
 * The order is deliberate. Everything generation can check by itself is checked
 * first, in memory — the lifecycle, the pin, the pre-check battery, and that
 * content's provenance would take the candidate — so a candidate that cannot
 * succeed is refused before content is touched. Then content's own handlers
 * create the draft and submit it, under the caller's context; then the decision
 * is recorded with its event.
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
async function acceptProposed(
  deps: DecisionDependencies,
  candidate: GenerationCandidate,
  context: ApplicationContext,
  action: string,
): Promise<Result<AcceptedCandidate, ApplicationError>> {
  const accepted = acceptCandidate(candidate);
  if (!accepted.ok) return err(fromGeneration(accepted.error));

  const draft = toContentDraft(accepted.value);
  if (!draft.ok) return err(fromGeneration(draft.error));

  const created = await guarded(() => deps.content.createDraft(draft.value, context));
  if (!created.ok) return err(created.error);
  const contentItemId = created.value.itemId;

  const submitted = await guarded(() => deps.content.submitForReview({ itemId: contentItemId }, context));
  if (!submitted.ok) return err(leftBehind(submitted.error, contentItemId));

  const at = deps.clock.now();
  const event: CandidateAccepted = {
    eventType: 'CandidateAccepted',
    ...envelopeOf(context, at),
    candidateId: accepted.value.candidateId,
    pin: accepted.value.pin,
    contentItemId,
  };
  const saved = await deps.candidates.save(accepted.value, [event]);
  if (!saved.ok) return err(leftBehind(fromGeneration(saved.error), contentItemId));

  await deps.audit.record({
    principal: context.principal,
    action,
    targetContext: 'generation',
    targetType: 'GenerationCandidate',
    targetId: accepted.value.candidateId,
    correlationId: context.correlationId,
    occurredAt: at,
  });
  return ok({ candidateId: accepted.value.candidateId, contentItemId });
}

/** Rejecting, shared the same way: terminal, with its event and its audit record. */
async function rejectProposed(
  deps: DecisionDependencies,
  candidate: GenerationCandidate,
  context: ApplicationContext,
  action: string,
): Promise<Result<GenerationCandidate, ApplicationError>> {
  const rejected = rejectCandidate(candidate);
  if (!rejected.ok) return err(fromGeneration(rejected.error));

  const at = deps.clock.now();
  const event: CandidateRejected = {
    eventType: 'CandidateRejected',
    ...envelopeOf(context, at),
    candidateId: rejected.value.candidateId,
    pin: rejected.value.pin,
  };
  const saved = await deps.candidates.save(rejected.value, [event]);
  if (!saved.ok) return err(fromGeneration(saved.error));

  await deps.audit.record({
    principal: context.principal,
    action,
    targetContext: 'generation',
    targetType: 'GenerationCandidate',
    targetId: rejected.value.candidateId,
    correlationId: context.correlationId,
    occurredAt: at,
  });
  return ok(saved.value);
}

/** The operator's override (ADR-0029): an intervention on one candidate, subject to the same preconditions as the pipeline's. */
export class AcceptCandidateHandler implements Handler<AcceptCandidate, AcceptedCandidate> {
  readonly name = 'AcceptCandidate';
  readonly policy = ACCEPT_CANDIDATE_POLICY;

  constructor(private readonly deps: DecisionDependencies) {}

  async handle(command: AcceptCandidate, context: ApplicationContext): Promise<Result<AcceptedCandidate, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.candidates.findById(command.candidateId);
    if (!found.ok) return err(fromGeneration(found.error));
    return acceptProposed(this.deps, found.value, context, this.name);
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
    return rejectProposed(this.deps, found.value, context, this.name);
  }
}

export interface Disposition {
  readonly candidateId: string;
  readonly disposition: CandidateDisposition;
  /** For `accept`: the draft now awaiting a reviewer. */
  readonly contentItemId?: string;
}

/**
 * The pipeline acts on the battery's result (ADR-0029): every blocking check
 * passed → accept, a blocking check failed → reject terminally (D46), a check that
 * has not run → nothing. **Nothing here decides.** `dispositionOf` reads the
 * recorded verdicts; this handler carries out what they say, through the same
 * accept and reject the operator's override uses, so `acceptCandidate`'s
 * preconditions stand between the pipeline and any acceptance the verdicts do not
 * support.
 */
export class DisposeCandidateHandler implements Handler<DisposeCandidate, Disposition> {
  readonly name = 'DisposeCandidate';
  readonly policy = DISPOSE_CANDIDATE_POLICY;

  constructor(private readonly deps: DecisionDependencies) {}

  async handle(command: DisposeCandidate, context: ApplicationContext): Promise<Result<Disposition, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.candidates.findById(command.candidateId);
    if (!found.ok) return err(fromGeneration(found.error));
    const candidate = found.value;
    const disposition = dispositionOf(candidate);

    if (disposition === 'accept') {
      const accepted = await acceptProposed(this.deps, candidate, context, this.name);
      if (!accepted.ok) return err(accepted.error);
      return ok({ candidateId: candidate.candidateId, disposition, contentItemId: accepted.value.contentItemId });
    }
    if (disposition === 'reject') {
      const rejected = await rejectProposed(this.deps, candidate, context, this.name);
      if (!rejected.ok) return err(rejected.error);
      return ok({ candidateId: candidate.candidateId, disposition });
    }
    return ok({ candidateId: candidate.candidateId, disposition });
  }
}
