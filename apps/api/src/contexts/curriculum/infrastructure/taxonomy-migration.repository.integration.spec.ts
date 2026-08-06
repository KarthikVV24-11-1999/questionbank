import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ConceptIdentity } from '../domain/concept-identity.js';
import { ConceptNode } from '../domain/concept-node.js';
import { TaxonomyVersion } from '../domain/taxonomy-version.js';
import { TaxonomyMapping, type MappingKind } from '../domain/taxonomy-mapping.js';
import { TaxonomyMigration } from '../domain/taxonomy-migration.js';
import { runMigrationDryRun } from '../domain/migration-dry-run.js';
import { DrizzleConceptIdentityRepository } from './concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from './taxonomy-version.repository.js';
import { DrizzleTaxonomyMigrationRepository } from './taxonomy-migration.repository.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

let database: TestDatabase;
let identities: DrizzleConceptIdentityRepository;
let versions: DrizzleTaxonomyVersionRepository;
let migrations: DrizzleTaxonomyMigrationRepository;

let fromVersionId: string;
let toVersionId: string;
let source: string[];
let target: string[];

/** A version holding `names.length` concepts, each on its own node. */
async function versionWith(names: readonly string[]): Promise<{ versionId: string; conceptIds: string[] }> {
  const versionId = randomUUID();
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

function migration(): TaxonomyMigration {
  return expectValue(
    TaxonomyMigration.create({
      migrationId: randomUUID(),
      fromVersionId,
      toVersionId,
      sourceConcepts: source,
      targetConcepts: target,
    }),
  );
}

function mapping(kind: MappingKind, from: string[], to: string[]): TaxonomyMapping {
  return expectValue(TaxonomyMapping.create({ kind, from, to }));
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  identities = new DrizzleConceptIdentityRepository(database.db);
  versions = new DrizzleTaxonomyVersionRepository(database.db);
  migrations = new DrizzleTaxonomyMigrationRepository(database.db);
});

beforeEach(async () => {
  await database.truncateAll();
  const from = await versionWith(['Mechanics', 'Optics', 'Thermodynamics']);
  const to = await versionWith(['Mechanics', 'Ray Optics', 'Wave Optics']);
  fromVersionId = from.versionId;
  toVersionId = to.versionId;
  source = from.conceptIds;
  target = to.conceptIds;
});

afterAll(async () => {
  await database.close();
});

describe('TaxonomyMigration repository round-trip', () => {
  it('preserves mapping kinds, cardinality and order', async () => {
    const withMappings = expectValue(
      expectValue(
        migration().addMapping(
          mapping('SPLIT', [source[1] as string], [target[1] as string, target[2] as string]),
        ),
      ).addMapping(mapping('REMOVAL', [source[2] as string], [])),
    );

    expectValue(await migrations.insert(withMappings));
    const loaded = expectValue(await migrations.findById(withMappings.migrationId));

    expect(loaded.aggregate.mappings.map((entry) => entry.kind)).toEqual(['SPLIT', 'REMOVAL']);
    expect(loaded.aggregate.mappings[0]?.from).toEqual([source[1]]);
    expect(loaded.aggregate.mappings[0]?.to).toEqual([target[1], target[2]]);
    expect(loaded.aggregate.mappings[1]?.to).toEqual([]);
    expect(loaded.aggregate.fromVersionId).toBe(fromVersionId);
    expect(loaded.aggregate.toVersionId).toBe(toVersionId);
  });

  it('round-trips every mapping kind', async () => {
    const identityMapping = mapping('IDENTITY', [source[0] as string], [target[0] as string]);
    const renameMapping = mapping('RENAME', [source[1] as string], [target[1] as string]);
    const removalMapping = mapping('REMOVAL', [source[2] as string], []);
    const subject = [identityMapping, renameMapping, removalMapping].reduce(
      (current, entry) => expectValue(current.addMapping(entry)),
      migration(),
    );

    expectValue(await migrations.insert(subject));
    const loaded = expectValue(await migrations.findById(subject.migrationId));

    expect(loaded.aggregate.mappings.map((entry) => entry.kind)).toEqual([
      'IDENTITY',
      'RENAME',
      'REMOVAL',
    ]);
  });

  it('preserves dispositions', async () => {
    const subject = expectValue(
      migration().addMapping(
        mapping('MERGE', [source[1] as string, source[2] as string], [target[1] as string]),
      ),
    );
    expectValue(await migrations.insert(subject));

    const dispositioned = expectValue(
      subject.replaceMapping(0, (subject.mappings[0] as TaxonomyMapping).withDisposition('accepted')),
    );
    expectValue(await migrations.update(dispositioned, 1));

    const loaded = expectValue(await migrations.findById(subject.migrationId));
    expect(loaded.aggregate.mappings[0]?.disposition).toBe('accepted');
  });

  it('reports NotFound for an unknown migration', async () => {
    expect(expectError(await migrations.findById(randomUUID())).code).toBe('NOT_FOUND');
  });
});

describe('dry-run persistence', () => {
  it('stores the dry-run result as JSONB with its schema version', async () => {
    const subject = expectValue(
      migration().addMapping(
        mapping('SPLIT', [source[1] as string], [target[1] as string, target[2] as string]),
      ),
    );
    expectValue(await migrations.insert(subject));

    const dryRun = runMigrationDryRun(subject);
    expectValue(await migrations.update(subject, 1, dryRun));

    const loaded = expectValue(await migrations.findById(subject.migrationId));
    expect(loaded.dryRunResult).toEqual(JSON.parse(JSON.stringify(dryRun)));
    expect(loaded.dryRunResult?.exceptions.map((exception) => exception.kind)).toEqual([
      'AMBIGUOUS_MAPPING',
      'UNMAPPED',
      'UNMAPPED',
    ]);

    const stored = await database.pool.query<{ dry_run_result_schema_version: number }>(
      `SELECT dry_run_result_schema_version FROM curriculum.taxonomy_migration WHERE migration_id = $1`,
      [subject.migrationId],
    );
    expect(stored.rows[0]?.dry_run_result_schema_version).toBe(1);
  });

  it('leaves the dry-run result null until one is run', async () => {
    const subject = migration();
    expectValue(await migrations.insert(subject));

    expect(expectValue(await migrations.findById(subject.migrationId)).dryRunResult).toBeNull();
  });
});

describe('state guard', () => {
  it('restores the stored state', async () => {
    const subject = migration();
    expectValue(await migrations.insert(subject));

    const executing = expectValue(subject.transitionTo('executing'));
    expectValue(await migrations.update(executing, 1));

    expect(expectValue(await migrations.findById(subject.migrationId)).aggregate.state).toBe('executing');
  });

  it('refuses to modify a migration that is executing', async () => {
    const subject = migration();
    expectValue(await migrations.insert(subject));
    const executing = expectValue(subject.transitionTo('executing'));
    expectValue(await migrations.update(executing, 1));

    const error = expectError(await migrations.update(executing, 2));

    expect(error.code).toBe('CONFLICT');
    expect(error.message).toContain('executing');
  });

  it('permits the move out of executing to executed', async () => {
    const subject = migration();
    expectValue(await migrations.insert(subject));
    const executing = expectValue(subject.transitionTo('executing'));
    expectValue(await migrations.update(executing, 1));

    const executed = expectValue(executing.transitionTo('executed'));
    expectValue(await migrations.update(executed, 2));

    expect(expectValue(await migrations.findById(subject.migrationId)).aggregate.state).toBe('executed');
  });

  it('raises Conflict on a stale write', async () => {
    const subject = migration();
    expectValue(await migrations.insert(subject));

    expectValue(await migrations.update(subject, 1));
    expect(expectError(await migrations.update(subject, 1)).code).toBe('CONFLICT');
  });
});
