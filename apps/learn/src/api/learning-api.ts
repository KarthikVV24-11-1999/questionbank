import type { ApiClient } from '@questionbank/contracts/client';
import {
  diagnosticReportSchema,
  paceAnalyticsSchema,
  remediationConceptsSchema,
  reviewPlanSchema,
  type DiagnosticReportDto,
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
}

export function createLearningApi(client: ApiClient): LearningApi {
  const attempt = (id: string, suffix: string) => `/v1/learning/attempts/${encodeURIComponent(id)}/${suffix}`;
  return {
    getReviewPlan: () => client.request({ path: '/v1/learning/review-plan', responseSchema: reviewPlanSchema }),
    suggestRemediation: async (taxonomyVersionId) =>
      (await client.request({ path: '/v1/learning/remediation-concepts', query: { taxonomyVersionId }, responseSchema: remediationConceptsSchema })).conceptIdentityIds,
    getReport: (attemptId) => client.request({ path: attempt(attemptId, 'report'), responseSchema: diagnosticReportSchema }),
    getPace: (attemptId) => client.request({ path: attempt(attemptId, 'pace'), responseSchema: paceAnalyticsSchema }),
  };
}
