import { err, ok, type Result } from './result.js';

export type ConceptIdentityId = string;
export type TaxonomyVersionId = string;

export interface CreateConceptIdentityProps {
  readonly conceptIdentityId: ConceptIdentityId;
  readonly canonicalName: string;
  readonly subjectDomain: string;
  readonly createdInVersion: TaxonomyVersionId;
}

export type ConceptIdentityErrorCode =
  | 'CONCEPT_IDENTITY_ID_REQUIRED'
  | 'CANONICAL_NAME_REQUIRED'
  | 'SUBJECT_DOMAIN_REQUIRED'
  | 'CREATED_IN_VERSION_REQUIRED'
  | 'ALREADY_SUPERSEDED'
  | 'SELF_SUPERSESSION';

export interface ConceptIdentityError {
  readonly kind: 'Validation' | 'RuleViolation';
  readonly code: ConceptIdentityErrorCode;
  readonly message: string;
}

const WHITESPACE_RUN = /\s+/gu;

function validationError(code: ConceptIdentityErrorCode, message: string): ConceptIdentityError {
  return { kind: 'Validation', code, message };
}

function ruleViolation(code: ConceptIdentityErrorCode, message: string): ConceptIdentityError {
  return { kind: 'RuleViolation', code, message };
}

function requireText(
  value: string,
  field: string,
  code: ConceptIdentityErrorCode,
): Result<string, ConceptIdentityError> {
  const trimmed = value.trim();
  return trimmed.length === 0 ? err(validationError(code, `${field} must be non-empty`)) : ok(trimmed);
}

function normalizeCanonicalName(value: string): string {
  return value.replace(WHITESPACE_RUN, ' ').trim();
}

/**
 * A concept's permanent, version-independent identity (DOMAIN-MODEL §2 D1, §4).
 *
 * Instances are frozen. `supersede` yields a new identity rather than mutating,
 * so a superseded identity can never be superseded a second time.
 */
export class ConceptIdentity {
  private constructor(
    readonly conceptIdentityId: ConceptIdentityId,
    readonly canonicalName: string,
    readonly subjectDomain: string,
    readonly createdInVersion: TaxonomyVersionId,
    readonly supersededBy?: ConceptIdentityId,
  ) {
    Object.freeze(this);
  }

  static create(props: CreateConceptIdentityProps): Result<ConceptIdentity, ConceptIdentityError> {
    const conceptIdentityId = requireText(
      props.conceptIdentityId,
      'conceptIdentityId',
      'CONCEPT_IDENTITY_ID_REQUIRED',
    );
    if (!conceptIdentityId.ok) return conceptIdentityId;

    const canonicalName = requireText(
      normalizeCanonicalName(props.canonicalName),
      'canonicalName',
      'CANONICAL_NAME_REQUIRED',
    );
    if (!canonicalName.ok) return canonicalName;

    const subjectDomain = requireText(props.subjectDomain, 'subjectDomain', 'SUBJECT_DOMAIN_REQUIRED');
    if (!subjectDomain.ok) return subjectDomain;

    const createdInVersion = requireText(
      props.createdInVersion,
      'createdInVersion',
      'CREATED_IN_VERSION_REQUIRED',
    );
    if (!createdInVersion.ok) return createdInVersion;

    return ok(
      new ConceptIdentity(
        conceptIdentityId.value,
        canonicalName.value,
        subjectDomain.value,
        createdInVersion.value,
      ),
    );
  }

  /**
   * Rebuilds a stored identity, including its supersession. Validation still
   * applies: a row that cannot form a valid aggregate is rejected, not loaded.
   */
  static reconstitute(
    props: CreateConceptIdentityProps & { readonly supersededBy?: ConceptIdentityId },
  ): Result<ConceptIdentity, ConceptIdentityError> {
    const identity = ConceptIdentity.create(props);
    if (!identity.ok || props.supersededBy === undefined) return identity;

    return identity.value.supersede(props.supersededBy);
  }

  get isSuperseded(): boolean {
    return this.supersededBy !== undefined;
  }

  supersede(supersedingConceptIdentityId: ConceptIdentityId): Result<ConceptIdentity, ConceptIdentityError> {
    const superseding = requireText(
      supersedingConceptIdentityId,
      'supersedingConceptIdentityId',
      'CONCEPT_IDENTITY_ID_REQUIRED',
    );
    if (!superseding.ok) return superseding;

    if (this.supersededBy !== undefined) {
      return err(
        ruleViolation(
          'ALREADY_SUPERSEDED',
          `concept identity ${this.conceptIdentityId} is already superseded by ${this.supersededBy}`,
        ),
      );
    }

    if (superseding.value === this.conceptIdentityId) {
      return err(
        ruleViolation(
          'SELF_SUPERSESSION',
          `concept identity ${this.conceptIdentityId} cannot supersede itself`,
        ),
      );
    }

    return ok(
      new ConceptIdentity(
        this.conceptIdentityId,
        this.canonicalName,
        this.subjectDomain,
        this.createdInVersion,
        superseding.value,
      ),
    );
  }
}
