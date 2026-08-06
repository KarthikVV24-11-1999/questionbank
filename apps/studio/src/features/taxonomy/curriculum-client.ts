import type {
  ConceptPrerequisites,
  ConceptSubtree,
  ExamProfileVersionDetail,
  TaxonomyVersionDetail,
  TaxonomyVersionSummary,
} from '@questionbank/contracts';

/**
 * Everything Studio needs from the curriculum API. Implemented against the
 * generated client; the tests supply a fake so component behaviour is tested
 * without a network (ENGINEERING-HANDBOOK §5).
 */
export interface CurriculumClient {
  listTaxonomyVersions(examFamily: string): Promise<readonly TaxonomyVersionSummary[]>;
  getTaxonomyVersion(taxonomyVersionId: string): Promise<TaxonomyVersionDetail>;
  getConceptSubtree(
    taxonomyVersionId: string,
    rootNodeId: string,
    depthLimit?: number,
  ): Promise<ConceptSubtree>;
  getConceptPrerequisites(
    taxonomyVersionId: string,
    conceptIdentityId: string,
  ): Promise<ConceptPrerequisites>;
  getExamProfileVersion(profileVersionId: string): Promise<ExamProfileVersionDetail>;
}
