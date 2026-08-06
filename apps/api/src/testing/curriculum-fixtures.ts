import { ConceptIdentity } from '../contexts/curriculum/domain/concept-identity.js';
import { ConceptNode } from '../contexts/curriculum/domain/concept-node.js';
import { PrerequisiteEdge } from '../contexts/curriculum/domain/prerequisite-edge.js';
import { expectValue } from './expect-result.js';

export function anIdentity(conceptIdentityId: string, subjectDomain = 'physics'): ConceptIdentity {
  return expectValue(
    ConceptIdentity.create({
      conceptIdentityId,
      canonicalName: conceptIdentityId.replace(/^ci_/u, '').replace(/_/gu, ' '),
      subjectDomain,
      createdInVersion: 'tv_2026',
    }),
  );
}

export function aRootNode(conceptNodeId: string, conceptIdentityId: string, examWeight = 1): ConceptNode {
  return expectValue(
    ConceptNode.createRoot({
      conceptNodeId,
      conceptIdentityId,
      displayName: conceptNodeId,
      examWeight,
      estimatedTeachingHours: 10,
    }),
  );
}

export function aChildNode(
  parent: ConceptNode,
  conceptNodeId: string,
  conceptIdentityId: string,
  examWeight = 0.1,
): ConceptNode {
  return expectValue(
    ConceptNode.createUnder(parent, {
      conceptNodeId,
      conceptIdentityId,
      displayName: conceptNodeId,
      examWeight,
      estimatedTeachingHours: 10,
    }),
  );
}

export function anEdge(from: string, to: string, strength = 0.5): PrerequisiteEdge {
  return expectValue(
    PrerequisiteEdge.create({ fromConceptIdentityId: from, toConceptIdentityId: to, strength }),
  );
}

export function subjectDomains(entries: Record<string, string>): ReadonlyMap<string, string> {
  return new Map(Object.entries(entries));
}
