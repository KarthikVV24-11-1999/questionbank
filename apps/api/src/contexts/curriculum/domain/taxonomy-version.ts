import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import type { ConceptIdentity, ConceptIdentityId } from './concept-identity.js';
import type { ConceptNode, ConceptNodeId } from './concept-node.js';
import type { PrerequisiteEdge } from './prerequisite-edge.js';
import {
  checkNoOrphans,
  checkNoPrerequisiteCycles,
  checkPrerequisiteEndpointsExist,
  checkTaxonomyInvariants,
  type TaxonomyInvariantViolation,
  type TaxonomyStructure,
} from './taxonomy-invariants.js';
import { isLegalTransition, isMutable, type TaxonomyState } from './taxonomy-lifecycle.js';

export type TaxonomyVersionId = string;

export interface CreateTaxonomyVersionProps {
  readonly taxonomyVersionId: TaxonomyVersionId;
  /** The exam family this syllabus snapshot belongs to, e.g. `JEE`, `NEET`. */
  readonly examFamily: string;
  readonly academicYear: string;
}

export type TaxonomyVersionErrorCode =
  | 'TAXONOMY_VERSION_ID_REQUIRED'
  | 'EXAM_FAMILY_REQUIRED'
  | 'ACADEMIC_YEAR_INVALID'
  | 'CONCEPT_IDENTITY_MISMATCH'
  | 'DUPLICATE_CONCEPT_NODE_ID'
  | 'DUPLICATE_CONCEPT_IDENTITY'
  | 'PARENT_NODE_NOT_FOUND'
  | 'PARENT_CYCLE_WOULD_FORM'
  | 'MULTIPLE_ROOTS_FOR_SUBJECT_DOMAIN'
  | 'CONCEPT_NODE_NOT_FOUND'
  | 'NODE_HAS_CHILDREN'
  | 'CONCEPT_REFERENCED_BY_PREREQUISITE'
  | 'PREREQUISITE_CYCLE'
  | 'UNKNOWN_PREREQUISITE_CONCEPT'
  | 'DUPLICATE_PREREQUISITE_EDGE'
  | 'VERSION_NOT_MUTABLE'
  | 'ILLEGAL_STATE_TRANSITION'
  | 'INVARIANT_VIOLATIONS';

export interface TaxonomyVersionError {
  readonly kind: 'Validation' | 'RuleViolation';
  readonly code: TaxonomyVersionErrorCode;
  readonly message: string;
  readonly offendingNodes: readonly string[];
  /** Present when publication was blocked by structural violations. */
  readonly violations?: readonly TaxonomyInvariantViolation[];
}

interface TaxonomyVersionSnapshot {
  readonly taxonomyVersionId: TaxonomyVersionId;
  readonly examFamily: string;
  readonly academicYear: string;
  readonly state: TaxonomyState;
  readonly nodes: readonly ConceptNode[];
  readonly prerequisites: readonly PrerequisiteEdge[];
  readonly subjectDomainOf: ReadonlyMap<ConceptIdentityId, string>;
  readonly publishedAt?: Date;
  readonly publishedBy?: PrincipalRef;
}

const ACADEMIC_YEAR = /^\d{4}(-\d{2})?$/u;

function validationError(
  code: TaxonomyVersionErrorCode,
  message: string,
  offendingNodes: readonly string[] = [],
): TaxonomyVersionError {
  return { kind: 'Validation', code, message, offendingNodes };
}

function ruleViolation(
  code: TaxonomyVersionErrorCode,
  message: string,
  offendingNodes: readonly string[],
): TaxonomyVersionError {
  return { kind: 'RuleViolation', code, message, offendingNodes };
}

/**
 * One snapshot of a syllabus hierarchy, with its publication lifecycle
 * (DOMAIN-MODEL §4).
 *
 * Structural invariants are enforced on every mutation, so a draft can never
 * hold an inconsistent shape; publication re-runs the whole invariant set and
 * fails atomically, leaving the draft untouched. A published version rejects
 * every mutation.
 */
export class TaxonomyVersion {
  readonly taxonomyVersionId: TaxonomyVersionId;
  readonly examFamily: string;
  readonly academicYear: string;
  readonly state: TaxonomyState;
  readonly nodes: readonly ConceptNode[];
  readonly prerequisites: readonly PrerequisiteEdge[];
  readonly subjectDomainOf: ReadonlyMap<ConceptIdentityId, string>;
  readonly publishedBy?: PrincipalRef;
  readonly #publishedAtMs: number | undefined;

  private constructor(snapshot: TaxonomyVersionSnapshot) {
    this.taxonomyVersionId = snapshot.taxonomyVersionId;
    this.examFamily = snapshot.examFamily;
    this.academicYear = snapshot.academicYear;
    this.state = snapshot.state;
    this.nodes = Object.freeze([...snapshot.nodes]);
    this.prerequisites = Object.freeze([...snapshot.prerequisites]);
    this.subjectDomainOf = new Map(snapshot.subjectDomainOf);
    this.#publishedAtMs = snapshot.publishedAt?.getTime();
    if (snapshot.publishedBy !== undefined) this.publishedBy = snapshot.publishedBy;
    Object.freeze(this);
  }

  static createDraft(props: CreateTaxonomyVersionProps): Result<TaxonomyVersion, TaxonomyVersionError> {
    const taxonomyVersionId = props.taxonomyVersionId.trim();
    if (taxonomyVersionId.length === 0) {
      return err(validationError('TAXONOMY_VERSION_ID_REQUIRED', 'taxonomyVersionId must be non-empty'));
    }

    const examFamily = props.examFamily.trim();
    if (examFamily.length === 0) {
      return err(validationError('EXAM_FAMILY_REQUIRED', 'examFamily must be non-empty'));
    }

    const academicYear = props.academicYear.trim();
    if (!ACADEMIC_YEAR.test(academicYear)) {
      return err(
        validationError(
          'ACADEMIC_YEAR_INVALID',
          `academicYear must look like 2026 or 2026-27, got "${props.academicYear}"`,
        ),
      );
    }

    return ok(
      new TaxonomyVersion({
        taxonomyVersionId,
        examFamily,
        academicYear,
        state: 'draft',
        nodes: [],
        prerequisites: [],
        subjectDomainOf: new Map(),
      }),
    );
  }

  /**
   * Rebuilds a stored version. The structure must be internally complete: a
   * partial load — a node whose parent was not loaded, an edge whose endpoint
   * was not loaded — is rejected rather than silently accepted.
   */
  static reconstitute(props: {
    readonly taxonomyVersionId: TaxonomyVersionId;
    readonly examFamily: string;
    readonly academicYear: string;
    readonly state: TaxonomyState;
    readonly nodes: readonly ConceptNode[];
    readonly prerequisites: readonly PrerequisiteEdge[];
    readonly subjectDomainOf: ReadonlyMap<ConceptIdentityId, string>;
    readonly publishedAt?: Date;
    readonly publishedBy?: PrincipalRef;
  }): Result<TaxonomyVersion, TaxonomyVersionError> {
    const structure = {
      nodes: props.nodes,
      prerequisites: props.prerequisites,
      subjectDomainOf: props.subjectDomainOf,
    };

    const incomplete = [
      ...checkNoOrphans(structure),
      ...checkPrerequisiteEndpointsExist(structure),
    ];
    const first = incomplete[0];
    if (first !== undefined) {
      return err({
        kind: 'RuleViolation',
        code: first.code === 'ORPHAN_NODE' ? 'PARENT_NODE_NOT_FOUND' : 'UNKNOWN_PREREQUISITE_CONCEPT',
        message: `taxonomy version ${props.taxonomyVersionId} was loaded incompletely: ${first.message}`,
        offendingNodes: first.offendingNodes,
      });
    }

    return ok(new TaxonomyVersion(props));
  }

  /** A fresh Date on every read — callers cannot mutate the stamp. */
  get publishedAt(): Date | undefined {
    return this.#publishedAtMs === undefined ? undefined : new Date(this.#publishedAtMs);
  }

  nodeById(conceptNodeId: ConceptNodeId): ConceptNode | undefined {
    return this.nodes.find((node) => node.conceptNodeId === conceptNodeId);
  }

  childrenOf(conceptNodeId: ConceptNodeId): readonly ConceptNode[] {
    return this.nodes.filter((node) => node.parentNodeId === conceptNodeId);
  }

  get structure(): TaxonomyStructure {
    return { nodes: this.nodes, prerequisites: this.prerequisites, subjectDomainOf: this.subjectDomainOf };
  }

  get isMutable(): boolean {
    return isMutable(this.state);
  }

  /** Every structural violation in the current shape. Empty means consistent. */
  validate(): readonly TaxonomyInvariantViolation[] {
    return checkTaxonomyInvariants(this.structure);
  }

  addConceptNode(node: ConceptNode, identity: ConceptIdentity): Result<TaxonomyVersion, TaxonomyVersionError> {
    const mutable = this.requireMutable('addConceptNode');
    if (!mutable.ok) return mutable;

    if (identity.conceptIdentityId !== node.conceptIdentityId) {
      return err(
        validationError(
          'CONCEPT_IDENTITY_MISMATCH',
          `node ${node.conceptNodeId} carries concept ${node.conceptIdentityId} but identity ${identity.conceptIdentityId} was supplied`,
          [node.conceptNodeId, node.conceptIdentityId, identity.conceptIdentityId],
        ),
      );
    }

    if (this.nodeById(node.conceptNodeId) !== undefined) {
      return err(
        validationError('DUPLICATE_CONCEPT_NODE_ID', `node ${node.conceptNodeId} is already in this version`, [
          node.conceptNodeId,
        ]),
      );
    }

    const existingPlacement = this.nodes.find((placed) => placed.conceptIdentityId === node.conceptIdentityId);
    if (existingPlacement !== undefined) {
      return err(
        ruleViolation(
          'DUPLICATE_CONCEPT_IDENTITY',
          `concept ${node.conceptIdentityId} is already placed on node ${existingPlacement.conceptNodeId}`,
          [node.conceptIdentityId, existingPlacement.conceptNodeId, node.conceptNodeId],
        ),
      );
    }

    if (node.parentNodeId === undefined) {
      const existingRoot = this.nodes.find(
        (placed) =>
          placed.isRoot && this.subjectDomainOf.get(placed.conceptIdentityId) === identity.subjectDomain,
      );
      if (existingRoot !== undefined) {
        return err(
          ruleViolation(
            'MULTIPLE_ROOTS_FOR_SUBJECT_DOMAIN',
            `subject domain ${identity.subjectDomain} already has root node ${existingRoot.conceptNodeId}`,
            [existingRoot.conceptNodeId, node.conceptNodeId],
          ),
        );
      }
    } else if (this.nodeById(node.parentNodeId) === undefined) {
      return err(
        ruleViolation(
          'PARENT_NODE_NOT_FOUND',
          `node ${node.conceptNodeId} references parent ${node.parentNodeId}, which is not in this version`,
          [node.conceptNodeId, node.parentNodeId],
        ),
      );
    }

    return ok(
      this.with({
        nodes: [...this.nodes, node],
        subjectDomainOf: new Map(this.subjectDomainOf).set(identity.conceptIdentityId, identity.subjectDomain),
      }),
    );
  }

  moveConceptNode(
    conceptNodeId: ConceptNodeId,
    newParentNodeId: ConceptNodeId,
  ): Result<TaxonomyVersion, TaxonomyVersionError> {
    const mutable = this.requireMutable('moveConceptNode');
    if (!mutable.ok) return mutable;

    const node = this.nodeById(conceptNodeId);
    if (node === undefined) {
      return err(
        validationError('CONCEPT_NODE_NOT_FOUND', `node ${conceptNodeId} is not in this version`, [
          conceptNodeId,
        ]),
      );
    }

    const newParent = this.nodeById(newParentNodeId);
    if (newParent === undefined) {
      return err(
        ruleViolation('PARENT_NODE_NOT_FOUND', `parent ${newParentNodeId} is not in this version`, [
          conceptNodeId,
          newParentNodeId,
        ]),
      );
    }

    if (this.descendantsOf(conceptNodeId).some((descendant) => descendant.conceptNodeId === newParentNodeId)) {
      return err(
        ruleViolation(
          'PARENT_CYCLE_WOULD_FORM',
          `moving ${conceptNodeId} under its own descendant ${newParentNodeId} would create a cycle`,
          [conceptNodeId, newParentNodeId],
        ),
      );
    }

    return ok(this.with({ nodes: this.reparent(node, newParent) }));
  }

  removeConceptNode(conceptNodeId: ConceptNodeId): Result<TaxonomyVersion, TaxonomyVersionError> {
    const mutable = this.requireMutable('removeConceptNode');
    if (!mutable.ok) return mutable;

    const node = this.nodeById(conceptNodeId);
    if (node === undefined) {
      return err(
        validationError('CONCEPT_NODE_NOT_FOUND', `node ${conceptNodeId} is not in this version`, [
          conceptNodeId,
        ]),
      );
    }

    const children = this.childrenOf(conceptNodeId);
    if (children.length > 0) {
      return err(
        ruleViolation(
          'NODE_HAS_CHILDREN',
          `node ${conceptNodeId} still has ${children.length} child node(s); remove them first`,
          [conceptNodeId, ...children.map((child) => child.conceptNodeId)],
        ),
      );
    }

    const referencingEdge = this.prerequisites.find(
      (edge) =>
        edge.fromConceptIdentityId === node.conceptIdentityId ||
        edge.toConceptIdentityId === node.conceptIdentityId,
    );
    if (referencingEdge !== undefined) {
      return err(
        ruleViolation(
          'CONCEPT_REFERENCED_BY_PREREQUISITE',
          `concept ${node.conceptIdentityId} is still referenced by a prerequisite edge`,
          [conceptNodeId, referencingEdge.fromConceptIdentityId, referencingEdge.toConceptIdentityId],
        ),
      );
    }

    const remainingNodes = this.nodes.filter((candidate) => candidate.conceptNodeId !== conceptNodeId);
    const remainingDomains = new Map<ConceptIdentityId, string>();
    for (const remaining of remainingNodes) {
      const domain = this.subjectDomainOf.get(remaining.conceptIdentityId);
      if (domain !== undefined) remainingDomains.set(remaining.conceptIdentityId, domain);
    }

    return ok(this.with({ nodes: remainingNodes, subjectDomainOf: remainingDomains }));
  }

  addPrerequisiteEdge(edge: PrerequisiteEdge): Result<TaxonomyVersion, TaxonomyVersionError> {
    const mutable = this.requireMutable('addPrerequisiteEdge');
    if (!mutable.ok) return mutable;

    const placed = new Set(this.nodes.map((node) => node.conceptIdentityId));
    const absent = [edge.fromConceptIdentityId, edge.toConceptIdentityId].filter(
      (identityId) => !placed.has(identityId),
    );
    if (absent.length > 0) {
      return err(
        ruleViolation(
          'UNKNOWN_PREREQUISITE_CONCEPT',
          `prerequisite edge references concept(s) not placed in this version: ${absent.join(', ')}`,
          absent,
        ),
      );
    }

    const duplicate = this.prerequisites.some(
      (existing) =>
        existing.fromConceptIdentityId === edge.fromConceptIdentityId &&
        existing.toConceptIdentityId === edge.toConceptIdentityId,
    );
    if (duplicate) {
      return err(
        validationError(
          'DUPLICATE_PREREQUISITE_EDGE',
          `prerequisite edge ${edge.fromConceptIdentityId} → ${edge.toConceptIdentityId} already exists`,
          [edge.fromConceptIdentityId, edge.toConceptIdentityId],
        ),
      );
    }

    const candidate = [...this.prerequisites, edge];
    const cycle = checkNoPrerequisiteCycles({ ...this.structure, prerequisites: candidate })[0];
    if (cycle !== undefined) {
      return err(ruleViolation('PREREQUISITE_CYCLE', cycle.message, cycle.offendingNodes));
    }

    return ok(this.with({ prerequisites: candidate }));
  }

  removePrerequisiteEdge(
    fromConceptIdentityId: ConceptIdentityId,
    toConceptIdentityId: ConceptIdentityId,
  ): Result<TaxonomyVersion, TaxonomyVersionError> {
    const mutable = this.requireMutable('removePrerequisiteEdge');
    if (!mutable.ok) return mutable;

    const remaining = this.prerequisites.filter(
      (edge) =>
        edge.fromConceptIdentityId !== fromConceptIdentityId ||
        edge.toConceptIdentityId !== toConceptIdentityId,
    );
    if (remaining.length === this.prerequisites.length) {
      return err(
        validationError(
          'UNKNOWN_PREREQUISITE_CONCEPT',
          `no prerequisite edge ${fromConceptIdentityId} → ${toConceptIdentityId} in this version`,
          [fromConceptIdentityId, toConceptIdentityId],
        ),
      );
    }

    return ok(this.with({ prerequisites: remaining }));
  }

  /** draft → published. Atomic: any invariant violation leaves this version unchanged. */
  publish(publishedBy: PrincipalRef, publishedAt: Date): Result<TaxonomyVersion, TaxonomyVersionError> {
    const transition = this.requireTransition('published');
    if (!transition.ok) return transition;

    const violations = this.validate();
    if (violations.length > 0) {
      return err({
        kind: 'RuleViolation',
        code: 'INVARIANT_VIOLATIONS',
        message: `publication blocked by ${violations.length} invariant violation(s)`,
        offendingNodes: violations.flatMap((violation) => violation.offendingNodes),
        violations,
      });
    }

    return ok(
      this.with({
        state: 'published',
        publishedAt: new Date(publishedAt.getTime()),
        publishedBy,
      }),
    );
  }

  /** published → superseded. */
  supersede(): Result<TaxonomyVersion, TaxonomyVersionError> {
    const transition = this.requireTransition('superseded');
    if (!transition.ok) return transition;

    return ok(this.with({ state: 'superseded' }));
  }

  private descendantsOf(conceptNodeId: ConceptNodeId): readonly ConceptNode[] {
    const children = this.childrenOf(conceptNodeId);
    return [...children, ...children.flatMap((child) => this.descendantsOf(child.conceptNodeId))];
  }

  /** Re-parents a node and re-derives the depth of everything beneath it. */
  private reparent(node: ConceptNode, newParent: ConceptNode): readonly ConceptNode[] {
    const moved = node.moveUnder(newParent);
    const byId = new Map(this.nodes.map((candidate) => [candidate.conceptNodeId, candidate]));
    byId.set(moved.conceptNodeId, moved);

    const queue: ConceptNode[] = [moved];
    while (queue.length > 0) {
      const parent = queue.shift() as ConceptNode;
      for (const child of byId.values()) {
        if (child.parentNodeId !== parent.conceptNodeId) continue;
        const rederived = child.moveUnder(parent);
        byId.set(rederived.conceptNodeId, rederived);
        queue.push(rederived);
      }
    }

    return this.nodes.map((candidate) => byId.get(candidate.conceptNodeId) as ConceptNode);
  }

  private requireMutable(operation: string): Result<TaxonomyVersion, TaxonomyVersionError> {
    return this.isMutable
      ? ok(this)
      : err(
          ruleViolation(
            'VERSION_NOT_MUTABLE',
            `${operation} rejected: taxonomy version ${this.taxonomyVersionId} is ${this.state}`,
            [this.taxonomyVersionId],
          ),
        );
  }

  private requireTransition(to: TaxonomyState): Result<TaxonomyVersion, TaxonomyVersionError> {
    return isLegalTransition(this.state, to)
      ? ok(this)
      : err(
          ruleViolation(
            'ILLEGAL_STATE_TRANSITION',
            `taxonomy version ${this.taxonomyVersionId} cannot move from ${this.state} to ${to}`,
            [this.taxonomyVersionId],
          ),
        );
  }

  private snapshot(): TaxonomyVersionSnapshot {
    return {
      taxonomyVersionId: this.taxonomyVersionId,
      examFamily: this.examFamily,
      academicYear: this.academicYear,
      state: this.state,
      nodes: this.nodes,
      prerequisites: this.prerequisites,
      subjectDomainOf: this.subjectDomainOf,
      ...(this.publishedAt !== undefined ? { publishedAt: this.publishedAt } : {}),
      ...(this.publishedBy !== undefined ? { publishedBy: this.publishedBy } : {}),
    };
  }

  private with(changes: Partial<TaxonomyVersionSnapshot>): TaxonomyVersion {
    return new TaxonomyVersion({ ...this.snapshot(), ...changes });
  }
}
