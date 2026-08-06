import { err, ok, type Result } from './result.js';
import type { ConceptIdentityId } from './concept-identity.js';

export interface CreatePrerequisiteEdgeProps {
  readonly fromConceptIdentityId: ConceptIdentityId;
  readonly toConceptIdentityId: ConceptIdentityId;
  readonly strength: number;
}

export type PrerequisiteEdgeErrorCode =
  | 'FROM_CONCEPT_IDENTITY_ID_REQUIRED'
  | 'TO_CONCEPT_IDENTITY_ID_REQUIRED'
  | 'SELF_REFERENCING_EDGE'
  | 'STRENGTH_OUT_OF_RANGE';

export interface PrerequisiteEdgeError {
  readonly kind: 'Validation';
  readonly code: PrerequisiteEdgeErrorCode;
  readonly message: string;
}

function validationError(code: PrerequisiteEdgeErrorCode, message: string): PrerequisiteEdgeError {
  return { kind: 'Validation', code, message };
}

function requireText(
  value: string,
  field: string,
  code: PrerequisiteEdgeErrorCode,
): Result<string, PrerequisiteEdgeError> {
  const trimmed = value.trim();
  return trimmed.length === 0 ? err(validationError(code, `${field} must be non-empty`)) : ok(trimmed);
}

/**
 * A directed prerequisite relation between two concept identities: `from` must
 * be understood before `to`. Acyclicity is a version-level invariant (M1-03).
 */
export class PrerequisiteEdge {
  private constructor(
    readonly fromConceptIdentityId: ConceptIdentityId,
    readonly toConceptIdentityId: ConceptIdentityId,
    readonly strength: number,
  ) {
    Object.freeze(this);
  }

  static create(props: CreatePrerequisiteEdgeProps): Result<PrerequisiteEdge, PrerequisiteEdgeError> {
    const from = requireText(
      props.fromConceptIdentityId,
      'fromConceptIdentityId',
      'FROM_CONCEPT_IDENTITY_ID_REQUIRED',
    );
    if (!from.ok) return from;

    const to = requireText(props.toConceptIdentityId, 'toConceptIdentityId', 'TO_CONCEPT_IDENTITY_ID_REQUIRED');
    if (!to.ok) return to;

    if (from.value === to.value) {
      return err(
        validationError(
          'SELF_REFERENCING_EDGE',
          `concept ${from.value} cannot be a prerequisite of itself`,
        ),
      );
    }

    if (!Number.isFinite(props.strength) || props.strength < 0 || props.strength > 1) {
      return err(
        validationError(
          'STRENGTH_OUT_OF_RANGE',
          `strength must be a number within [0, 1], got ${props.strength}`,
        ),
      );
    }

    return ok(new PrerequisiteEdge(from.value, to.value, props.strength));
  }
}
