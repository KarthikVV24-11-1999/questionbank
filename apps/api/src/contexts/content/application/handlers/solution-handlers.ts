import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type { ItemRepository, SolutionRepository } from '../../domain/repository-ports.js';
import type { ItemVersion } from '../../domain/item-version.js';
import {
  createSolution,
  createSolutionVersion,
  latestSolutionVersionOf,
  replaceDraftSolutionVersion,
  type Solution,
  type SolutionVersion,
} from '../../domain/solution.js';
import { checkFinalAnswerMatchesKey } from '../final-answer-agreement.js';
import {
  applicationError,
  authorize,
  authorizeDraftAccess,
  authorizeSubjectScope,
  policy,
  type ApplicationError,
} from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type {
  ApplicationContext,
  AuditRecorder,
  Clock,
  IdempotencyStore,
  IdentifierFactory,
} from '../ports.js';
import type { CreateSolutionDraft, UpdateSolutionDraft } from '../commands/solution-commands.js';

/**
 * FR-TCH-04, and D5's agreement check.
 *
 * **Agreement is checked on every save, not only at publication.** A solution
 * whose derivation ends at 9.8 against a key that says 9.81 is the defect that
 * produces answer-key challenges: the learner reads the working, answers what
 * it says, is marked wrong, and is entirely right to dispute it. Checking at
 * save means the author finds out while the item is still in their head
 * (UX §10.1); checking only at publication means a reviewer finds out weeks
 * later, or nobody does.
 */

export const CREATE_SOLUTION_DRAFT_POLICY = policy('CreateSolutionDraft', ['author', 'content_ops']);
export const UPDATE_SOLUTION_DRAFT_POLICY = policy('UpdateSolutionDraft', ['author', 'content_ops']);

export interface SolutionAuthoringDependencies {
  readonly solutions: SolutionRepository;
  readonly items: ItemRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly idempotency: IdempotencyStore;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

/** The item version a solution explains — the one whose key it must agree with. */
async function targetVersion(
  items: ItemRepository,
  itemId: string,
  itemVersionId: string,
): Promise<Result<ItemVersion, ApplicationError>> {
  const found = await items.findById(itemId);
  if (!found.ok) return err(fromContent(found.error));

  const version = found.value.versions.find((candidate) => candidate.versionId === itemVersionId);
  return version === undefined
    ? err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `item ${itemId} holds no version ${itemVersionId}`,
          'targetItemVersionId',
        ),
      )
    : ok(version);
}

function checkAgreement(
  version: SolutionVersion,
  target: ItemVersion,
): Result<true, ApplicationError> {
  const agrees = checkFinalAnswerMatchesKey(version, target.responseSpec);
  return agrees.ok ? ok(true) : err(fromContent(agrees.error));
}

export class CreateSolutionDraftHandler implements Handler<CreateSolutionDraft, Solution> {
  readonly name = 'CreateSolutionDraft';
  readonly policy = CREATE_SOLUTION_DRAFT_POLICY;

  constructor(private readonly deps: SolutionAuthoringDependencies) {}

  async handle(
    command: CreateSolutionDraft,
    context: ApplicationContext,
  ): Promise<Result<Solution, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const scoped = authorizeSubjectScope(command.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const target = await targetVersion(this.deps.items, command.itemId, command.targetItemVersionId);
    if (!target.ok) return err(target.error);

    const at = this.deps.clock.now();
    const version = createSolutionVersion({
      versionId: this.deps.identifiers.next(),
      versionNo: 1,
      ...command.content,
      authoredBy: context.principal,
      createdAt: at.toISOString(),
    });
    if (!version.ok) return err(fromContent(version.error));

    const agrees = checkAgreement(version.value, target.value);
    if (!agrees.ok) return err(agrees.error);

    const solution = createSolution({
      solutionId: this.deps.identifiers.next(),
      itemId: command.itemId,
      targetItemVersionId: command.targetItemVersionId,
      initialVersion: version.value,
    });
    if (!solution.ok) return err(fromContent(solution.error));

    const saved = await this.deps.solutions.save(solution.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'Solution',
      targetId: saved.value.solutionId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    return ok(saved.value);
  }
}

export class UpdateSolutionDraftHandler implements Handler<UpdateSolutionDraft, Solution> {
  readonly name = 'UpdateSolutionDraft';
  readonly policy = UPDATE_SOLUTION_DRAFT_POLICY;

  constructor(private readonly deps: SolutionAuthoringDependencies) {}

  async handle(
    command: UpdateSolutionDraft,
    context: ApplicationContext,
  ): Promise<Result<Solution, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const scoped = authorizeSubjectScope(command.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const found = await this.deps.solutions.findById(command.solutionId);
    if (!found.ok) return err(fromContent(found.error));
    const solution = found.value;

    const current = latestSolutionVersionOf(solution);
    const owns = authorizeDraftAccess(current.authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    if (await this.deps.idempotency.seen(command.idempotencyKey)) return ok(solution);

    // Re-read rather than trusting what was true at creation: the item's key
    // can change under a solution that was written against the old one.
    const target = await targetVersion(this.deps.items, solution.itemId, solution.targetItemVersionId);
    if (!target.ok) return err(target.error);

    const at = this.deps.clock.now();
    const version = createSolutionVersion({
      versionId: current.versionId,
      versionNo: current.versionNo,
      ...command.content,
      authoredBy: current.authoredBy,
      createdAt: current.createdAt,
    });
    if (!version.ok) return err(fromContent(version.error));

    const agrees = checkAgreement(version.value, target.value);
    if (!agrees.ok) return err(agrees.error);

    const updated = replaceDraftSolutionVersion(solution, version.value);
    if (!updated.ok) return err(fromContent(updated.error));

    const saved = await this.deps.solutions.save(updated.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'SolutionVersion',
      targetId: current.versionId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    await this.deps.idempotency.remember(command.idempotencyKey);
    return ok(saved.value);
  }
}
