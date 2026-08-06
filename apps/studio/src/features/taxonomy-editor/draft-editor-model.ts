import type { ConceptNode } from '@questionbank/contracts';

/**
 * The editing rules the browser can check without a round trip. The server is
 * still the authority — these exist so a curator sees a cycle the moment they
 * draw it, not after a failed save (M1-33).
 */
export type DraftViolationCode =
  | 'PARENT_CYCLE'
  | 'DUPLICATE_CONCEPT_IDENTITY'
  | 'ORPHAN_NODE'
  | 'PREREQUISITE_CYCLE'
  | 'SELF_PREREQUISITE';

export interface DraftViolation {
  readonly code: DraftViolationCode;
  readonly message: string;
  readonly conceptNodeIds: readonly string[];
}

export interface PrerequisiteEdge {
  readonly fromConceptIdentityId: string;
  readonly toConceptIdentityId: string;
}

export interface DraftState {
  readonly nodes: readonly ConceptNode[];
  readonly prerequisites: readonly PrerequisiteEdge[];
}

function parentChainReaches(
  nodes: readonly ConceptNode[],
  startNodeId: string,
  targetNodeId: string,
): boolean {
  const parentOf = new Map(nodes.map((node) => [node.conceptNodeId, node.parentNodeId]));
  const seen = new Set<string>();
  let current: string | null | undefined = startNodeId;

  while (current !== null && current !== undefined) {
    if (current === targetNodeId && seen.size > 0) return true;
    if (seen.has(current)) return true;
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

/** True when moving `nodeId` under `newParentId` would close a loop. */
export function moveWouldCreateCycle(
  nodes: readonly ConceptNode[],
  nodeId: string,
  newParentId: string,
): boolean {
  if (nodeId === newParentId) return true;

  const childrenOf = (parentId: string): readonly ConceptNode[] =>
    nodes.filter((node) => node.parentNodeId === parentId);

  const descendants: string[] = [];
  const frontier = [nodeId];
  while (frontier.length > 0) {
    const current = frontier.shift() as string;
    for (const child of childrenOf(current)) {
      descendants.push(child.conceptNodeId);
      frontier.push(child.conceptNodeId);
    }
  }

  return descendants.includes(newParentId);
}

function prerequisiteCycle(edges: readonly PrerequisiteEdge[]): string[] | null {
  const successors = new Map<string, string[]>();
  for (const edge of edges) {
    successors.set(edge.fromConceptIdentityId, [
      ...(successors.get(edge.fromConceptIdentityId) ?? []),
      edge.toConceptIdentityId,
    ]);
  }

  const settled = new Set<string>();
  const onPath = new Set<string>();
  const path: string[] = [];
  let found: string[] | null = null;

  function visit(concept: string): void {
    if (found !== null || settled.has(concept)) return;
    if (onPath.has(concept)) {
      found = [...path.slice(path.indexOf(concept)), concept];
      return;
    }

    onPath.add(concept);
    path.push(concept);
    for (const next of successors.get(concept) ?? []) visit(next);
    path.pop();
    onPath.delete(concept);
    settled.add(concept);
  }

  for (const concept of [...successors.keys()].sort()) visit(concept);
  return found;
}

/** Every violation in the draft as it currently stands. */
export function draftViolations(draft: DraftState): DraftViolation[] {
  const violations: DraftViolation[] = [];
  const nodeIds = new Set(draft.nodes.map((node) => node.conceptNodeId));

  for (const node of draft.nodes) {
    if (node.parentNodeId !== null && !nodeIds.has(node.parentNodeId)) {
      violations.push({
        code: 'ORPHAN_NODE',
        message: `${node.displayName} has no parent in this version.`,
        conceptNodeIds: [node.conceptNodeId],
      });
    }
    if (node.parentNodeId !== null && parentChainReaches(draft.nodes, node.conceptNodeId, node.conceptNodeId)) {
      violations.push({
        code: 'PARENT_CYCLE',
        message: `${node.displayName} is inside a loop of parents.`,
        conceptNodeIds: [node.conceptNodeId],
      });
    }
  }

  const byIdentity = new Map<string, string[]>();
  for (const node of draft.nodes) {
    byIdentity.set(node.conceptIdentityId, [
      ...(byIdentity.get(node.conceptIdentityId) ?? []),
      node.conceptNodeId,
    ]);
  }
  for (const [identity, placements] of byIdentity) {
    if (placements.length > 1) {
      violations.push({
        code: 'DUPLICATE_CONCEPT_IDENTITY',
        message: `Concept ${identity} appears ${placements.length} times in this version.`,
        conceptNodeIds: placements,
      });
    }
  }

  for (const edge of draft.prerequisites) {
    if (edge.fromConceptIdentityId === edge.toConceptIdentityId) {
      violations.push({
        code: 'SELF_PREREQUISITE',
        message: 'A concept cannot be a prerequisite of itself.',
        conceptNodeIds: [],
      });
    }
  }

  const cycle = prerequisiteCycle(draft.prerequisites);
  if (cycle !== null) {
    violations.push({
      code: 'PREREQUISITE_CYCLE',
      message: `Prerequisites form a loop: ${cycle.join(' → ')}.`,
      conceptNodeIds: [],
    });
  }

  return violations;
}

export interface PublicationPrecondition {
  readonly label: string;
  readonly met: boolean;
}

/** What must hold before the publish button becomes available. */
export function publicationPreconditions(draft: DraftState): PublicationPrecondition[] {
  const violations = draftViolations(draft);
  const roots = draft.nodes.filter((node) => node.parentNodeId === null);

  return [
    { label: 'The version has at least one concept', met: draft.nodes.length > 0 },
    { label: 'Every subject has exactly one root', met: roots.length > 0 },
    {
      label: 'No structural violations',
      met: violations.length === 0,
    },
    {
      label: 'Prerequisites are acyclic',
      met: violations.every((violation) => violation.code !== 'PREREQUISITE_CYCLE'),
    },
  ];
}
