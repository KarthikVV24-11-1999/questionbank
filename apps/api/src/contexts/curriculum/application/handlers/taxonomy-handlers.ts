import { err, ok, type Result } from '../../domain/result.js';
import { ConceptNode } from '../../domain/concept-node.js';
import { PrerequisiteEdge } from '../../domain/prerequisite-edge.js';
import { TaxonomyVersion } from '../../domain/taxonomy-version.js';
import type {
  ConceptIdentityRepository,
  Persisted,
  RepositoryError,
  TaxonomyVersionRepository,
} from '../../domain/repository-ports.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';
import type {
  AddConceptNode,
  AddPrerequisiteEdge,
  CreateTaxonomyDraft,
  MoveConceptNode,
  PublishTaxonomyVersion,
  RemoveConceptNode,
} from '../commands/taxonomy-commands.js';

export interface TaxonomyHandlerDependencies {
  readonly versions: TaxonomyVersionRepository;
  readonly identities: ConceptIdentityRepository;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
}

export interface TaxonomyWriteResult {
  readonly taxonomyVersionId: string;
  readonly aggregateVersion: number;
}

const CURATOR = ['curriculum_curator', 'content_ops'] as const;
const PUBLISHER = ['content_ops'] as const;

function toApplicationError(error: RepositoryError): ApplicationError {
  return { kind: error.kind, code: error.code, message: error.message };
}

function domainError(error: { code: string; message: string; kind: string }): ApplicationError {
  return {
    kind: error.kind === 'Validation' ? 'Validation' : 'RuleViolation',
    code: error.code,
    message: error.message,
  };
}

/**
 * Every taxonomy mutation follows the same shape: authorize, load one
 * aggregate, apply the domain operation, save it under its expected version,
 * then write the audit record. Exactly one aggregate is mutated per command.
 */
abstract class TaxonomyMutation<TCommand extends { taxonomyVersionId: string; expectedAggregateVersion: number }>
  implements Handler<TCommand, TaxonomyWriteResult>
{
  abstract readonly name: string;
  abstract readonly policy: ReturnType<typeof policy>;

  constructor(protected readonly deps: TaxonomyHandlerDependencies) {}

  protected abstract apply(
    version: TaxonomyVersion,
    command: TCommand,
    context: ApplicationContext,
  ): Promise<Result<TaxonomyVersion, ApplicationError>>;

  async handle(
    command: TCommand,
    context: ApplicationContext,
  ): Promise<Result<TaxonomyWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.versions.findById(command.taxonomyVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const applied = await this.apply(loaded.value.aggregate, command, context);
    if (!applied.ok) return applied;

    const saved = await this.deps.versions.update(applied.value, command.expectedAggregateVersion);
    if (!saved.ok) return err(toApplicationError(saved.error));

    return ok(await this.recordAudit(saved.value, context));
  }

  protected async recordAudit(
    saved: Persisted<TaxonomyVersion>,
    context: ApplicationContext,
  ): Promise<TaxonomyWriteResult> {
    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'TaxonomyVersion',
      targetId: saved.aggregate.taxonomyVersionId,
      targetVersion: saved.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return {
      taxonomyVersionId: saved.aggregate.taxonomyVersionId,
      aggregateVersion: saved.aggregateVersion,
    };
  }
}

export class CreateTaxonomyDraftHandler implements Handler<CreateTaxonomyDraft, TaxonomyWriteResult> {
  readonly name = 'CreateTaxonomyDraft';
  readonly policy = policy(this.name, CURATOR);

  constructor(private readonly deps: TaxonomyHandlerDependencies) {}

  async handle(
    command: CreateTaxonomyDraft,
    context: ApplicationContext,
  ): Promise<Result<TaxonomyWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const draft = TaxonomyVersion.createDraft({
      taxonomyVersionId: this.deps.identifiers.next(),
      examFamily: command.examFamily,
      academicYear: command.academicYear,
    });
    if (!draft.ok) return err(domainError(draft.error));

    const saved = await this.deps.versions.insert(draft.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'TaxonomyVersion',
      targetId: draft.value.taxonomyVersionId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({
      taxonomyVersionId: draft.value.taxonomyVersionId,
      aggregateVersion: saved.value.aggregateVersion,
    });
  }
}

export class AddConceptNodeHandler extends TaxonomyMutation<AddConceptNode> {
  readonly name = 'AddConceptNode';
  readonly policy = policy('AddConceptNode', CURATOR);

  protected async apply(
    version: TaxonomyVersion,
    command: AddConceptNode,
  ): Promise<Result<TaxonomyVersion, ApplicationError>> {
    const identity = await this.deps.identities.findById(command.conceptIdentityId);
    if (!identity.ok) return err(toApplicationError(identity.error));

    const props = {
      conceptNodeId: this.deps.identifiers.next(),
      conceptIdentityId: command.conceptIdentityId,
      displayName: command.displayName,
      examWeight: command.examWeight,
      estimatedTeachingHours: command.estimatedTeachingHours,
    };

    if (command.parentNodeId === undefined) {
      const root = ConceptNode.createRoot(props);
      if (!root.ok) return err(domainError(root.error));
      const added = version.addConceptNode(root.value, identity.value.aggregate);
      return added.ok ? ok(added.value) : err(domainError(added.error));
    }

    const parent = version.nodeById(command.parentNodeId);
    if (parent === undefined) {
      return err({
        kind: 'NotFound',
        code: 'PARENT_NODE_NOT_FOUND',
        message: `parent node ${command.parentNodeId} is not in version ${command.taxonomyVersionId}`,
      });
    }

    const child = ConceptNode.createUnder(parent, props);
    if (!child.ok) return err(domainError(child.error));

    const added = version.addConceptNode(child.value, identity.value.aggregate);
    return added.ok ? ok(added.value) : err(domainError(added.error));
  }
}

export class MoveConceptNodeHandler extends TaxonomyMutation<MoveConceptNode> {
  readonly name = 'MoveConceptNode';
  readonly policy = policy('MoveConceptNode', CURATOR);

  protected async apply(
    version: TaxonomyVersion,
    command: MoveConceptNode,
  ): Promise<Result<TaxonomyVersion, ApplicationError>> {
    const moved = version.moveConceptNode(command.conceptNodeId, command.newParentNodeId);
    return moved.ok ? ok(moved.value) : err(domainError(moved.error));
  }
}

export class RemoveConceptNodeHandler extends TaxonomyMutation<RemoveConceptNode> {
  readonly name = 'RemoveConceptNode';
  readonly policy = policy('RemoveConceptNode', CURATOR);

  protected async apply(
    version: TaxonomyVersion,
    command: RemoveConceptNode,
  ): Promise<Result<TaxonomyVersion, ApplicationError>> {
    const removed = version.removeConceptNode(command.conceptNodeId);
    return removed.ok ? ok(removed.value) : err(domainError(removed.error));
  }
}

export class AddPrerequisiteEdgeHandler extends TaxonomyMutation<AddPrerequisiteEdge> {
  readonly name = 'AddPrerequisiteEdge';
  readonly policy = policy('AddPrerequisiteEdge', CURATOR);

  protected async apply(
    version: TaxonomyVersion,
    command: AddPrerequisiteEdge,
  ): Promise<Result<TaxonomyVersion, ApplicationError>> {
    const edge = PrerequisiteEdge.create({
      fromConceptIdentityId: command.fromConceptIdentityId,
      toConceptIdentityId: command.toConceptIdentityId,
      strength: command.strength,
    });
    if (!edge.ok) return err(domainError(edge.error));

    const added = version.addPrerequisiteEdge(edge.value);
    return added.ok ? ok(added.value) : err(domainError(added.error));
  }
}

export class PublishTaxonomyVersionHandler extends TaxonomyMutation<PublishTaxonomyVersion> {
  readonly name = 'PublishTaxonomyVersion';
  readonly policy = policy('PublishTaxonomyVersion', PUBLISHER, true);

  protected async apply(
    version: TaxonomyVersion,
    _command: PublishTaxonomyVersion,
    context: ApplicationContext,
  ): Promise<Result<TaxonomyVersion, ApplicationError>> {
    const published = version.publish(context.principal, this.deps.clock.now());
    return published.ok
      ? ok(published.value)
      : err({
          kind: 'RuleViolation',
          code: published.error.code,
          message: published.error.message,
          ...(published.error.violations !== undefined ? { detail: published.error.violations } : {}),
        });
  }
}

export function taxonomyHandlers(deps: TaxonomyHandlerDependencies): readonly Handler<never, unknown>[] {
  return [
    new CreateTaxonomyDraftHandler(deps),
    new AddConceptNodeHandler(deps),
    new MoveConceptNodeHandler(deps),
    new RemoveConceptNodeHandler(deps),
    new AddPrerequisiteEdgeHandler(deps),
    new PublishTaxonomyVersionHandler(deps),
  ] as unknown as readonly Handler<never, unknown>[];
}
