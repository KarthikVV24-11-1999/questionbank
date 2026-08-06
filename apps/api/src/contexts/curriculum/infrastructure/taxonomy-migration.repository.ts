import { and, asc, eq } from 'drizzle-orm';
import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import { ok, err, type Result } from '../domain/result.js';
import { TaxonomyMigration, type MigrationId, type MigrationState } from '../domain/taxonomy-migration.js';
import { TaxonomyMapping, type MappingDisposition, type MappingKind } from '../domain/taxonomy-mapping.js';
import type { MigrationDryRunResult } from '../domain/migration-dry-run.js';
import { DRY_RUN_SCHEMA_VERSION } from '../domain/migration-dry-run.js';
import {
  conflict,
  corruptRow,
  notFound,
  type Persisted,
  type RepositoryError,
} from '../domain/repository-ports.js';
import { conceptNode, taxonomyMapping, taxonomyMigration } from './schema.js';

type MigrationRow = typeof taxonomyMigration.$inferSelect;
type MappingRow = typeof taxonomyMapping.$inferSelect;

/** The database stores mapping kinds in snake_case, the domain in upper case. */
function toStoredKind(kind: MappingKind): string {
  return kind.toLowerCase();
}

function toDomainKind(kind: string): MappingKind {
  return kind.toUpperCase() as MappingKind;
}

export function toTaxonomyMapping(row: MappingRow): Result<TaxonomyMapping, RepositoryError> {
  const mapping = TaxonomyMapping.create({
    kind: toDomainKind(row.kind),
    from: row.fromIds,
    to: row.toIds,
    disposition: row.disposition as MappingDisposition,
  });

  return mapping.ok
    ? ok(mapping.value)
    : err(corruptRow(`taxonomy_mapping ${row.mappingId} cannot be loaded: ${mapping.error.message}`));
}

export interface StoredMigration extends Persisted<TaxonomyMigration> {
  readonly dryRunResult: MigrationDryRunResult | null;
}

/**
 * Persists a migration, its ordered mappings, and the dry-run result. Concept
 * sets are not stored: they are the two versions' current contents, read back
 * from `concept_node` when the migration is loaded.
 */
export class DrizzleTaxonomyMigrationRepository {
  constructor(private readonly db: NodePgDatabase) {}

  async insert(migration: TaxonomyMigration): Promise<Result<StoredMigration, RepositoryError>> {
    await this.db.transaction(async (tx) => {
      await tx.insert(taxonomyMigration).values({
        migrationId: migration.migrationId,
        fromVersion: migration.fromVersionId,
        toVersion: migration.toVersionId,
        state: migration.state,
        aggregateVersion: 1,
      });
      await this.writeMappings(tx, migration);
    });

    return ok({ aggregate: migration, aggregateVersion: 1, dryRunResult: null });
  }

  async update(
    migration: TaxonomyMigration,
    expectedAggregateVersion: number,
    dryRunResult: MigrationDryRunResult | null = null,
  ): Promise<Result<StoredMigration, RepositoryError>> {
    const current = await this.db
      .select({ state: taxonomyMigration.state })
      .from(taxonomyMigration)
      .where(eq(taxonomyMigration.migrationId, migration.migrationId));

    const storedState = current[0]?.state as MigrationState | undefined;
    if (storedState === 'executing' && migration.state === 'executing') {
      return err(
        conflict(`migration ${migration.migrationId} is executing and cannot be modified`),
      );
    }

    const nextVersion = expectedAggregateVersion + 1;
    const updated = await this.db.transaction(async (tx) => {
      const rows = await tx
        .update(taxonomyMigration)
        .set({
          state: migration.state,
          dryRunResult,
          dryRunResultSchemaVersion: DRY_RUN_SCHEMA_VERSION,
          aggregateVersion: nextVersion,
        })
        .where(
          and(
            eq(taxonomyMigration.migrationId, migration.migrationId),
            eq(taxonomyMigration.aggregateVersion, expectedAggregateVersion),
          ),
        )
        .returning();

      if (rows.length === 0) return false;

      await tx.delete(taxonomyMapping).where(eq(taxonomyMapping.migrationId, migration.migrationId));
      await this.writeMappings(tx, migration);
      return true;
    });

    return updated
      ? ok({ aggregate: migration, aggregateVersion: nextVersion, dryRunResult })
      : err(
          conflict(
            `migration ${migration.migrationId} was modified by someone else: expected aggregate version ${expectedAggregateVersion}`,
          ),
        );
  }

  async findById(migrationId: MigrationId): Promise<Result<StoredMigration, RepositoryError>> {
    const rows = await this.db
      .select()
      .from(taxonomyMigration)
      .where(eq(taxonomyMigration.migrationId, migrationId));

    const row = rows[0];
    if (row === undefined) return err(notFound(`migration ${migrationId} not found`));

    const mappingRows = await this.db
      .select()
      .from(taxonomyMapping)
      .where(eq(taxonomyMapping.migrationId, migrationId))
      .orderBy(asc(taxonomyMapping.ordinal));

    return this.hydrate(row, mappingRows);
  }

  private async hydrate(
    row: MigrationRow,
    mappingRows: readonly MappingRow[],
  ): Promise<Result<StoredMigration, RepositoryError>> {
    const created = TaxonomyMigration.create({
      migrationId: row.migrationId,
      fromVersionId: row.fromVersion,
      toVersionId: row.toVersion,
      sourceConcepts: await this.conceptsOf(row.fromVersion),
      targetConcepts: await this.conceptsOf(row.toVersion),
    });
    if (!created.ok) {
      return err(corruptRow(`migration ${row.migrationId} cannot be loaded: ${created.error.message}`));
    }

    let migration = created.value;
    for (const mappingRow of mappingRows) {
      const mapping = toTaxonomyMapping(mappingRow);
      if (!mapping.ok) return mapping;

      const added = migration.addMapping(mapping.value);
      if (!added.ok) {
        return err(
          corruptRow(`migration ${row.migrationId} cannot be loaded: ${added.error.message}`),
        );
      }
      migration = added.value;
    }

    if (row.state !== 'draft') {
      const transitioned = this.replayStateTo(migration, row.state as MigrationState);
      if (!transitioned.ok) return transitioned;
      migration = transitioned.value;
    }

    return ok({
      aggregate: migration,
      aggregateVersion: row.aggregateVersion,
      dryRunResult: (row.dryRunResult as MigrationDryRunResult | null) ?? null,
    });
  }

  /** Walks the stored state back up the legal transition chain from `draft`. */
  private replayStateTo(
    migration: TaxonomyMigration,
    state: MigrationState,
  ): Result<TaxonomyMigration, RepositoryError> {
    const path: MigrationState[] = state === 'executed' ? ['executing', 'executed'] : ['executing'];

    let current = migration;
    for (const step of path) {
      const moved = current.transitionTo(step);
      if (!moved.ok) return err(corruptRow(`stored migration state ${state} is not reachable`));
      current = moved.value;
    }
    return ok(current);
  }

  private async conceptsOf(taxonomyVersionId: string): Promise<string[]> {
    const rows = await this.db
      .select({ conceptIdentityId: conceptNode.conceptIdentityId })
      .from(conceptNode)
      .where(eq(conceptNode.taxonomyVersionId, taxonomyVersionId));

    return rows.map((row) => row.conceptIdentityId);
  }

  private async writeMappings(
    tx: Pick<NodePgDatabase, 'insert'>,
    migration: TaxonomyMigration,
  ): Promise<void> {
    if (migration.mappings.length === 0) return;

    await tx.insert(taxonomyMapping).values(
      migration.mappings.map((mapping, ordinal) => ({
        migrationId: migration.migrationId,
        ordinal,
        kind: toStoredKind(mapping.kind),
        fromIds: [...mapping.from],
        toIds: [...mapping.to],
        disposition: mapping.disposition,
      })),
    );
  }
}
