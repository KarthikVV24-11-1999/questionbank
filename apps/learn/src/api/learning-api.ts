import type { ApiClient } from '@questionbank/contracts/client';
import {
  diagnosticReportSchema,
  examChoicesSchema,
  learnerProfileSchema,
  scopeOptionsSchema,
  paceAnalyticsSchema,
  remediationConceptsSchema,
  conceptEvidenceSchema,
  conceptMapSchema,
  conceptNamesSchema,
  reviewPlanSchema,
  type ConceptEvidenceDto,
  type ConceptMapDto,
  type DiagnosticReportDto,
  type NamedConceptDto,
  type ExamChoicesDto,
  type LearnerProfileDto,
  type ProfileChange,
  type ScopeOptionsDto,
  type PaceAnalyticsDto,
  type ReviewPlanDto,
} from './learning-schemas.js';

/** The learner's reads of Learning, through the one typed client (F15). The learner is the principal and is never named in a request. */
export interface LearningApi {
  getReviewPlan(): Promise<ReviewPlanDto>;
  /** The concepts to practise next, weakest first, as ids. */
  suggestRemediation(taxonomyVersionId: string): Promise<readonly string[]>;
  getReport(attemptId: string): Promise<DiagnosticReportDto>;
  getPace(attemptId: string): Promise<PaceAnalyticsDto>;
  /** What the learner knows, topic by topic, read now (M8-29). */
  getConceptMap(): Promise<ConceptMapDto>;
  /** The answers behind one topic's standing, newest first, a page at a time. */
  getConceptEvidence(conceptIdentityId: string, page: { readonly limit: number; readonly offset: number }): Promise<ConceptEvidenceDto>;
  /** What topics are called, with the chapter and subject above them. At most {@link NAMES_PER_REQUEST} to a call. */
  conceptNames(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<readonly NamedConceptDto[]>;
}

/** The most topics one `conceptNames` call asks for: the route's own limit, which `learning.yaml` states. The caller pages at it. */
export const NAMES_PER_REQUEST = 100;

/** The learner's profile and onboarding (M8-22). Every call is the learner's own; none is required to use the product. */
export interface ProfileApi {
  getProfile(): Promise<LearnerProfileDto>;
  updateProfile(change: ProfileChange): Promise<LearnerProfileDto>;
  skipOnboarding(): Promise<LearnerProfileDto>;
  examChoices(): Promise<ExamChoicesDto>;
  scopeOptions(): Promise<ScopeOptionsDto>;
}

export function createLearningApi(client: ApiClient): LearningApi {
  const attempt = (id: string, suffix: string) => `/v1/learning/attempts/${encodeURIComponent(id)}/${suffix}`;
  return {
    getReviewPlan: () => client.request({ path: '/v1/learning/review-plan', responseSchema: reviewPlanSchema }),
    suggestRemediation: async (taxonomyVersionId) =>
      (await client.request({ path: '/v1/learning/remediation-concepts', query: { taxonomyVersionId }, responseSchema: remediationConceptsSchema })).conceptIdentityIds,
    getReport: (attemptId) => client.request({ path: attempt(attemptId, 'report'), responseSchema: diagnosticReportSchema }),
    getPace: (attemptId) => client.request({ path: attempt(attemptId, 'pace'), responseSchema: paceAnalyticsSchema }),
    getConceptMap: () => client.request({ path: '/v1/learning/concept-map', responseSchema: conceptMapSchema }),
    getConceptEvidence: (conceptIdentityId, page) =>
      client.request({ path: `/v1/learning/concept-map/${encodeURIComponent(conceptIdentityId)}/evidence`, query: { limit: String(page.limit), offset: String(page.offset) }, responseSchema: conceptEvidenceSchema }),
    conceptNames: async (taxonomyVersionId, conceptIdentityIds) =>
      (await client.request({ path: '/v1/learning/concept-names', query: { taxonomyVersionId, conceptIdentityIds: conceptIdentityIds.join(',') }, responseSchema: conceptNamesSchema })).concepts,
  };
}

export function createProfileApi(client: ApiClient): ProfileApi {
  return {
    getProfile: () => client.request({ path: '/v1/learning/profile', responseSchema: learnerProfileSchema }),
    updateProfile: (change) => client.request({ path: '/v1/learning/profile', method: 'PATCH', body: change, responseSchema: learnerProfileSchema }),
    skipOnboarding: () => client.request({ path: '/v1/learning/profile/skip', method: 'POST', responseSchema: learnerProfileSchema }),
    examChoices: () => client.request({ path: '/v1/learning/profile/exam-choices', responseSchema: examChoicesSchema }),
    scopeOptions: () => client.request({ path: '/v1/learning/profile/scope-options', responseSchema: scopeOptionsSchema }),
  };
}
