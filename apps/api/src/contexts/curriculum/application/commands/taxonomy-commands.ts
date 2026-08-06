/** The taxonomy write surface. One command per consequential change. */

export interface CreateTaxonomyDraft {
  readonly examFamily: string;
  readonly academicYear: string;
}

export interface AddConceptNode {
  readonly taxonomyVersionId: string;
  readonly conceptIdentityId: string;
  readonly parentNodeId?: string;
  readonly displayName: string;
  readonly examWeight: number;
  readonly estimatedTeachingHours: number;
  readonly expectedAggregateVersion: number;
}

export interface MoveConceptNode {
  readonly taxonomyVersionId: string;
  readonly conceptNodeId: string;
  readonly newParentNodeId: string;
  readonly expectedAggregateVersion: number;
}

export interface RemoveConceptNode {
  readonly taxonomyVersionId: string;
  readonly conceptNodeId: string;
  readonly expectedAggregateVersion: number;
}

export interface AddPrerequisiteEdge {
  readonly taxonomyVersionId: string;
  readonly fromConceptIdentityId: string;
  readonly toConceptIdentityId: string;
  readonly strength: number;
  readonly expectedAggregateVersion: number;
}

export interface PublishTaxonomyVersion {
  readonly taxonomyVersionId: string;
  readonly expectedAggregateVersion: number;
}
