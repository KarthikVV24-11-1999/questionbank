import { err, ok, type Result } from './result.js';
import type { ConceptIdentityId } from './concept-identity.js';

/** Every kind of change a syllabus revision can make to a concept. */
export const MAPPING_KINDS = ['IDENTITY', 'RENAME', 'MOVE', 'SPLIT', 'MERGE', 'REMOVAL'] as const;

export type MappingKind = (typeof MAPPING_KINDS)[number];

export const DISPOSITIONS = ['pending', 'accepted', 'rejected'] as const;

export type MappingDisposition = (typeof DISPOSITIONS)[number];

export interface CreateTaxonomyMappingProps {
  readonly kind: MappingKind;
  readonly from: readonly ConceptIdentityId[];
  readonly to: readonly ConceptIdentityId[];
  readonly disposition?: MappingDisposition;
}

export type TaxonomyMappingErrorCode =
  | 'MAPPING_KIND_UNKNOWN'
  | 'CARDINALITY_INVALID'
  | 'CONCEPT_ID_REQUIRED'
  | 'DUPLICATE_CONCEPT_IN_MAPPING';

export interface TaxonomyMappingError {
  readonly kind: 'Validation';
  readonly code: TaxonomyMappingErrorCode;
  readonly message: string;
}

/** Required cardinality per kind: `[from, to]`, where `n` means two or more. */
const CARDINALITY: Readonly<Record<MappingKind, readonly ['1' | 'n', '0' | '1' | 'n']>> = {
  IDENTITY: ['1', '1'],
  RENAME: ['1', '1'],
  MOVE: ['1', '1'],
  SPLIT: ['1', 'n'],
  MERGE: ['n', '1'],
  REMOVAL: ['1', '0'],
};

/** Kinds a machine can apply unattended; everything else needs a human. */
const AUTO_MIGRATABLE: readonly MappingKind[] = ['IDENTITY', 'RENAME'];

function validationError(code: TaxonomyMappingErrorCode, message: string): TaxonomyMappingError {
  return { kind: 'Validation', code, message };
}

function matchesCardinality(actual: number, expected: '0' | '1' | 'n'): boolean {
  if (expected === '0') return actual === 0;
  if (expected === '1') return actual === 1;
  return actual >= 2;
}

function describeCardinality(expected: '0' | '1' | 'n'): string {
  return expected === 'n' ? '2 or more' : expected;
}

export function isAutoMigratable(kind: MappingKind): boolean {
  return AUTO_MIGRATABLE.includes(kind);
}

/** One entry in a migration's mapping set (DOMAIN-MODEL §4). */
export class TaxonomyMapping {
  private constructor(
    readonly kind: MappingKind,
    readonly from: readonly ConceptIdentityId[],
    readonly to: readonly ConceptIdentityId[],
    readonly disposition: MappingDisposition,
  ) {
    Object.freeze(this.from);
    Object.freeze(this.to);
    Object.freeze(this);
  }

  static create(props: CreateTaxonomyMappingProps): Result<TaxonomyMapping, TaxonomyMappingError> {
    const cardinality = CARDINALITY[props.kind];
    if (cardinality === undefined) {
      return err(
        validationError('MAPPING_KIND_UNKNOWN', `unknown mapping kind "${String(props.kind)}"`),
      );
    }

    const from = props.from.map((conceptId) => conceptId.trim());
    const to = props.to.map((conceptId) => conceptId.trim());
    if ([...from, ...to].some((conceptId) => conceptId.length === 0)) {
      return err(validationError('CONCEPT_ID_REQUIRED', 'mapping concept identities must be non-empty'));
    }

    const [expectedFrom, expectedTo] = cardinality;
    if (!matchesCardinality(from.length, expectedFrom) || !matchesCardinality(to.length, expectedTo)) {
      return err(
        validationError(
          'CARDINALITY_INVALID',
          `${props.kind} requires ${describeCardinality(expectedFrom)} source and ${describeCardinality(expectedTo)} target concept(s), got ${from.length} → ${to.length}`,
        ),
      );
    }

    // A concept keeps its identity across versions (D1), so IDENTITY and MOVE
    // legitimately name the same concept on both sides; only repetition within
    // one side is a mistake.
    for (const side of [from, to]) {
      if (new Set(side).size !== side.length) {
        return err(
          validationError(
            'DUPLICATE_CONCEPT_IN_MAPPING',
            `a mapping must not name the same concept twice on one side: ${side.join(', ')}`,
          ),
        );
      }
    }

    return ok(new TaxonomyMapping(props.kind, from, to, props.disposition ?? 'pending'));
  }

  get isAutoMigratable(): boolean {
    return isAutoMigratable(this.kind);
  }

  get conceptIds(): readonly ConceptIdentityId[] {
    return [...new Set([...this.from, ...this.to])];
  }

  withDisposition(disposition: MappingDisposition): TaxonomyMapping {
    return new TaxonomyMapping(this.kind, this.from, this.to, disposition);
  }
}
