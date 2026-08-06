import { err, ok, type Result } from './result.js';
import type { ConceptIdentityId } from './concept-identity.js';

export type ConceptNodeId = string;

export interface CreateConceptNodeProps {
  readonly conceptNodeId: ConceptNodeId;
  readonly conceptIdentityId: ConceptIdentityId;
  readonly displayName: string;
  readonly examWeight: number;
  readonly estimatedTeachingHours: number;
}

export type ConceptNodeErrorCode =
  | 'CONCEPT_NODE_ID_REQUIRED'
  | 'CONCEPT_IDENTITY_ID_REQUIRED'
  | 'DISPLAY_NAME_REQUIRED'
  | 'EXAM_WEIGHT_OUT_OF_RANGE'
  | 'ESTIMATED_TEACHING_HOURS_INVALID'
  | 'DEPTH_INVALID';

export interface ConceptNodeError {
  readonly kind: 'Validation';
  readonly code: ConceptNodeErrorCode;
  readonly message: string;
}

const ROOT_DEPTH = 0;

function validationError(code: ConceptNodeErrorCode, message: string): ConceptNodeError {
  return { kind: 'Validation', code, message };
}

function requireText(value: string, field: string, code: ConceptNodeErrorCode): Result<string, ConceptNodeError> {
  const trimmed = value.replace(/\s+/gu, ' ').trim();
  return trimmed.length === 0 ? err(validationError(code, `${field} must be non-empty`)) : ok(trimmed);
}

function requireExamWeight(value: number): Result<number, ConceptNodeError> {
  return Number.isFinite(value) && value >= 0 && value <= 1
    ? ok(value)
    : err(validationError('EXAM_WEIGHT_OUT_OF_RANGE', `examWeight must be a number within [0, 1], got ${value}`));
}

function requireTeachingHours(value: number): Result<number, ConceptNodeError> {
  return Number.isFinite(value) && value >= 0
    ? ok(value)
    : err(
        validationError(
          'ESTIMATED_TEACHING_HOURS_INVALID',
          `estimatedTeachingHours must be a finite number >= 0, got ${value}`,
        ),
      );
}

function validate(props: CreateConceptNodeProps): Result<CreateConceptNodeProps, ConceptNodeError> {
  const conceptNodeId = requireText(props.conceptNodeId, 'conceptNodeId', 'CONCEPT_NODE_ID_REQUIRED');
  if (!conceptNodeId.ok) return conceptNodeId;

  const conceptIdentityId = requireText(
    props.conceptIdentityId,
    'conceptIdentityId',
    'CONCEPT_IDENTITY_ID_REQUIRED',
  );
  if (!conceptIdentityId.ok) return conceptIdentityId;

  const displayName = requireText(props.displayName, 'displayName', 'DISPLAY_NAME_REQUIRED');
  if (!displayName.ok) return displayName;

  const examWeight = requireExamWeight(props.examWeight);
  if (!examWeight.ok) return examWeight;

  const estimatedTeachingHours = requireTeachingHours(props.estimatedTeachingHours);
  if (!estimatedTeachingHours.ok) return estimatedTeachingHours;

  return ok({
    conceptNodeId: conceptNodeId.value,
    conceptIdentityId: conceptIdentityId.value,
    displayName: displayName.value,
    examWeight: examWeight.value,
    estimatedTeachingHours: estimatedTeachingHours.value,
  });
}

/**
 * A concept's placement inside one taxonomy version (DOMAIN-MODEL §4).
 *
 * `depth` is derived from the parent chain and can never be supplied: a root is
 * created with `createRoot`, every other node with `createUnder(parent, …)`.
 */
export class ConceptNode {
  private constructor(
    readonly conceptNodeId: ConceptNodeId,
    readonly conceptIdentityId: ConceptIdentityId,
    readonly displayName: string,
    readonly examWeight: number,
    readonly estimatedTeachingHours: number,
    readonly depth: number,
    readonly parentNodeId?: ConceptNodeId,
  ) {
    Object.freeze(this);
  }

  static createRoot(props: CreateConceptNodeProps): Result<ConceptNode, ConceptNodeError> {
    const validated = validate(props);
    if (!validated.ok) return validated;

    return ok(
      new ConceptNode(
        validated.value.conceptNodeId,
        validated.value.conceptIdentityId,
        validated.value.displayName,
        validated.value.examWeight,
        validated.value.estimatedTeachingHours,
        ROOT_DEPTH,
      ),
    );
  }

  static createUnder(parent: ConceptNode, props: CreateConceptNodeProps): Result<ConceptNode, ConceptNodeError> {
    const validated = validate(props);
    if (!validated.ok) return validated;

    return ok(
      new ConceptNode(
        validated.value.conceptNodeId,
        validated.value.conceptIdentityId,
        validated.value.displayName,
        validated.value.examWeight,
        validated.value.estimatedTeachingHours,
        parent.depth + 1,
        parent.conceptNodeId,
      ),
    );
  }

  /** Rebuilds a stored node, whose depth and parent are already decided. */
  static reconstitute(
    props: CreateConceptNodeProps & { readonly depth: number; readonly parentNodeId?: ConceptNodeId },
  ): Result<ConceptNode, ConceptNodeError> {
    const validated = validate(props);
    if (!validated.ok) return validated;

    if (!Number.isInteger(props.depth) || props.depth < ROOT_DEPTH) {
      return err(validationError('DEPTH_INVALID', `depth must be an integer >= 0, got ${props.depth}`));
    }

    return ok(
      new ConceptNode(
        validated.value.conceptNodeId,
        validated.value.conceptIdentityId,
        validated.value.displayName,
        validated.value.examWeight,
        validated.value.estimatedTeachingHours,
        props.depth,
        props.parentNodeId,
      ),
    );
  }

  get isRoot(): boolean {
    return this.parentNodeId === undefined;
  }

  /** Re-parents the node, re-deriving depth. Used by taxonomy MOVE operations. */
  moveUnder(parent: ConceptNode): ConceptNode {
    return new ConceptNode(
      this.conceptNodeId,
      this.conceptIdentityId,
      this.displayName,
      this.examWeight,
      this.estimatedTeachingHours,
      parent.depth + 1,
      parent.conceptNodeId,
    );
  }
}
