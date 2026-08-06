import { err, ok, type Result } from './result.js';
import type { ConceptIdentityId } from './concept-identity.js';
import type { TaxonomyVersionId } from './taxonomy-version.js';
import type { TaxonomyMapping } from './taxonomy-mapping.js';

export type MigrationId = string;

export const MIGRATION_STATES = ['draft', 'executing', 'executed'] as const;

export type MigrationState = (typeof MIGRATION_STATES)[number];

export interface CreateTaxonomyMigrationProps {
  readonly migrationId: MigrationId;
  readonly fromVersionId: TaxonomyVersionId;
  readonly toVersionId: TaxonomyVersionId;
  /** Concepts placed in the source version. */
  readonly sourceConcepts: Iterable<ConceptIdentityId>;
  /** Concepts placed in the target version. */
  readonly targetConcepts: Iterable<ConceptIdentityId>;
}

export type TaxonomyMigrationErrorCode =
  | 'MIGRATION_ID_REQUIRED'
  | 'VERSION_ID_REQUIRED'
  | 'VERSIONS_IDENTICAL'
  | 'UNKNOWN_SOURCE_CONCEPT'
  | 'UNKNOWN_TARGET_CONCEPT'
  | 'CONCEPT_ALREADY_MAPPED'
  | 'MIGRATION_NOT_MUTABLE'
  | 'ILLEGAL_STATE_TRANSITION';

export interface TaxonomyMigrationError {
  readonly kind: 'Validation' | 'RuleViolation';
  readonly code: TaxonomyMigrationErrorCode;
  readonly message: string;
  readonly offendingConcepts: readonly ConceptIdentityId[];
}

const LEGAL_TRANSITIONS: ReadonlyMap<MigrationState, readonly MigrationState[]> = new Map([
  ['draft', ['executing'] as const],
  ['executing', ['executed'] as const],
  ['executed', [] as const],
]);

interface MigrationSnapshot {
  readonly migrationId: MigrationId;
  readonly fromVersionId: TaxonomyVersionId;
  readonly toVersionId: TaxonomyVersionId;
  readonly sourceConcepts: ReadonlySet<ConceptIdentityId>;
  readonly targetConcepts: ReadonlySet<ConceptIdentityId>;
  readonly mappings: readonly TaxonomyMapping[];
  readonly state: MigrationState;
}

function validationError(
  code: TaxonomyMigrationErrorCode,
  message: string,
  offendingConcepts: readonly ConceptIdentityId[] = [],
): TaxonomyMigrationError {
  return { kind: 'Validation', code, message, offendingConcepts };
}

function ruleViolation(
  code: TaxonomyMigrationErrorCode,
  message: string,
  offendingConcepts: readonly ConceptIdentityId[] = [],
): TaxonomyMigrationError {
  return { kind: 'RuleViolation', code, message, offendingConcepts };
}

/**
 * A governed syllabus revision between two taxonomy versions (FR-QM-13).
 *
 * Holds the mapping set only; deriving exceptions and previewing the outcome is
 * the dry run (M1-13), which never mutates this aggregate.
 */
export class TaxonomyMigration {
  readonly migrationId: MigrationId;
  readonly fromVersionId: TaxonomyVersionId;
  readonly toVersionId: TaxonomyVersionId;
  readonly sourceConcepts: ReadonlySet<ConceptIdentityId>;
  readonly targetConcepts: ReadonlySet<ConceptIdentityId>;
  readonly mappings: readonly TaxonomyMapping[];
  readonly state: MigrationState;

  private constructor(snapshot: MigrationSnapshot) {
    this.migrationId = snapshot.migrationId;
    this.fromVersionId = snapshot.fromVersionId;
    this.toVersionId = snapshot.toVersionId;
    this.sourceConcepts = new Set(snapshot.sourceConcepts);
    this.targetConcepts = new Set(snapshot.targetConcepts);
    this.mappings = Object.freeze([...snapshot.mappings]);
    this.state = snapshot.state;
    Object.freeze(this);
  }

  static create(
    props: CreateTaxonomyMigrationProps,
  ): Result<TaxonomyMigration, TaxonomyMigrationError> {
    if (props.migrationId.trim().length === 0) {
      return err(validationError('MIGRATION_ID_REQUIRED', 'migrationId must be non-empty'));
    }
    if (props.fromVersionId.trim().length === 0 || props.toVersionId.trim().length === 0) {
      return err(validationError('VERSION_ID_REQUIRED', 'fromVersionId and toVersionId must be non-empty'));
    }
    if (props.fromVersionId.trim() === props.toVersionId.trim()) {
      return err(
        validationError(
          'VERSIONS_IDENTICAL',
          `a migration must run between two different versions, got ${props.fromVersionId} twice`,
        ),
      );
    }

    return ok(
      new TaxonomyMigration({
        migrationId: props.migrationId.trim(),
        fromVersionId: props.fromVersionId.trim(),
        toVersionId: props.toVersionId.trim(),
        sourceConcepts: new Set(props.sourceConcepts),
        targetConcepts: new Set(props.targetConcepts),
        mappings: [],
        state: 'draft',
      }),
    );
  }

  get isMutable(): boolean {
    return this.state === 'draft';
  }

  /** Concepts already named by some mapping, in either direction. */
  get mappedConcepts(): ReadonlySet<ConceptIdentityId> {
    return new Set(this.mappings.flatMap((mapping) => mapping.conceptIds));
  }

  mappingFor(conceptId: ConceptIdentityId): TaxonomyMapping | undefined {
    return this.mappings.find((mapping) => mapping.conceptIds.includes(conceptId));
  }

  addMapping(mapping: TaxonomyMapping): Result<TaxonomyMigration, TaxonomyMigrationError> {
    if (!this.isMutable) {
      return err(
        ruleViolation(
          'MIGRATION_NOT_MUTABLE',
          `addMapping rejected: migration ${this.migrationId} is ${this.state}`,
        ),
      );
    }

    const unknownSource = mapping.from.filter((conceptId) => !this.sourceConcepts.has(conceptId));
    if (unknownSource.length > 0) {
      return err(
        validationError(
          'UNKNOWN_SOURCE_CONCEPT',
          `concept(s) ${unknownSource.join(', ')} are not in source version ${this.fromVersionId}`,
          unknownSource,
        ),
      );
    }

    const unknownTarget = mapping.to.filter((conceptId) => !this.targetConcepts.has(conceptId));
    if (unknownTarget.length > 0) {
      return err(
        validationError(
          'UNKNOWN_TARGET_CONCEPT',
          `concept(s) ${unknownTarget.join(', ')} are not in target version ${this.toVersionId}`,
          unknownTarget,
        ),
      );
    }

    const alreadyMapped = mapping.conceptIds.filter((conceptId) => this.mappedConcepts.has(conceptId));
    if (alreadyMapped.length > 0) {
      return err(
        ruleViolation(
          'CONCEPT_ALREADY_MAPPED',
          `concept(s) ${alreadyMapped.join(', ')} already appear in another mapping of this migration`,
          alreadyMapped,
        ),
      );
    }

    return ok(this.with({ mappings: [...this.mappings, mapping] }));
  }

  replaceMapping(
    index: number,
    mapping: TaxonomyMapping,
  ): Result<TaxonomyMigration, TaxonomyMigrationError> {
    if (!this.isMutable) {
      return err(
        ruleViolation(
          'MIGRATION_NOT_MUTABLE',
          `replaceMapping rejected: migration ${this.migrationId} is ${this.state}`,
        ),
      );
    }

    return ok(
      this.with({
        mappings: this.mappings.map((existing, position) => (position === index ? mapping : existing)),
      }),
    );
  }

  transitionTo(state: MigrationState): Result<TaxonomyMigration, TaxonomyMigrationError> {
    const legal = LEGAL_TRANSITIONS.get(this.state) ?? [];
    if (!legal.includes(state)) {
      return err(
        ruleViolation(
          'ILLEGAL_STATE_TRANSITION',
          `migration ${this.migrationId} cannot move from ${this.state} to ${state}`,
        ),
      );
    }

    return ok(this.with({ state }));
  }

  private with(changes: Partial<MigrationSnapshot>): TaxonomyMigration {
    return new TaxonomyMigration({
      migrationId: this.migrationId,
      fromVersionId: this.fromVersionId,
      toVersionId: this.toVersionId,
      sourceConcepts: this.sourceConcepts,
      targetConcepts: this.targetConcepts,
      mappings: this.mappings,
      state: this.state,
      ...changes,
    });
  }
}
