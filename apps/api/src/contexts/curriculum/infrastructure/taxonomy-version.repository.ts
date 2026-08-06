import { and, asc, eq, inArray } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ok, err, type Result } from '../domain/result.js';
import type { ConceptIdentityId } from '../domain/concept-identity.js';
import { ConceptNode } from '../domain/concept-node.js';
import { PrerequisiteEdge } from '../domain/prerequisite-edge.js';
import { TaxonomyVersion, type TaxonomyVersionId } from '../domain/taxonomy-version.js';
import type { TaxonomyState } from '../domain/taxonomy-lifecycle.js';
import {
  conflict,
  corruptRow,
  notFound,
  type Persisted,
  type RepositoryError,
  type TaxonomyVersionRepository,
} from '../domain/repository-ports.js';
import { conceptIdentity, conceptNode, prerequisiteEdge, taxonomyVersion } from './schema.js';

type VersionRow = typeof taxonomyVersion.$inferSelect;
type NodeRow = typeof conceptNode.$inferSelect;
type EdgeRow = typeof prerequisiteEdge.$inferSelect;

function toPrincipal(row: VersionRow): PrincipalRef | undefined {
  return row.publishedById === null || row.publishedByKind === null
    ? undefined
    : { kind: row.publishedByKind as PrincipalRef['kind'], id: row.publishedById, roleContext: [] };
}

export function toConceptNode(row: NodeRow): Result<ConceptNode, RepositoryError> {
  const node = ConceptNode.reconstitute({
    conceptNodeId: row.conceptNodeId,
    conceptIdentityId: row.conceptIdentityId,
    displayName: row.displayName,
    examWeight: Number(row.examWeight),
    estimatedTeachingHours: Number(row.estimatedTeachingHours),
    depth: row.depth,
    ...(row.parentNodeId !== null ? { parentNodeId: row.parentNodeId } : {}),
  });

  return node.ok
    ? ok(node.value)
    : err(corruptRow(`concept_node ${row.conceptNodeId} cannot be loaded: ${node.error.message}`));
}

export function toPrerequisiteEdge(row: EdgeRow): Result<PrerequisiteEdge, RepositoryError> {
  const edge = PrerequisiteEdge.create({
    fromConceptIdentityId: row.fromConceptIdentityId,
    toConceptIdentityId: row.toConceptIdentityId,
    strength: Number(row.strength),
  });

  return edge.ok
    ? ok(edge.value)
    : err(
        corruptRow(
          `prerequisite_edge ${row.fromConceptIdentityId}→${row.toConceptIdentityId} cannot be loaded: ${edge.error.message}`,
        ),
      );
}

export function toTaxonomyVersionRow(version: TaxonomyVersion): typeof taxonomyVersion.$inferInsert {
  const publishedAt = version.publishedAt;
  return {
    taxonomyVersionId: version.taxonomyVersionId,
    examFamily: version.examFamily,
    academicYear: version.academicYear,
    state: version.state,
    publishedAt: publishedAt ?? null,
    publishedByKind: version.publishedBy?.kind ?? null,
    publishedById: version.publishedBy?.id ?? null,
  };
}

function toConceptNodeRow(
  version: TaxonomyVersion,
  node: ConceptNode,
): typeof conceptNode.$inferInsert {
  return {
    conceptNodeId: node.conceptNodeId,
    taxonomyVersionId: version.taxonomyVersionId,
    conceptIdentityId: node.conceptIdentityId,
    parentNodeId: node.parentNodeId ?? null,
    displayName: node.displayName,
    examWeight: node.examWeight.toFixed(5),
    depth: node.depth,
    estimatedTeachingHours: node.estimatedTeachingHours.toFixed(2),
  };
}

/**
 * Loads and stores the whole `TaxonomyVersion` aggregate — version row, nodes
 * and prerequisite edges — in one transaction. All snake_case ↔ camelCase
 * mapping for the aggregate happens in this file.
 */
export class DrizzleTaxonomyVersionRepository implements TaxonomyVersionRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(version: TaxonomyVersion): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>> {
    await this.db.transaction(async (tx) => {
      // Child rows are frozen once the parent is published, so the version row
      // starts as a draft and is moved to its real state after the nodes and
      // edges land — the same order a real version goes through.
      const row = toTaxonomyVersionRow(version);
      await tx.insert(taxonomyVersion).values({
        ...row,
        state: 'draft',
        publishedAt: null,
        publishedByKind: null,
        publishedById: null,
        aggregateVersion: 1,
      });
      await this.writeChildren(tx, version);

      if (version.state !== 'draft') {
        await tx
          .update(taxonomyVersion)
          .set(row)
          .where(eq(taxonomyVersion.taxonomyVersionId, version.taxonomyVersionId));
      }
    });

    return ok({ aggregate: version, aggregateVersion: 1 });
  }

  async update(
    version: TaxonomyVersion,
    expectedAggregateVersion: number,
  ): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>> {
    const nextVersion = expectedAggregateVersion + 1;

    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(taxonomyVersion)
        .set({ ...toTaxonomyVersionRow(version), aggregateVersion: nextVersion })
        .where(
          and(
            eq(taxonomyVersion.taxonomyVersionId, version.taxonomyVersionId),
            eq(taxonomyVersion.aggregateVersion, expectedAggregateVersion),
          ),
        )
        .returning();

      if (rows.length === 0) return false;

      if (version.state === 'draft') {
        await tx.delete(prerequisiteEdge).where(eq(prerequisiteEdge.taxonomyVersionId, version.taxonomyVersionId));
        await tx.delete(conceptNode).where(eq(conceptNode.taxonomyVersionId, version.taxonomyVersionId));
        await this.writeChildren(tx, version);
      }

      return true;
    });

    return updated
      ? ok({ aggregate: version, aggregateVersion: nextVersion })
      : err(
          conflict(
            `taxonomy version ${version.taxonomyVersionId} was modified by someone else: expected aggregate version ${expectedAggregateVersion}`,
          ),
        );
  }

  async findById(
    taxonomyVersionId: TaxonomyVersionId,
  ): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>> {
    const versionRows = await this.db
      .select()
      .from(taxonomyVersion)
      .where(eq(taxonomyVersion.taxonomyVersionId, taxonomyVersionId));

    const versionRow = versionRows[0];
    if (versionRow === undefined) return err(notFound(`taxonomy version ${taxonomyVersionId} not found`));

    return this.hydrate(versionRow);
  }

  async listByExamFamily(examFamily: string): Promise<readonly Persisted<TaxonomyVersion>[]> {
    const rows = await this.db
      .select()
      .from(taxonomyVersion)
      .where(eq(taxonomyVersion.examFamily, examFamily))
      .orderBy(asc(taxonomyVersion.academicYear));

    const loaded: Persisted<TaxonomyVersion>[] = [];
    for (const row of rows) {
      const version = await this.hydrate(row);
      if (version.ok) loaded.push(version.value);
    }
    return loaded;
  }

  private async hydrate(row: VersionRow): Promise<Result<Persisted<TaxonomyVersion>, RepositoryError>> {
    const nodeRows = await this.db
      .select()
      .from(conceptNode)
      .where(eq(conceptNode.taxonomyVersionId, row.taxonomyVersionId))
      .orderBy(asc(conceptNode.depth), asc(conceptNode.conceptNodeId));

    const edgeRows = await this.db
      .select()
      .from(prerequisiteEdge)
      .where(eq(prerequisiteEdge.taxonomyVersionId, row.taxonomyVersionId));

    const nodes: ConceptNode[] = [];
    for (const nodeRow of nodeRows) {
      const node = toConceptNode(nodeRow);
      if (!node.ok) return node;
      nodes.push(node.value);
    }

    const edges: PrerequisiteEdge[] = [];
    for (const edgeRow of edgeRows) {
      const edge = toPrerequisiteEdge(edgeRow);
      if (!edge.ok) return edge;
      edges.push(edge.value);
    }

    const subjectDomainOf = await this.subjectDomainsOf(nodes.map((node) => node.conceptIdentityId));

    const version = TaxonomyVersion.reconstitute({
      taxonomyVersionId: row.taxonomyVersionId,
      examFamily: row.examFamily,
      academicYear: row.academicYear,
      state: row.state as TaxonomyState,
      nodes,
      prerequisites: edges,
      subjectDomainOf,
      ...(row.publishedAt !== null ? { publishedAt: row.publishedAt } : {}),
      ...(toPrincipal(row) !== undefined ? { publishedBy: toPrincipal(row) as PrincipalRef } : {}),
    });

    return version.ok
      ? ok({ aggregate: version.value, aggregateVersion: row.aggregateVersion })
      : err(corruptRow(version.error.message));
  }

  private async subjectDomainsOf(
    conceptIdentityIds: readonly ConceptIdentityId[],
  ): Promise<ReadonlyMap<ConceptIdentityId, string>> {
    if (conceptIdentityIds.length === 0) return new Map();

    const rows = await this.db
      .select({ id: conceptIdentity.conceptIdentityId, subjectDomain: conceptIdentity.subjectDomain })
      .from(conceptIdentity)
      .where(inArray(conceptIdentity.conceptIdentityId, [...conceptIdentityIds]));

    return new Map(rows.map((row) => [row.id, row.subjectDomain]));
  }

  private async writeChildren(
    tx: Pick<NodePgDatabase, 'insert'>,
    version: TaxonomyVersion,
  ): Promise<void> {
    if (version.nodes.length > 0) {
      // Parents before children, so the self-referencing foreign key resolves.
      const ordered = [...version.nodes].sort((left, right) => left.depth - right.depth);
      await tx.insert(conceptNode).values(ordered.map((node) => toConceptNodeRow(version, node)));
    }

    if (version.prerequisites.length > 0) {
      await tx.insert(prerequisiteEdge).values(
        version.prerequisites.map((edge) => ({
          taxonomyVersionId: version.taxonomyVersionId,
          fromConceptIdentityId: edge.fromConceptIdentityId,
          toConceptIdentityId: edge.toConceptIdentityId,
          strength: edge.strength.toFixed(3),
        })),
      );
    }
  }
}
