import type { MappingDisposition, MappingKind } from '../../domain/taxonomy-mapping.js';

/** The governed migration workflow. */

export interface CreateMigration {
  readonly fromVersionId: string;
  readonly toVersionId: string;
}

export interface AddMapping {
  readonly migrationId: string;
  readonly kind: MappingKind;
  readonly from: readonly string[];
  readonly to: readonly string[];
  readonly disposition?: MappingDisposition;
  readonly expectedAggregateVersion: number;
}

export interface RunDryRun {
  readonly migrationId: string;
  readonly expectedAggregateVersion: number;
}

export interface ExecuteMigration {
  readonly migrationId: string;
  readonly expectedAggregateVersion: number;
  /** Concepts migrated per chunk; execution resumes from where it stopped. */
  readonly chunkSize?: number;
}
