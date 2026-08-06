import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../domain/concept-identity.js';
import { ConceptNode } from '../domain/concept-node.js';
import { PrerequisiteEdge } from '../domain/prerequisite-edge.js';
import { TaxonomyVersion } from '../domain/taxonomy-version.js';
import { DrizzleConceptIdentityRepository } from './concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from './taxonomy-version.repository.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

let database: TestDatabase;
let identities: DrizzleConceptIdentityRepository;
let versions: DrizzleTaxonomyVersionRepository;
/** Concept identities are created in some version; this one stands for it. */
let bootstrapVersionId: `${string}-${string}-${string}-${string}-${string}`;

const curator: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: [] };

function draftVersion(taxonomyVersionId: string = randomUUID()): TaxonomyVersion {
  return expectValue(
    TaxonomyVersion.createDraft({ taxonomyVersionId, examFamily: 'JEE', academicYear: '2026' }),
  );
}

function identity(versionId: string, name: string, subjectDomain = 'physics'): ConceptIdentity {
  return expectValue(
    ConceptIdentity.create({
      conceptIdentityId: randomUUID(),
      canonicalName: name,
      subjectDomain,
      createdInVersion: versionId,
    }),
  );
}

async function storedIdentity(versionId: string, name: string, subjectDomain = 'physics'): Promise<ConceptIdentity> {
  const created = identity(versionId, name, subjectDomain);
  expectValue(await identities.insert(created));
  return created;
}

/**
 * A version with `count` concepts under one root, plus a prerequisite chain
 * through the children. Concepts are created in the bootstrap version, as they
 * would be in a real revision; the returned aggregate is not yet stored.
 */
async function largeVersion(count: number): Promise<TaxonomyVersion> {
  let version = draftVersion();

  const rootIdentity = await storedIdentity(bootstrapVersionId, 'Physics');
  const root = expectValue(
    ConceptNode.createRoot({
      conceptNodeId: randomUUID(),
      conceptIdentityId: rootIdentity.conceptIdentityId,
      displayName: 'Physics',
      examWeight: 1,
      estimatedTeachingHours: 300,
    }),
  );
  version = expectValue(version.addConceptNode(root, rootIdentity));

  const children: ConceptIdentity[] = [];
  for (let index = 1; index < count; index += 1) {
    const childIdentity = await storedIdentity(bootstrapVersionId, `Concept ${index}`);
    const child = expectValue(
      ConceptNode.createUnder(root, {
        conceptNodeId: randomUUID(),
        conceptIdentityId: childIdentity.conceptIdentityId,
        displayName: `Concept ${index}`,
        examWeight: 0.001,
        estimatedTeachingHours: 2.5,
      }),
    );
    version = expectValue(version.addConceptNode(child, childIdentity));
    children.push(childIdentity);
  }

  for (let index = 1; index < children.length; index += 1) {
    version = expectValue(
      version.addPrerequisiteEdge(
        expectValue(
          PrerequisiteEdge.create({
            fromConceptIdentityId: (children[index - 1] as ConceptIdentity).conceptIdentityId,
            toConceptIdentityId: (children[index] as ConceptIdentity).conceptIdentityId,
            strength: 0.5,
          }),
        ),
      ),
    );
  }

  return version;
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  identities = new DrizzleConceptIdentityRepository(database.db);
  versions = new DrizzleTaxonomyVersionRepository(database.db);
});

beforeEach(async () => {
  await database.truncateAll();
  bootstrapVersionId = randomUUID();
  expectValue(await versions.insert(draftVersion(bootstrapVersionId)));
});

afterAll(async () => {
  await database.close();
});

describe('ConceptIdentity repository', () => {
  it('round-trips an identity to a domain-equal object', async () => {
    const created = identity(bootstrapVersionId, '  Rotational   Motion ');

    expectValue(await identities.insert(created));
    const loaded = expectValue(await identities.findById(created.conceptIdentityId));

    expect(loaded.aggregate).toEqual(created);
    expect(loaded.aggregate.canonicalName).toBe('Rotational Motion');
    expect(loaded.aggregateVersion).toBe(1);
  });

  it('round-trips a superseded identity', async () => {
    const successor = await storedIdentity(bootstrapVersionId, 'Rigid Body Dynamics');
    const original = await storedIdentity(bootstrapVersionId, 'Rotational Motion');
    const superseded = expectValue(original.supersede(successor.conceptIdentityId));

    expectValue(await identities.update(superseded, 1));
    const loaded = expectValue(await identities.findById(original.conceptIdentityId));

    expect(loaded.aggregate.supersededBy).toBe(successor.conceptIdentityId);
    expect(loaded.aggregate).toEqual(superseded);
    expect(loaded.aggregateVersion).toBe(2);
  });

  it('reports NotFound for an unknown identity', async () => {
    const error = expectError(await identities.findById(randomUUID()));

    expect(error.code).toBe('NOT_FOUND');
    expect(error.kind).toBe('NotFound');
  });

  it('raises Conflict on a stale write', async () => {
    const successor = await storedIdentity(bootstrapVersionId, 'Successor');
    const original = await storedIdentity(bootstrapVersionId, 'Original');

    expectValue(await identities.update(expectValue(original.supersede(successor.conceptIdentityId)), 1));
    const stale = expectError(
      await identities.update(expectValue(original.supersede(successor.conceptIdentityId)), 1),
    );

    expect(stale.code).toBe('CONFLICT');
    expect(stale.kind).toBe('Conflict');
  });

});

describe('TaxonomyVersion repository round-trip', () => {
  it('restores nodes, parent links, depths and edges', async () => {
    const version = await largeVersion(4);
    expectValue(await versions.insert(version));

    const loaded = expectValue(await versions.findById(version.taxonomyVersionId));

    expect(loaded.aggregate.nodes).toHaveLength(4);
    expect(loaded.aggregate.prerequisites).toHaveLength(2);
    expect(loaded.aggregate.examFamily).toBe('JEE');
    expect(loaded.aggregate.academicYear).toBe('2026');
    expect(loaded.aggregate.state).toBe('draft');

    const root = loaded.aggregate.nodes.find((node) => node.isRoot);
    expect(root?.displayName).toBe('Physics');
    for (const node of loaded.aggregate.nodes) {
      if (node.isRoot) continue;
      expect(node.parentNodeId).toBe(root?.conceptNodeId);
      expect(node.depth).toBe(1);
    }
  });

  it('round-trips a 600-node version to a domain-equal object', async () => {
    const version = await largeVersion(600);

    expectValue(await versions.insert(version));
    const loaded = expectValue(await versions.findById(version.taxonomyVersionId));

    expect(loaded.aggregate.nodes).toHaveLength(600);
    expect(loaded.aggregate.prerequisites).toHaveLength(598);
    expect(new Set(loaded.aggregate.nodes.map((node) => node.conceptNodeId))).toEqual(
      new Set(version.nodes.map((node) => node.conceptNodeId)),
    );
    expect(loaded.aggregate.subjectDomainOf.size).toBe(600);
    expect(loaded.aggregate.validate()).toEqual([]);
  }, 30_000);

  it('round-trips a published version with its principal and timestamp', async () => {
    const version = await largeVersion(3);
    const publishedAt = new Date('2026-08-05T10:00:00.000Z');
    expectValue(await versions.insert(version));

    const published = expectValue(version.publish(curator, publishedAt));
    expectValue(await versions.update(published, 1));

    const loaded = expectValue(await versions.findById(version.taxonomyVersionId));
    expect(loaded.aggregate.state).toBe('published');
    expect(loaded.aggregate.publishedAt?.toISOString()).toBe('2026-08-05T10:00:00.000Z');
    expect(loaded.aggregate.publishedBy?.id).toBe(curator.id);
    expect(loaded.aggregateVersion).toBe(2);
  });

  it('reports NotFound for an unknown version', async () => {
    expect((await versions.findById(randomUUID())).ok).toBe(false);
  });

  it('lists versions of an exam family', async () => {
    const first = await largeVersion(2);
    expectValue(await versions.insert(first));
    const second = await largeVersion(2);
    expectValue(await versions.insert(second));

    const listed = await versions.listByExamFamily('JEE');

    expect(listed).toHaveLength(3);
    expect(await versions.listByExamFamily('NEET')).toEqual([]);
  });
});

describe('TaxonomyVersion repository concurrency', () => {
  it('raises Conflict when two writers update the same version', async () => {
    const version = await largeVersion(4);
    expectValue(await versions.insert(version));
    const [firstEdge, secondEdge] = version.prerequisites;

    // Both writers hold the aggregate as it was at version 1.
    const firstWriter = expectValue(
      version.removePrerequisiteEdge(
        firstEdge?.fromConceptIdentityId as string,
        firstEdge?.toConceptIdentityId as string,
      ),
    );
    const secondWriter = expectValue(
      version.removePrerequisiteEdge(
        secondEdge?.fromConceptIdentityId as string,
        secondEdge?.toConceptIdentityId as string,
      ),
    );

    expectValue(await versions.update(firstWriter, 1));
    const conflictError = expectError(await versions.update(secondWriter, 1));

    expect(conflictError.code).toBe('CONFLICT');
    expect(conflictError.kind).toBe('Conflict');
    expect(expectValue(await versions.findById(version.taxonomyVersionId)).aggregateVersion).toBe(2);
  });

  it('replaces the child rows of a draft on update', async () => {
    const version = await largeVersion(4);
    expectValue(await versions.insert(version));
    const last = version.nodes[3] as ConceptNode;

    const withoutEdges = version.prerequisites.reduce(
      (current, edge) =>
        expectValue(current.removePrerequisiteEdge(edge.fromConceptIdentityId, edge.toConceptIdentityId)),
      version,
    );
    const trimmed = expectValue(withoutEdges.removeConceptNode(last.conceptNodeId));
    expectValue(await versions.update(trimmed, 1));

    const loaded = expectValue(await versions.findById(version.taxonomyVersionId));
    expect(loaded.aggregate.nodes).toHaveLength(3);
    expect(loaded.aggregate.prerequisites).toHaveLength(0);
  });
});

describe('TaxonomyVersion partial load rejection', () => {
  it('rejects a version whose node parent is not among the loaded nodes', async () => {
    const other = await largeVersion(2);
    expectValue(await versions.insert(other));
    const version = await largeVersion(3);
    expectValue(await versions.insert(version));

    await database.pool.query(
      `UPDATE curriculum.concept_node SET parent_node_id = $1
       WHERE taxonomy_version_id = $2 AND parent_node_id IS NULL`,
      [other.nodes[0]?.conceptNodeId, version.taxonomyVersionId],
    );

    const error = expectError(await versions.findById(version.taxonomyVersionId));

    expect(error.code).toBe('CORRUPT_ROW');
    expect(error.message).toContain('loaded incompletely');
  });

  it('rejects a version whose prerequisite endpoint is not placed in it', async () => {
    const version = await largeVersion(3);
    expectValue(await versions.insert(version));
    const stranger = await storedIdentity(bootstrapVersionId, 'Not placed here');

    await database.pool.query(
      `UPDATE curriculum.prerequisite_edge SET to_concept_identity_id = $1 WHERE taxonomy_version_id = $2`,
      [stranger.conceptIdentityId, version.taxonomyVersionId],
    );

    const error = expectError(await versions.findById(version.taxonomyVersionId));

    expect(error.code).toBe('CORRUPT_ROW');
  });

  it('rejects a node row whose stored weight is out of range', async () => {
    const version = await largeVersion(2);
    expectValue(await versions.insert(version));

    await database.pool.query(
      `ALTER TABLE curriculum.concept_node DROP CONSTRAINT concept_node_exam_weight_check`,
    );
    await database.pool.query(
      `UPDATE curriculum.concept_node SET exam_weight = 9 WHERE taxonomy_version_id = $1`,
      [version.taxonomyVersionId],
    );

    const error = expectError(await versions.findById(version.taxonomyVersionId));
    expect(error.code).toBe('CORRUPT_ROW');

    await database.truncateAll();
    await database.pool.query(
      `ALTER TABLE curriculum.concept_node ADD CONSTRAINT concept_node_exam_weight_check
         CHECK (exam_weight >= 0 AND exam_weight <= 1)`,
    );
  });
});
