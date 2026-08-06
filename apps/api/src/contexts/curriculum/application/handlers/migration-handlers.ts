import { err, ok, type Result } from '../../domain/result.js';
import { TaxonomyMapping } from '../../domain/taxonomy-mapping.js';
import { TaxonomyMigration } from '../../domain/taxonomy-migration.js';
import {
  allExceptionsDispositioned,
  runMigrationDryRun,
  type MigrationDryRunResult,
} from '../../domain/migration-dry-run.js';
import type { RepositoryError, TaxonomyVersionRepository } from '../../domain/repository-ports.js';
import type { DrizzleTaxonomyMigrationRepository } from '../../infrastructure/taxonomy-migration.repository.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory } from '../ports.js';
import type {
  AddMapping,
  CreateMigration,
  ExecuteMigration,
  RunDryRun,
} from '../commands/migration-commands.js';

export interface MigrationRepositoryPort {
  insert: DrizzleTaxonomyMigrationRepository['insert'];
  update: DrizzleTaxonomyMigrationRepository['update'];
  findById: DrizzleTaxonomyMigrationRepository['findById'];
}

/**
 * Applies a migration's effects outside the curriculum context — retagging
 * content, remapping mastery — one chunk at a time. Execution is never a single
 * long transaction (BACKEND-ARCHITECTURE §6), so the executor is asked what it
 * has already done and the handler resumes from there.
 */
export interface MigrationExecutor {
  migratedConcepts(migrationId: string): Promise<readonly string[]>;
  migrateChunk(migrationId: string, mappings: readonly TaxonomyMapping[]): Promise<void>;
}

export interface MigrationHandlerDependencies {
  readonly migrations: MigrationRepositoryPort;
  readonly versions: TaxonomyVersionRepository;
  readonly executor: MigrationExecutor;
  readonly audit: AuditRecorder;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
}

export interface MigrationWriteResult {
  readonly migrationId: string;
  readonly aggregateVersion: number;
}

export interface DryRunResultView extends MigrationWriteResult {
  readonly dryRun: MigrationDryRunResult;
}

export interface ExecutionResultView extends MigrationWriteResult {
  readonly migratedConceptCount: number;
  readonly chunkCount: number;
}

const MIGRATION_AUTHOR = ['curriculum_curator', 'content_ops'] as const;
const MIGRATION_EXECUTOR = ['content_ops'] as const;
const DEFAULT_CHUNK_SIZE = 100;

function toApplicationError(error: RepositoryError): ApplicationError {
  return { kind: error.kind, code: error.code, message: error.message };
}

function domainError(error: { kind: string; code: string; message: string }): ApplicationError {
  return {
    kind: error.kind === 'Validation' ? 'Validation' : 'RuleViolation',
    code: error.code,
    message: error.message,
  };
}

export class CreateMigrationHandler implements Handler<CreateMigration, MigrationWriteResult> {
  readonly name = 'CreateMigration';
  readonly policy = policy('CreateMigration', MIGRATION_AUTHOR);

  constructor(private readonly deps: MigrationHandlerDependencies) {}

  async handle(
    command: CreateMigration,
    context: ApplicationContext,
  ): Promise<Result<MigrationWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const from = await this.deps.versions.findById(command.fromVersionId);
    if (!from.ok) return err(toApplicationError(from.error));

    const to = await this.deps.versions.findById(command.toVersionId);
    if (!to.ok) return err(toApplicationError(to.error));

    const created = TaxonomyMigration.create({
      migrationId: this.deps.identifiers.next(),
      fromVersionId: command.fromVersionId,
      toVersionId: command.toVersionId,
      sourceConcepts: from.value.aggregate.nodes.map((node) => node.conceptIdentityId),
      targetConcepts: to.value.aggregate.nodes.map((node) => node.conceptIdentityId),
    });
    if (!created.ok) return err(domainError(created.error));

    const saved = await this.deps.migrations.insert(created.value);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.audit(created.value.migrationId, saved.value.aggregateVersion, context);
    return ok({ migrationId: created.value.migrationId, aggregateVersion: saved.value.aggregateVersion });
  }

  protected async audit(
    migrationId: string,
    aggregateVersion: number,
    context: ApplicationContext,
  ): Promise<void> {
    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'TaxonomyMigration',
      targetId: migrationId,
      targetVersion: aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
  }
}

export class AddMappingHandler implements Handler<AddMapping, MigrationWriteResult> {
  readonly name = 'AddMapping';
  readonly policy = policy('AddMapping', MIGRATION_AUTHOR);

  constructor(private readonly deps: MigrationHandlerDependencies) {}

  async handle(
    command: AddMapping,
    context: ApplicationContext,
  ): Promise<Result<MigrationWriteResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.migrations.findById(command.migrationId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const mapping = TaxonomyMapping.create({
      kind: command.kind,
      from: command.from,
      to: command.to,
      ...(command.disposition !== undefined ? { disposition: command.disposition } : {}),
    });
    if (!mapping.ok) return err(domainError(mapping.error));

    const added = loaded.value.aggregate.addMapping(mapping.value);
    if (!added.ok) return err(domainError(added.error));

    const saved = await this.deps.migrations.update(
      added.value,
      command.expectedAggregateVersion,
      loaded.value.dryRunResult,
    );
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'TaxonomyMigration',
      targetId: command.migrationId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({ migrationId: command.migrationId, aggregateVersion: saved.value.aggregateVersion });
  }
}

export class RunDryRunHandler implements Handler<RunDryRun, DryRunResultView> {
  readonly name = 'RunDryRun';
  readonly policy = policy('RunDryRun', MIGRATION_AUTHOR);

  constructor(private readonly deps: MigrationHandlerDependencies) {}

  async handle(
    command: RunDryRun,
    context: ApplicationContext,
  ): Promise<Result<DryRunResultView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.migrations.findById(command.migrationId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    // Pure: the aggregate is unchanged, only the stored preview is written.
    const dryRun = runMigrationDryRun(loaded.value.aggregate);

    const saved = await this.deps.migrations.update(
      loaded.value.aggregate,
      command.expectedAggregateVersion,
      dryRun,
    );
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'TaxonomyMigration',
      targetId: command.migrationId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({
      migrationId: command.migrationId,
      aggregateVersion: saved.value.aggregateVersion,
      dryRun,
    });
  }
}

export class ExecuteMigrationHandler implements Handler<ExecuteMigration, ExecutionResultView> {
  readonly name = 'ExecuteMigration';
  readonly policy = policy('ExecuteMigration', MIGRATION_EXECUTOR, true);

  constructor(private readonly deps: MigrationHandlerDependencies) {}

  async handle(
    command: ExecuteMigration,
    context: ApplicationContext,
  ): Promise<Result<ExecutionResultView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.migrations.findById(command.migrationId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const dryRun = loaded.value.dryRunResult;
    if (dryRun === null) {
      return err({
        kind: 'RuleViolation',
        code: 'DRY_RUN_REQUIRED',
        message: `migration ${command.migrationId} cannot execute before a dry run`,
      });
    }

    if (!allExceptionsDispositioned(dryRun)) {
      return err({
        kind: 'RuleViolation',
        code: 'EXCEPTIONS_UNDISPOSITIONED',
        message: `migration ${command.migrationId} still has undispositioned exceptions`,
        detail: dryRun.exceptions.filter((exception) => exception.disposition === 'pending'),
      });
    }

    let migration = loaded.value.aggregate;
    let aggregateVersion = command.expectedAggregateVersion;

    if (migration.state === 'draft') {
      const executing = migration.transitionTo('executing');
      if (!executing.ok) return err(domainError(executing.error));

      const marked = await this.deps.migrations.update(executing.value, aggregateVersion, dryRun);
      if (!marked.ok) return err(toApplicationError(marked.error));
      migration = marked.value.aggregate;
      aggregateVersion = marked.value.aggregateVersion;
    }

    const { chunkCount, migratedConceptCount } = await this.runChunks(migration, command.chunkSize);

    const executed = migration.transitionTo('executed');
    if (!executed.ok) return err(domainError(executed.error));

    const saved = await this.deps.migrations.update(executed.value, aggregateVersion, dryRun);
    if (!saved.ok) return err(toApplicationError(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'curriculum',
      targetType: 'TaxonomyMigration',
      targetId: command.migrationId,
      targetVersion: saved.value.aggregateVersion,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({
      migrationId: command.migrationId,
      aggregateVersion: saved.value.aggregateVersion,
      migratedConceptCount,
      chunkCount,
    });
  }

  /** Applies the outstanding mappings in chunks, skipping anything already done. */
  private async runChunks(
    migration: TaxonomyMigration,
    chunkSize = DEFAULT_CHUNK_SIZE,
  ): Promise<{ chunkCount: number; migratedConceptCount: number }> {
    const alreadyMigrated = new Set(await this.deps.executor.migratedConcepts(migration.migrationId));
    const outstanding = migration.mappings.filter(
      (mapping) => !mapping.conceptIds.every((conceptId) => alreadyMigrated.has(conceptId)),
    );

    let chunkCount = 0;
    for (let index = 0; index < outstanding.length; index += chunkSize) {
      await this.deps.executor.migrateChunk(
        migration.migrationId,
        outstanding.slice(index, index + chunkSize),
      );
      chunkCount += 1;
    }

    const migrated = await this.deps.executor.migratedConcepts(migration.migrationId);
    return { chunkCount, migratedConceptCount: migrated.length };
  }
}

export function migrationHandlers(
  deps: MigrationHandlerDependencies,
): readonly Handler<never, unknown>[] {
  return [
    new CreateMigrationHandler(deps),
    new AddMappingHandler(deps),
    new RunDryRunHandler(deps),
    new ExecuteMigrationHandler(deps),
  ] as unknown as readonly Handler<never, unknown>[];
}
