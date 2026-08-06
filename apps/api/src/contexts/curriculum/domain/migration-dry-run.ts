import type { ConceptIdentityId } from './concept-identity.js';
import type { TaxonomyMigration } from './taxonomy-migration.js';
import { isAutoMigratable, type MappingDisposition, type MappingKind } from './taxonomy-mapping.js';

export const EXCEPTION_KINDS = ['AMBIGUOUS_MAPPING', 'UNMAPPED'] as const;

export type ExceptionKind = (typeof EXCEPTION_KINDS)[number];

export interface MigrationException {
  readonly kind: ExceptionKind;
  /** The mapping kind that produced it; absent for an unmapped concept. */
  readonly mappingKind?: MappingKind;
  readonly concepts: readonly ConceptIdentityId[];
  readonly disposition: MappingDisposition;
  readonly reason: string;
}

export interface InvalidMapping {
  readonly mappingIndex: number;
  readonly mappingKind: MappingKind;
  readonly concepts: readonly ConceptIdentityId[];
  readonly reason: string;
}

export interface MigrationDryRunResult {
  readonly schemaVersion: number;
  readonly migrationId: string;
  readonly fromVersionId: string;
  readonly toVersionId: string;
  readonly autoMigratableCount: number;
  readonly exceptions: readonly MigrationException[];
  readonly invalidMappings: readonly InvalidMapping[];
}

export const DRY_RUN_SCHEMA_VERSION = 1;

function sorted(concepts: Iterable<ConceptIdentityId>): ConceptIdentityId[] {
  return [...concepts].sort();
}

/**
 * Previews a migration: what would migrate unattended, what needs a human, and
 * what is malformed.
 *
 * A pure function of the migration's mappings and the two versions' concept
 * sets — it mutates nothing, and the same input always produces byte-identical
 * output (concepts and exceptions are emitted in a deterministic order).
 */
export function runMigrationDryRun(migration: TaxonomyMigration): MigrationDryRunResult {
  const exceptions: MigrationException[] = [];
  const invalidMappings: InvalidMapping[] = [];
  let autoMigratableCount = 0;

  migration.mappings.forEach((mapping, mappingIndex) => {
    const unknownSource = mapping.from.filter((concept) => !migration.sourceConcepts.has(concept));
    const unknownTarget = mapping.to.filter((concept) => !migration.targetConcepts.has(concept));

    if (unknownSource.length > 0 || unknownTarget.length > 0) {
      invalidMappings.push({
        mappingIndex,
        mappingKind: mapping.kind,
        concepts: sorted([...unknownSource, ...unknownTarget]),
        reason: 'mapping references concepts absent from the version they belong to',
      });
      return;
    }

    if (isAutoMigratable(mapping.kind)) {
      autoMigratableCount += 1;
      return;
    }

    exceptions.push({
      kind: 'AMBIGUOUS_MAPPING',
      mappingKind: mapping.kind,
      concepts: sorted(mapping.conceptIds),
      disposition: mapping.disposition,
      reason: `${mapping.kind} cannot be applied without human disposition`,
    });
  });

  const mapped = migration.mappedConcepts;
  for (const concept of sorted(migration.sourceConcepts)) {
    if (mapped.has(concept)) continue;
    exceptions.push({
      kind: 'UNMAPPED',
      concepts: [concept],
      disposition: 'pending',
      reason: 'concept exists in the source version but no mapping covers it',
    });
  }

  return {
    schemaVersion: DRY_RUN_SCHEMA_VERSION,
    migrationId: migration.migrationId,
    fromVersionId: migration.fromVersionId,
    toVersionId: migration.toVersionId,
    autoMigratableCount,
    exceptions,
    invalidMappings,
  };
}

/** True when every exception has been dispositioned — the gate on execution. */
export function allExceptionsDispositioned(result: MigrationDryRunResult): boolean {
  return result.exceptions.every((exception) => exception.disposition !== 'pending');
}
