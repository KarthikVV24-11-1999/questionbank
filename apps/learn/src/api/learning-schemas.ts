import { z } from 'zod';

/**
 * The learning responses the learner app reads, validated at the boundary by the contracts client. Mirrored from `openapi/learning.yaml` by hand (the
 * generator covers the content document only, D18), so `learning-api.spec.ts` reads the document and holds these to its required fields: a field the
 * server starts or stops sending fails there, not on a learner's phone.
 */
const decimal = z.string();

export const remediationSchema = z.object({ strategy: z.literal('targeted'), taxonomyVersionId: z.string(), conceptIdentityId: z.string(), selected: z.boolean() });

export const reportedFindingSchema = z.object({
  rank: z.number().int().min(1),
  conceptIdentityId: z.string(),
  taxonomyVersionId: z.string(),
  marksLost: decimal,
  marksAvailable: decimal,
  slots: z.number().int().min(0),
  skipped: z.number().int().min(0),
  remediation: remediationSchema,
});

export const diagnosticReportSchema = z.object({
  reportId: z.string(),
  attemptId: z.string(),
  /** The score record the report is labelled with: it can name an earlier one than stands (D84). */
  scoreRecordId: z.string(),
  generatedAt: z.string(),
  findings: z.array(reportedFindingSchema),
});
export type DiagnosticReportDto = z.infer<typeof diagnosticReportSchema>;
export type ReportedFindingDto = z.infer<typeof reportedFindingSchema>;

export const slotPaceSchema = z.object({
  slotRef: z.string(),
  conceptIdentityId: z.string(),
  outcome: z.enum(['correct', 'incorrect']),
  pace: z.enum(['slow', 'fast', 'unknown']),
  atLeastMs: z.number().int().min(0),
  /** Null where a visit never closed and there is no bound. */
  atMostMs: z.number().int().nullable(),
});

export const conceptPaceSchema = z.object({
  conceptIdentityId: z.string(),
  taxonomyVersionId: z.string(),
  slowCorrect: z.number().int().min(0),
  slowWrong: z.number().int().min(0),
  fastCorrect: z.number().int().min(0),
  fastWrong: z.number().int().min(0),
  unknownCorrect: z.number().int().min(0),
  unknownWrong: z.number().int().min(0),
});

export const paceAnalyticsSchema = z.object({
  attemptId: z.string(),
  slots: z.array(slotPaceSchema),
  concepts: z.array(conceptPaceSchema),
  ruleSets: z.array(z.object({ taxonomyVersionId: z.string(), ruleSetId: z.string(), thresholdsHash: z.string() })),
});
export type PaceAnalyticsDto = z.infer<typeof paceAnalyticsSchema>;

export const scheduledConceptSchema = z.object({
  taxonomyVersionId: z.string(),
  conceptIdentityId: z.string(),
  dueAt: z.string(),
  intervalDays: z.number(),
  consecutiveSuccesses: z.number().int().min(0),
  lapseCount: z.number().int().min(0),
  lastObservedAt: z.string(),
});

export const escalationFindingSchema = z.object({
  taxonomyVersionId: z.string(),
  conceptIdentityId: z.string(),
  lapseCount: z.number().int().min(0),
  escalatedAt: z.string(),
  remediation: remediationSchema,
});

export const reviewPlanSchema = z.object({
  asOf: z.string(),
  /** Most overdue first. */
  due: z.array(scheduledConceptSchema),
  escalated: z.array(escalationFindingSchema),
});
export type ReviewPlanDto = z.infer<typeof reviewPlanSchema>;

export const remediationConceptsSchema = z.object({ conceptIdentityIds: z.array(z.string()) });

export const examChoiceSchema = z.object({ examCode: z.string(), targetYear: z.string(), examProfileVersionId: z.string(), taxonomyVersionId: z.string() });

export const profileScopeSchema = z.object({
  status: z.enum(['in_force', 'needs_review', 'unchecked']),
  taxonomyVersionId: z.string(),
  nodeIds: z.array(z.string()),
  conceptCount: z.number().int().min(1),
  conceptTotal: z.number().int().min(1),
  coverageFraction: z.number().min(0).max(1),
});

export const onboardingStepNames = ['exam', 'class', 'coverage', 'prior_score'] as const;
export type OnboardingStep = (typeof onboardingStepNames)[number];

export const onboardingStateSchema = z.object({
  steps: z.array(z.object({ step: z.enum(onboardingStepNames), state: z.enum(['done', 'pending', 'optional']) })),
  next: z.enum(onboardingStepNames).nullable(),
  skipped: z.boolean(),
});

export const learnerProfileSchema = z.object({
  exam: examChoiceSchema.nullable(),
  currentClass: z.enum(['class_11', 'class_12', 'repeater']).nullable(),
  priorScore: z.object({ value: z.number(), outOf: z.number() }).nullable(),
  scope: profileScopeSchema.nullable(),
  onboarding: onboardingStateSchema,
  version: z.number().int().min(1),
});
export type LearnerProfileDto = z.infer<typeof learnerProfileSchema>;

export const examChoicesSchema = z.object({ exams: z.array(z.object({ examCode: z.string(), displayName: z.string(), years: z.array(z.string()) })) });
export type ExamChoicesDto = z.infer<typeof examChoicesSchema>;

export const scopeOptionsSchema = z.object({
  taxonomyVersionId: z.string(),
  nodes: z.array(z.object({ nodeId: z.string(), parentNodeId: z.string().nullable(), displayName: z.string(), depth: z.number().int().min(0) })),
  conceptTotal: z.number().int().min(1),
  selected: z.array(z.string()),
});
export type ScopeOptionsDto = z.infer<typeof scopeOptionsSchema>;

/** What the learner has said and the server has not yet been told: the body of `PATCH /v1/learning/profile`, every field optional. */
export interface ProfileChange {
  readonly examCode?: string;
  readonly targetYear?: string;
  readonly currentClass?: 'class_11' | 'class_12' | 'repeater';
  readonly priorScore?: { readonly value: number; readonly outOf: number } | null;
  readonly scopeNodeIds?: readonly string[] | null;
}
