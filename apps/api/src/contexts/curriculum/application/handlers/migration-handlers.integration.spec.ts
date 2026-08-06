import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../../domain/concept-identity.js';
import { ConceptNode } from '../../domain/concept-node.js';
import { TaxonomyVersion } from '../../domain/taxonomy-version.js';
import type { TaxonomyMapping } from '../../domain/taxonomy-mapping.js';
import { DrizzleConceptIdentityRepository } from '../../infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../infrastructure/taxonomy-version.repository.js';
import { DrizzleTaxonomyMigrationRepository } from '../../infrastructure/taxonomy-migration.repository.js';
import { HandlerRegistry } from '../handler-registry.js';
import { InMemoryAuditRecorder, type ApplicationContext } from '../ports.js';
import {
  AddMappingHandler,
  CreateMigrationHandler,
  ExecuteMigrationHandler,
  RunDryRunHandler,
  migrationHandlers,
  type MigrationExecutor,
  type MigrationHandlerDependencies,
} from './migration-handlers.js';
import { FixedClock } from '../../../../testing/in-memory-repositories.js';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

let database: TestDatabase;
let deps: MigrationHandlerDependencies;
let audit: InMemoryAuditRecorder;
let executor: RecordingExecutor;
let fromVersionId: string;
let toVersionId: string;
let source: string[];
let target: string[];

const ops: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['content_ops'] };
const curator: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['curriculum_curator'] };
const learner: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['learner'] };

function contextFor(principal: PrincipalRef, stepUpSatisfied = true): ApplicationContext {
  return { principal, stepUpSatisfied, correlationId: 'corr_migration' };
}

/** Records what it migrated, and can be told to fail partway through. */
class RecordingExecutor implements MigrationExecutor {
  readonly migrated = new Set<string>();
  readonly chunkSizes: number[] = [];
  failAfterChunks: number | undefined;

  async migratedConcepts(): Promise<readonly string[]> {
    return [...this.migrated];
  }

  async migrateChunk(_migrationId: string, mappings: readonly TaxonomyMapping[]): Promise<void> {
    if (this.failAfterChunks !== undefined && this.chunkSizes.length >= this.failAfterChunks) {
      throw new Error('executor connection lost');
    }
    this.chunkSizes.push(mappings.length);
    for (const mapping of mappings) {
      for (const conceptId of mapping.conceptIds) this.migrated.add(conceptId);
    }
  }
}

async function versionWith(names: readonly string[]): Promise<{ versionId: string; conceptIds: string[] }> {
  const versionId = randomUUID();
  const identities = new DrizzleConceptIdentityRepository(database.db);
  const versions = new DrizzleTaxonomyVersionRepository(database.db);

  let version = expectValue(
    TaxonomyVersion.createDraft({ taxonomyVersionId: versionId, examFamily: 'JEE', academicYear: '2026' }),
  );
  expectValue(await versions.insert(version));

  const conceptIds: string[] = [];
  let root: ConceptNode | undefined;
  for (const name of names) {
    const identity = expectValue(
      ConceptIdentity.create({
        conceptIdentityId: randomUUID(),
        canonicalName: name,
        subjectDomain: 'physics',
        createdInVersion: versionId,
      }),
    );
    expectValue(await identities.insert(identity));

    const node =
      root === undefined
        ? expectValue(
            ConceptNode.createRoot({
              conceptNodeId: randomUUID(),
              conceptIdentityId: identity.conceptIdentityId,
              displayName: name,
              examWeight: 1,
              estimatedTeachingHours: 10,
            }),
          )
        : expectValue(
            ConceptNode.createUnder(root, {
              conceptNodeId: randomUUID(),
              conceptIdentityId: identity.conceptIdentityId,
              displayName: name,
              examWeight: 0.1,
              estimatedTeachingHours: 10,
            }),
          );
    root ??= node;
    version = expectValue(version.addConceptNode(node, identity));
    conceptIds.push(identity.conceptIdentityId);
  }

  expectValue(await versions.update(version, 1));
  return { versionId, conceptIds };
}

/** A migration whose every source concept is mapped by an auto-migratable kind. */
async function fullyMappedMigration(): Promise<{ migrationId: string; aggregateVersion: number }> {
  const created = expectValue(
    await new CreateMigrationHandler(deps).handle({ fromVersionId, toVersionId }, contextFor(curator)),
  );

  let aggregateVersion = created.aggregateVersion;
  for (const [index, conceptId] of source.entries()) {
    const added = expectValue(
      await new AddMappingHandler(deps).handle(
        {
          migrationId: created.migrationId,
          kind: index === 0 ? 'IDENTITY' : 'RENAME',
          from: [conceptId],
          to: [target[index] as string],
          expectedAggregateVersion: aggregateVersion,
        },
        contextFor(curator),
      ),
    );
    aggregateVersion = added.aggregateVersion;
  }

  return { migrationId: created.migrationId, aggregateVersion };
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

beforeEach(async () => {
  await database.truncateAll();
  audit = new InMemoryAuditRecorder();
  executor = new RecordingExecutor();
  deps = {
    migrations: new DrizzleTaxonomyMigrationRepository(database.db),
    versions: new DrizzleTaxonomyVersionRepository(database.db),
    executor,
    audit,
    clock: new FixedClock(),
    identifiers: { next: () => randomUUID() },
  };

  const from = await versionWith(['Mechanics', 'Optics', 'Thermodynamics']);
  const to = await versionWith(['Mechanics', 'Ray Optics', 'Heat']);
  fromVersionId = from.versionId;
  toVersionId = to.versionId;
  source = from.conceptIds;
  target = to.conceptIds;
});

afterAll(async () => {
  await database.close();
});

describe('migration handler registry', () => {
  it('registers all four commands with a policy each', () => {
    const registry = HandlerRegistry.of(migrationHandlers(deps));

    expect(registry.names).toEqual(['CreateMigration', 'AddMapping', 'RunDryRun', 'ExecuteMigration']);
    expect(registry.get('ExecuteMigration')?.policy.requiresStepUp).toBe(true);
    expect(registry.get('RunDryRun')?.policy.requiresStepUp).toBe(false);
  });
});

describe('authorization negative paths', () => {
  it('denies every command to a principal without the role', async () => {
    const context = contextFor(learner);

    expect(expectError(await new CreateMigrationHandler(deps).handle({ fromVersionId, toVersionId }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new AddMappingHandler(deps).handle({ migrationId: 'm', kind: 'IDENTITY', from: ['a'], to: ['a'], expectedAggregateVersion: 1 }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new RunDryRunHandler(deps).handle({ migrationId: 'm', expectedAggregateVersion: 1 }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new ExecuteMigrationHandler(deps).handle({ migrationId: 'm', expectedAggregateVersion: 1 }, context)).code).toBe('NOT_PERMITTED');
  });

  it('denies execution to a curator who is not content ops', async () => {
    const { migrationId, aggregateVersion } = await fullyMappedMigration();

    expect(
      expectError(
        await new ExecuteMigrationHandler(deps).handle({ migrationId, expectedAggregateVersion: aggregateVersion }, contextFor(curator)),
      ).code,
    ).toBe('NOT_PERMITTED');
  });

  it('requires step-up to execute', async () => {
    const { migrationId, aggregateVersion } = await fullyMappedMigration();

    expect(
      expectError(
        await new ExecuteMigrationHandler(deps).handle(
          { migrationId, expectedAggregateVersion: aggregateVersion },
          contextFor(ops, false),
        ),
      ).code,
    ).toBe('STEP_UP_REQUIRED');
    expect(executor.chunkSizes).toEqual([]);
  });
});

describe('migration workflow', () => {
  it('creates a migration between two stored versions', async () => {
    const created = expectValue(
      await new CreateMigrationHandler(deps).handle({ fromVersionId, toVersionId }, contextFor(curator)),
    );

    const loaded = expectValue(await deps.migrations.findById(created.migrationId));
    expect(loaded.aggregate.sourceConcepts.size).toBe(3);
    expect(loaded.aggregate.targetConcepts.size).toBe(3);
    expect(audit.entries.at(-1)?.action).toBe('CreateMigration');
  });

  it('reports an unknown version', async () => {
    expect(
      expectError(
        await new CreateMigrationHandler(deps).handle(
          { fromVersionId: randomUUID(), toVersionId },
          contextFor(curator),
        ),
      ).kind,
    ).toBe('NotFound');
  });

  it('runs a dry run and stores it without changing the migration', async () => {
    const created = expectValue(
      await new CreateMigrationHandler(deps).handle({ fromVersionId, toVersionId }, contextFor(curator)),
    );
    const withSplit = expectValue(
      await new AddMappingHandler(deps).handle(
        {
          migrationId: created.migrationId,
          kind: 'SPLIT',
          from: [source[1] as string],
          to: [target[1] as string, target[2] as string],
          expectedAggregateVersion: created.aggregateVersion,
        },
        contextFor(curator),
      ),
    );

    const view = expectValue(
      await new RunDryRunHandler(deps).handle(
        { migrationId: created.migrationId, expectedAggregateVersion: withSplit.aggregateVersion },
        contextFor(curator),
      ),
    );

    expect(view.dryRun.autoMigratableCount).toBe(0);
    expect(view.dryRun.exceptions.map((exception) => exception.kind)).toEqual([
      'AMBIGUOUS_MAPPING',
      'UNMAPPED',
      'UNMAPPED',
    ]);
    const loaded = expectValue(await deps.migrations.findById(created.migrationId));
    expect(loaded.aggregate.state).toBe('draft');
    expect(loaded.dryRunResult?.exceptions).toHaveLength(3);
  });
});

describe('execution gate', () => {
  it('rejects execution before any dry run', async () => {
    const { migrationId, aggregateVersion } = await fullyMappedMigration();

    const error = expectError(
      await new ExecuteMigrationHandler(deps).handle({ migrationId, expectedAggregateVersion: aggregateVersion }, contextFor(ops)),
    );

    expect(error.code).toBe('DRY_RUN_REQUIRED');
    expect(executor.chunkSizes).toEqual([]);
    expect(expectValue(await deps.migrations.findById(migrationId)).aggregate.state).toBe('draft');
  });

  it('rejects execution while an exception is undispositioned', async () => {
    const created = expectValue(
      await new CreateMigrationHandler(deps).handle({ fromVersionId, toVersionId }, contextFor(curator)),
    );
    const withSplit = expectValue(
      await new AddMappingHandler(deps).handle(
        {
          migrationId: created.migrationId,
          kind: 'SPLIT',
          from: [source[1] as string],
          to: [target[1] as string, target[2] as string],
          expectedAggregateVersion: created.aggregateVersion,
        },
        contextFor(curator),
      ),
    );
    const dryRun = expectValue(
      await new RunDryRunHandler(deps).handle(
        { migrationId: created.migrationId, expectedAggregateVersion: withSplit.aggregateVersion },
        contextFor(curator),
      ),
    );

    const error = expectError(
      await new ExecuteMigrationHandler(deps).handle(
        { migrationId: created.migrationId, expectedAggregateVersion: dryRun.aggregateVersion },
        contextFor(ops),
      ),
    );

    expect(error.code).toBe('EXCEPTIONS_UNDISPOSITIONED');
    expect(Array.isArray(error.detail)).toBe(true);
    expect(executor.chunkSizes).toEqual([]);
  });

  it('executes once every concept is mapped and every exception dispositioned', async () => {
    const { migrationId, aggregateVersion } = await fullyMappedMigration();
    const dryRun = expectValue(
      await new RunDryRunHandler(deps).handle({ migrationId, expectedAggregateVersion: aggregateVersion }, contextFor(curator)),
    );
    expect(dryRun.dryRun.exceptions).toEqual([]);

    const executed = expectValue(
      await new ExecuteMigrationHandler(deps).handle(
        { migrationId, expectedAggregateVersion: dryRun.aggregateVersion },
        contextFor(ops),
      ),
    );

    expect(executed.migratedConceptCount).toBeGreaterThan(0);
    expect(expectValue(await deps.migrations.findById(migrationId)).aggregate.state).toBe('executed');
    expect(audit.entries.at(-1)?.action).toBe('ExecuteMigration');
  });
});

describe('chunked, resumable execution', () => {
  it('never migrates more than one chunk at a time', async () => {
    const { migrationId, aggregateVersion } = await fullyMappedMigration();
    const dryRun = expectValue(
      await new RunDryRunHandler(deps).handle({ migrationId, expectedAggregateVersion: aggregateVersion }, contextFor(curator)),
    );

    const executed = expectValue(
      await new ExecuteMigrationHandler(deps).handle(
        { migrationId, expectedAggregateVersion: dryRun.aggregateVersion, chunkSize: 1 },
        contextFor(ops),
      ),
    );

    expect(executor.chunkSizes).toEqual([1, 1, 1]);
    expect(executed.chunkCount).toBe(3);
  });

  it('resumes after an interruption without redoing finished work', async () => {
    const { migrationId, aggregateVersion } = await fullyMappedMigration();
    const dryRun = expectValue(
      await new RunDryRunHandler(deps).handle({ migrationId, expectedAggregateVersion: aggregateVersion }, contextFor(curator)),
    );

    executor.failAfterChunks = 2;
    await expect(
      new ExecuteMigrationHandler(deps).handle(
        { migrationId, expectedAggregateVersion: dryRun.aggregateVersion, chunkSize: 1 },
        contextFor(ops),
      ),
    ).rejects.toThrow(/connection lost/u);

    const interrupted = expectValue(await deps.migrations.findById(migrationId));
    expect(interrupted.aggregate.state).toBe('executing');
    expect(executor.chunkSizes).toEqual([1, 1]);

    executor.failAfterChunks = undefined;
    const resumed = expectValue(
      await new ExecuteMigrationHandler(deps).handle(
        { migrationId, expectedAggregateVersion: interrupted.aggregateVersion, chunkSize: 1 },
        contextFor(ops),
      ),
    );

    // Only the third mapping was left, so exactly one further chunk ran.
    expect(executor.chunkSizes).toEqual([1, 1, 1]);
    expect(resumed.chunkCount).toBe(1);
    expect(expectValue(await deps.migrations.findById(migrationId)).aggregate.state).toBe('executed');
  });

  it('refuses to modify a migration that is executing', async () => {
    const { migrationId, aggregateVersion } = await fullyMappedMigration();
    const dryRun = expectValue(
      await new RunDryRunHandler(deps).handle({ migrationId, expectedAggregateVersion: aggregateVersion }, contextFor(curator)),
    );

    executor.failAfterChunks = 0;
    await expect(
      new ExecuteMigrationHandler(deps).handle(
        { migrationId, expectedAggregateVersion: dryRun.aggregateVersion, chunkSize: 1 },
        contextFor(ops),
      ),
    ).rejects.toThrow();

    const executing = expectValue(await deps.migrations.findById(migrationId));
    const error = expectError(
      await new AddMappingHandler(deps).handle(
        {
          migrationId,
          kind: 'IDENTITY',
          from: [source[0] as string],
          to: [target[0] as string],
          expectedAggregateVersion: executing.aggregateVersion,
        },
        contextFor(curator),
      ),
    );

    expect(error.code).toBe('MIGRATION_NOT_MUTABLE');
  });
});
