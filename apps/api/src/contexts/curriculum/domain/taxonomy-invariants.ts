import type { ConceptIdentityId } from './concept-identity.js';
import type { ConceptNode, ConceptNodeId } from './concept-node.js';
import type { PrerequisiteEdge } from './prerequisite-edge.js';

export type TaxonomyInvariantCode =
  | 'NO_ROOT_FOR_SUBJECT_DOMAIN'
  | 'MULTIPLE_ROOTS_FOR_SUBJECT_DOMAIN'
  | 'ORPHAN_NODE'
  | 'PARENT_CYCLE'
  | 'PREREQUISITE_CYCLE'
  | 'DUPLICATE_CONCEPT_IDENTITY'
  | 'UNKNOWN_PREREQUISITE_CONCEPT';

/** A structural violation. `offendingNodes` names every node or concept involved. */
export interface TaxonomyInvariantViolation {
  readonly kind: 'RuleViolation';
  readonly code: TaxonomyInvariantCode;
  readonly message: string;
  readonly offendingNodes: readonly string[];
}

export interface TaxonomyStructure {
  readonly nodes: readonly ConceptNode[];
  readonly prerequisites: readonly PrerequisiteEdge[];
  /** Subject domain of each concept identity placed in the version. */
  readonly subjectDomainOf: ReadonlyMap<ConceptIdentityId, string>;
}

function violation(
  code: TaxonomyInvariantCode,
  message: string,
  offendingNodes: readonly string[],
): TaxonomyInvariantViolation {
  return { kind: 'RuleViolation', code, message, offendingNodes };
}

function sorted(values: Iterable<string>): string[] {
  return [...values].sort();
}

/** Exactly one root per subject domain represented in the version. */
export function checkRootsPerSubjectDomain(structure: TaxonomyStructure): TaxonomyInvariantViolation[] {
  const rootsByDomain = new Map<string, ConceptNodeId[]>();
  const domains = new Set<string>();

  for (const node of structure.nodes) {
    const domain = structure.subjectDomainOf.get(node.conceptIdentityId);
    if (domain === undefined) continue;
    domains.add(domain);
    if (node.isRoot) {
      rootsByDomain.set(domain, [...(rootsByDomain.get(domain) ?? []), node.conceptNodeId]);
    }
  }

  const violations: TaxonomyInvariantViolation[] = [];
  for (const domain of sorted(domains)) {
    const roots = rootsByDomain.get(domain) ?? [];
    if (roots.length === 0) {
      violations.push(
        violation('NO_ROOT_FOR_SUBJECT_DOMAIN', `subject domain ${domain} has no root concept`, [domain]),
      );
    } else if (roots.length > 1) {
      violations.push(
        violation(
          'MULTIPLE_ROOTS_FOR_SUBJECT_DOMAIN',
          `subject domain ${domain} has ${roots.length} roots: ${sorted(roots).join(', ')}`,
          sorted(roots),
        ),
      );
    }
  }
  return violations;
}

/** Every non-root node resolves to a parent present in the same version. */
export function checkNoOrphans(structure: TaxonomyStructure): TaxonomyInvariantViolation[] {
  const nodeIds = new Set(structure.nodes.map((node) => node.conceptNodeId));

  return structure.nodes
    .filter((node) => node.parentNodeId !== undefined && !nodeIds.has(node.parentNodeId))
    .map((node) =>
      violation(
        'ORPHAN_NODE',
        `node ${node.conceptNodeId} references unresolvable parent ${String(node.parentNodeId)}`,
        [node.conceptNodeId, String(node.parentNodeId)],
      ),
    );
}

/** No cycle in the parent hierarchy. */
export function checkNoParentCycles(structure: TaxonomyStructure): TaxonomyInvariantViolation[] {
  const parentOf = new Map<ConceptNodeId, ConceptNodeId | undefined>(
    structure.nodes.map((node) => [node.conceptNodeId, node.parentNodeId]),
  );
  const settled = new Set<ConceptNodeId>();
  const violations: TaxonomyInvariantViolation[] = [];
  const reported = new Set<string>();

  for (const node of structure.nodes) {
    const path: ConceptNodeId[] = [];
    const onPath = new Set<ConceptNodeId>();
    let current: ConceptNodeId | undefined = node.conceptNodeId;

    while (current !== undefined && !settled.has(current)) {
      if (onPath.has(current)) {
        const cycle = sorted(path.slice(path.indexOf(current)));
        const key = cycle.join('>');
        if (!reported.has(key)) {
          reported.add(key);
          violations.push(
            violation('PARENT_CYCLE', `parent cycle among nodes: ${cycle.join(', ')}`, cycle),
          );
        }
        break;
      }
      onPath.add(current);
      path.push(current);
      current = parentOf.get(current);
    }
    for (const visited of path) settled.add(visited);
  }
  return violations;
}

/** No duplicate concept identity within one version. */
export function checkNoDuplicateConceptIdentities(
  structure: TaxonomyStructure,
): TaxonomyInvariantViolation[] {
  const nodesByIdentity = new Map<ConceptIdentityId, ConceptNodeId[]>();

  for (const node of structure.nodes) {
    nodesByIdentity.set(node.conceptIdentityId, [
      ...(nodesByIdentity.get(node.conceptIdentityId) ?? []),
      node.conceptNodeId,
    ]);
  }

  return [...nodesByIdentity.entries()]
    .filter(([, nodeIds]) => nodeIds.length > 1)
    .map(([identityId, nodeIds]) =>
      violation(
        'DUPLICATE_CONCEPT_IDENTITY',
        `concept identity ${identityId} is placed on ${nodeIds.length} nodes: ${sorted(nodeIds).join(', ')}`,
        [identityId, ...sorted(nodeIds)],
      ),
    );
}

/** Every prerequisite endpoint is a concept placed in this version. */
export function checkPrerequisiteEndpointsExist(
  structure: TaxonomyStructure,
): TaxonomyInvariantViolation[] {
  const placed = new Set(structure.nodes.map((node) => node.conceptIdentityId));

  return structure.prerequisites
    .flatMap((edge) => [edge.fromConceptIdentityId, edge.toConceptIdentityId])
    .filter((identityId) => !placed.has(identityId))
    .map((identityId) =>
      violation(
        'UNKNOWN_PREREQUISITE_CONCEPT',
        `prerequisite edge references concept ${identityId}, which is not placed in this version`,
        [identityId],
      ),
    );
}

/**
 * No cycle in the prerequisite graph, including indirect cycles of any length.
 * Depth-first search over the adjacency list; the reported cycle is the path
 * segment from the revisited concept back to itself.
 */
export function checkNoPrerequisiteCycles(structure: TaxonomyStructure): TaxonomyInvariantViolation[] {
  const successors = new Map<ConceptIdentityId, ConceptIdentityId[]>();
  for (const edge of structure.prerequisites) {
    successors.set(edge.fromConceptIdentityId, [
      ...(successors.get(edge.fromConceptIdentityId) ?? []),
      edge.toConceptIdentityId,
    ]);
  }

  const settled = new Set<ConceptIdentityId>();
  const onPath = new Set<ConceptIdentityId>();
  const path: ConceptIdentityId[] = [];
  const violations: TaxonomyInvariantViolation[] = [];
  const reported = new Set<string>();

  function visit(concept: ConceptIdentityId): void {
    if (settled.has(concept)) return;
    if (onPath.has(concept)) {
      const cycle = sorted(path.slice(path.indexOf(concept)));
      const key = cycle.join('>');
      if (!reported.has(key)) {
        reported.add(key);
        violations.push(
          violation('PREREQUISITE_CYCLE', `prerequisite cycle among concepts: ${cycle.join(', ')}`, cycle),
        );
      }
      return;
    }

    onPath.add(concept);
    path.push(concept);
    for (const next of successors.get(concept) ?? []) visit(next);
    path.pop();
    onPath.delete(concept);
    settled.add(concept);
  }

  for (const concept of sorted(successors.keys())) visit(concept);
  return violations;
}

/** Runs every structural invariant and returns all violations found. */
export function checkTaxonomyInvariants(structure: TaxonomyStructure): TaxonomyInvariantViolation[] {
  return [
    ...checkNoDuplicateConceptIdentities(structure),
    ...checkNoOrphans(structure),
    ...checkNoParentCycles(structure),
    ...checkRootsPerSubjectDomain(structure),
    ...checkPrerequisiteEndpointsExist(structure),
    ...checkNoPrerequisiteCycles(structure),
  ];
}
