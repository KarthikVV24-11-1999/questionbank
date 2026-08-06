import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../../domain/concept-identity.js';
import { DrizzleConceptIdentityRepository } from '../../infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../infrastructure/taxonomy-version.repository.js';
import { InMemoryAuditRecorder, type ApplicationContext } from '../ports.js';
import {
  AddConceptNodeHandler,
  AddPrerequisiteEdgeHandler,
  CreateTaxonomyDraftHandler,
  PublishTaxonomyVersionHandler,
  type TaxonomyHandlerDependencies,
} from './taxonomy-handlers.js';
import { FixedClock } from '../../../../testing/in-memory-repositories.js';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

let database: TestDatabase;
let deps: TaxonomyHandlerDependencies;
let audit: InMemoryAuditRecorder;

const ops: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['content_ops', 'curriculum_curator'] };
const context: ApplicationContext = { principal: ops, stepUpSatisfied: true, correlationId: 'corr_int' };

async function countRows(table: string): Promise<number> {
  const result = await database.pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM ${table}`);
  return Number(result.rows[0]?.count);
}

async function seedIdentity(versionId: string, name: string, subjectDomain = 'physics'): Promise<string> {
  const identity = expectValue(
    ConceptIdentity.create({
      conceptIdentityId: randomUUID(),
      canonicalName: name,
      subjectDomain,
      createdInVersion: versionId,
    }),
  );
  expectValue(await deps.identities.insert(identity));
  return identity.conceptIdentityId;
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

beforeEach(async () => {
  await database.truncateAll();
  audit = new InMemoryAuditRecorder();
  deps = {
    versions: new DrizzleTaxonomyVersionRepository(database.db),
    identities: new DrizzleConceptIdentityRepository(database.db),
    audit,
    clock: new FixedClock(),
    identifiers: { next: () => randomUUID() },
  };
});

afterAll(async () => {
  await database.close();
});

describe('taxonomy handlers against a real database', () => {
  it('creates, populates and publishes a version', async () => {
    const created = expectValue(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'JEE', academicYear: '2026' },
        context,
      ),
    );
    const physics = await seedIdentity(created.taxonomyVersionId, 'Physics');
    const mechanics = await seedIdentity(created.taxonomyVersionId, 'Mechanics');

    const withRoot = expectValue(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          conceptIdentityId: physics,
          displayName: 'Physics',
          examWeight: 1,
          estimatedTeachingHours: 300,
          expectedAggregateVersion: created.aggregateVersion,
        },
        context,
      ),
    );

    const loaded = expectValue(await deps.versions.findById(created.taxonomyVersionId));
    const rootNodeId = loaded.aggregate.nodes[0]?.conceptNodeId as string;

    const withChild = expectValue(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          conceptIdentityId: mechanics,
          parentNodeId: rootNodeId,
          displayName: 'Mechanics',
          examWeight: 0.3,
          estimatedTeachingHours: 80,
          expectedAggregateVersion: withRoot.aggregateVersion,
        },
        context,
      ),
    );

    const withEdge = expectValue(
      await new AddPrerequisiteEdgeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          fromConceptIdentityId: physics,
          toConceptIdentityId: mechanics,
          strength: 0.6,
          expectedAggregateVersion: withChild.aggregateVersion,
        },
        context,
      ),
    );

    expectValue(
      await new PublishTaxonomyVersionHandler(deps).handle(
        { taxonomyVersionId: created.taxonomyVersionId, expectedAggregateVersion: withEdge.aggregateVersion },
        context,
      ),
    );

    const published = expectValue(await deps.versions.findById(created.taxonomyVersionId));
    expect(published.aggregate.state).toBe('published');
    expect(published.aggregate.nodes).toHaveLength(2);
    expect(published.aggregate.prerequisites).toHaveLength(1);
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      'CreateTaxonomyDraft',
      'AddConceptNode',
      'AddConceptNode',
      'AddPrerequisiteEdge',
      'PublishTaxonomyVersion',
    ]);
  });

  it('mutates exactly one aggregate per command', async () => {
    const created = expectValue(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'JEE', academicYear: '2026' },
        context,
      ),
    );
    const other = expectValue(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'NEET', academicYear: '2026' },
        context,
      ),
    );
    const physics = await seedIdentity(created.taxonomyVersionId, 'Physics');

    expectValue(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          conceptIdentityId: physics,
          displayName: 'Physics',
          examWeight: 1,
          estimatedTeachingHours: 300,
          expectedAggregateVersion: created.aggregateVersion,
        },
        context,
      ),
    );

    const untouched = expectValue(await deps.versions.findById(other.taxonomyVersionId));
    expect(untouched.aggregateVersion).toBe(1);
    expect(untouched.aggregate.nodes).toEqual([]);
  });

  it('leaves no partial write when the domain rejects the change', async () => {
    const created = expectValue(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'JEE', academicYear: '2026' },
        context,
      ),
    );
    const physics = await seedIdentity(created.taxonomyVersionId, 'Physics');
    const optics = await seedIdentity(created.taxonomyVersionId, 'Optics');

    const withRoot = expectValue(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          conceptIdentityId: physics,
          displayName: 'Physics',
          examWeight: 1,
          estimatedTeachingHours: 300,
          expectedAggregateVersion: created.aggregateVersion,
        },
        context,
      ),
    );
    const nodesBefore = await countRows('curriculum.concept_node');

    // A second root in the same subject domain is rejected by the aggregate.
    const error = expectError(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          conceptIdentityId: optics,
          displayName: 'Optics',
          examWeight: 0.2,
          estimatedTeachingHours: 20,
          expectedAggregateVersion: withRoot.aggregateVersion,
        },
        context,
      ),
    );

    expect(error.code).toBe('MULTIPLE_ROOTS_FOR_SUBJECT_DOMAIN');
    expect(await countRows('curriculum.concept_node')).toBe(nodesBefore);
    expect(expectValue(await deps.versions.findById(created.taxonomyVersionId)).aggregateVersion).toBe(
      withRoot.aggregateVersion,
    );
  });

  it('rolls the whole child rewrite back when the update transaction fails', async () => {
    const created = expectValue(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'JEE', academicYear: '2026' },
        context,
      ),
    );
    const physics = await seedIdentity(created.taxonomyVersionId, 'Physics');
    const withRoot = expectValue(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          conceptIdentityId: physics,
          displayName: 'Physics',
          examWeight: 1,
          estimatedTeachingHours: 300,
          expectedAggregateVersion: created.aggregateVersion,
        },
        context,
      ),
    );

    // A stale expected version means the update matches no row; the child
    // rewrite inside the same transaction must not happen either.
    const mechanics = await seedIdentity(created.taxonomyVersionId, 'Mechanics');
    const stale = expectError(
      await new AddConceptNodeHandler(deps).handle(
        {
          taxonomyVersionId: created.taxonomyVersionId,
          conceptIdentityId: mechanics,
          parentNodeId: expectValue(await deps.versions.findById(created.taxonomyVersionId)).aggregate
            .nodes[0]?.conceptNodeId as string,
          displayName: 'Mechanics',
          examWeight: 0.3,
          estimatedTeachingHours: 80,
          expectedAggregateVersion: withRoot.aggregateVersion - 1,
        },
        context,
      ),
    );

    expect(stale.kind).toBe('Conflict');
    expect(await countRows('curriculum.concept_node')).toBe(1);
    expect(expectValue(await deps.versions.findById(created.taxonomyVersionId)).aggregate.nodes).toHaveLength(
      1,
    );
  });

  it('denies an unauthorized principal without writing anything', async () => {
    const learner: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['learner'] };

    const error = expectError(
      await new CreateTaxonomyDraftHandler(deps).handle(
        { examFamily: 'JEE', academicYear: '2026' },
        { principal: learner, stepUpSatisfied: true, correlationId: 'corr_denied' },
      ),
    );

    expect(error.kind).toBe('Authorization');
    expect(await countRows('curriculum.taxonomy_version')).toBe(0);
    expect(audit.entries).toEqual([]);
  });
});
