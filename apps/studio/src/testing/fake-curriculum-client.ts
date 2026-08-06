import type {
  ConceptNode,
  ConceptPrerequisites,
  ConceptSubtree,
  ExamProfileVersionDetail,
  TaxonomyVersionDetail,
  TaxonomyVersionSummary,
} from '@questionbank/contracts';
import type { CurriculumClient } from '../features/taxonomy/curriculum-client.js';

function uuid(seed: number): string {
  return `019fd4bc-0000-7000-8000-${seed.toString(16).padStart(12, '0')}`;
}

export function aConceptNode(overrides: Partial<ConceptNode> = {}): ConceptNode {
  return {
    conceptNodeId: uuid(1),
    conceptIdentityId: uuid(1001),
    parentNodeId: null,
    displayName: 'Physics',
    examWeight: 1,
    depth: 0,
    estimatedTeachingHours: 300,
    ...overrides,
  };
}

/** Physics → Mechanics → Kinematics, plus a sibling chapter. */
export function aTaxonomyTree(): ConceptNode[] {
  const physics = aConceptNode();
  const mechanics = aConceptNode({
    conceptNodeId: uuid(2),
    conceptIdentityId: uuid(1002),
    parentNodeId: physics.conceptNodeId,
    displayName: 'Mechanics',
    examWeight: 0.3,
    depth: 1,
    estimatedTeachingHours: 90,
  });
  const kinematics = aConceptNode({
    conceptNodeId: uuid(3),
    conceptIdentityId: uuid(1003),
    parentNodeId: mechanics.conceptNodeId,
    displayName: 'Kinematics',
    examWeight: 0.1,
    depth: 2,
    estimatedTeachingHours: 30,
  });
  const optics = aConceptNode({
    conceptNodeId: uuid(4),
    conceptIdentityId: uuid(1004),
    parentNodeId: physics.conceptNodeId,
    displayName: 'Optics',
    examWeight: 0.2,
    depth: 1,
    estimatedTeachingHours: 60,
  });

  return [physics, mechanics, kinematics, optics];
}

/** A tree of `count` nodes under one root, for performance assertions. */
export function aLargeTree(count: number): ConceptNode[] {
  const root = aConceptNode();
  const children = Array.from({ length: count - 1 }, (_unused, index) =>
    aConceptNode({
      conceptNodeId: uuid(index + 10),
      conceptIdentityId: uuid(index + 5000),
      parentNodeId: root.conceptNodeId,
      displayName: `Concept ${index}`,
      examWeight: 0.001,
      depth: 1,
      estimatedTeachingHours: 1,
    }),
  );
  return [root, ...children];
}

export interface FakeClientOptions {
  readonly versions?: readonly TaxonomyVersionSummary[];
  readonly nodes?: readonly ConceptNode[];
  readonly prerequisites?: ConceptPrerequisites;
  readonly profile?: ExamProfileVersionDetail;
  readonly failListing?: boolean;
}

export const A_PUBLISHED_VERSION: TaxonomyVersionSummary = {
  taxonomyVersionId: uuid(9001),
  examFamily: 'JEE',
  academicYear: '2026',
  state: 'published',
  publishedAt: '2026-08-05T08:00:00.000Z',
  nodeCount: 4,
  prerequisiteCount: 1,
  aggregateVersion: 3,
};

export const A_DRAFT_VERSION: TaxonomyVersionSummary = {
  ...A_PUBLISHED_VERSION,
  taxonomyVersionId: uuid(9002),
  academicYear: '2027',
  state: 'draft',
  publishedAt: null,
  aggregateVersion: 1,
};

/** Records what was asked of it, so tests can assert lazy loading. */
export class FakeCurriculumClient implements CurriculumClient {
  readonly calls: string[] = [];

  constructor(private readonly options: FakeClientOptions = {}) {}

  async listTaxonomyVersions(examFamily: string): Promise<readonly TaxonomyVersionSummary[]> {
    this.calls.push(`listTaxonomyVersions:${examFamily}`);
    if (this.options.failListing === true) throw new Error('network unavailable');
    return this.options.versions ?? [A_PUBLISHED_VERSION, A_DRAFT_VERSION];
  }

  async getTaxonomyVersion(taxonomyVersionId: string): Promise<TaxonomyVersionDetail> {
    this.calls.push(`getTaxonomyVersion:${taxonomyVersionId}`);
    const summary =
      (this.options.versions ?? [A_PUBLISHED_VERSION, A_DRAFT_VERSION]).find(
        (candidate) => candidate.taxonomyVersionId === taxonomyVersionId,
      ) ?? A_PUBLISHED_VERSION;
    const nodes = this.options.nodes ?? aTaxonomyTree();

    return { ...summary, nodeCount: nodes.length, nodes: [...nodes] };
  }

  async getConceptSubtree(
    taxonomyVersionId: string,
    rootNodeId: string,
    depthLimit?: number,
  ): Promise<ConceptSubtree> {
    this.calls.push(`getConceptSubtree:${taxonomyVersionId}:${rootNodeId}:${depthLimit ?? 'all'}`);
    const nodes = this.options.nodes ?? aTaxonomyTree();
    return { rootNodeId, depthLimit: depthLimit ?? null, nodes: [...nodes] };
  }

  async getConceptPrerequisites(
    taxonomyVersionId: string,
    conceptIdentityId: string,
  ): Promise<ConceptPrerequisites> {
    this.calls.push(`getConceptPrerequisites:${taxonomyVersionId}:${conceptIdentityId}`);
    return (
      this.options.prerequisites ?? { conceptIdentityId, requires: [], requiredBy: [] }
    );
  }

  async getExamProfileVersion(profileVersionId: string): Promise<ExamProfileVersionDetail> {
    this.calls.push(`getExamProfileVersion:${profileVersionId}`);
    if (this.options.profile === undefined) throw new Error('no profile configured');
    return this.options.profile;
  }
}
