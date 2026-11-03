/**
 * The learning context's composition seam (DEC-M0-5, ADR-0015). The composition root imports this module and nothing else of
 * the context, so what the root needs to implement Learning's port is offered here: the port and the shapes it speaks in, and
 * the one constructor that makes evidence. Everything the root assembles it assembles from the other contexts' seams.
 *
 * `register` mounts the learner's own routes (M7-52, M7-53) over the handlers `learningForLearner` offers; the recorder the relay's consumer calls is offered beside it.
 */
import type { DynamicModule } from '@nestjs/common';
import type { Pool } from 'pg';
import { ProfileAdmission, type RefusalLog } from '../api/admission.js';
import { LearningModule } from '../api/learning.module.js';
import type { PrincipalResolver } from '../api/learning.controller.js';
import { SuggestRemediationConceptsHandler } from '../application/handlers/remediation-handler.js';
import { RecordMasteryEvidenceHandler } from '../application/handlers/record-evidence-handler.js';
import { GetLearnerProfileHandler, GetLearnerScopeHandler, GetScopeOptionsHandler, ListExamChoicesHandler, SkipOnboardingHandler, UpdateLearnerProfileHandler } from '../application/handlers/profile-handlers.js';
import type { Clock, CurriculumSource, IdentifierFactory, RateLimiter, RouteLimits } from '../application/ports.js';
import { PostgresLearnerProfileStore } from '../infrastructure/learner-profile.repository.js';
import { CreateBookmarkHandler, ListBookmarksHandler, ListErrorEntriesHandler, SetErrorCauseHandler } from '../application/handlers/notebook-handlers.js';
import type { ItemStandingSource, PaceSlotSource } from '../application/ports.js';
import { GetReviewPlanHandler } from '../application/handlers/review-plan-handler.js';
import { PostgresReviewStore } from '../infrastructure/review.repository.js';
import { GetPaceAnalyticsHandler } from '../application/handlers/pace-handler.js';
import { PostgresBookmarkStore, PostgresErrorEntryStore } from '../infrastructure/notebook.repository.js';
import { GenerateDiagnosticReportHandler, GetDiagnosticReportHandler } from '../application/handlers/report-handlers.js';
import { PostgresDiagnosticReportStore } from '../infrastructure/diagnostic-report.repository.js';
import { PostgresConceptReader } from '../infrastructure/concept-reader.js';
import { PostgresLearningLedger } from '../infrastructure/learning-ledger.js';
import { PostgresMasteryRuleSetRepository } from '../infrastructure/mastery-rule-set.repository.js';

export { EVIDENCE_OUTCOMES, createMasteryEvidence } from '../domain/mastery-evidence.js';
export type { DifficultyEstimate, EvidenceOutcome, MasteryEvidence } from '../domain/mastery-evidence.js';
export type { ItemStanding } from '../domain/bookmark.js';
export type { GaveUpSlot } from '../domain/error-entry.js';
export type { ItemStandingSource, PaceSlotSource, ReportSlotSource } from '../application/ports.js';
export type { PaceSlot } from '../domain/pace-analytics.js';
export type { PaceAnalyticsView } from '../application/handlers/pace-handler.js';
export type { ReportSlot, Finding } from '../domain/diagnostic-report.js';
export type { DiagnosticReportView, ReportedFinding, Remediation } from '../application/handlers/report-handlers.js';
export type { CurriculumSource, ExamOption, RateLimiter, ResolvedScope, RouteLimits, ScopeNode, ScopeOptions } from '../application/ports.js';
export type { RefusalLog } from '../api/admission.js';
export type { DeclaredScope, ExamChoice } from '../domain/learner-profile.js';
export type {
  AssembledEvidence,
  EvidenceSourceFailure,
  EvidenceSourceResult,
  MasteryEvidenceSource,
  ScoredAttemptRef,
} from '../application/ports.js';

/**
 * What the root runs of the learning context (M7-16): the recorder that stores one attempt's evidence for a learner, recomputes what it touched and appends
 * the transitions, in one transaction. The relay's consumer (`platform/composition/learning-consumer.ts`) is the only caller; it is the system's alone and has
 * no route.
 */
export interface LearningForRelay {
  readonly recordEvidence: RecordMasteryEvidenceHandler;
  /** The report for a scored mock (M7-42): run by the same consumer, after the evidence is recorded. */
  readonly generateReport: GenerateDiagnosticReportHandler;
}

export function learningForRelay(deps: { readonly pool: Pool; readonly clock: Clock; readonly identifiers: IdentifierFactory }): LearningForRelay {
  for (const key of ['pool', 'clock', 'identifiers'] as const) {
    if (deps[key] === undefined) {
      throw new Error(`learning composition is missing required dependency: ${key}`);
    }
  }
  return {
    recordEvidence: new RecordMasteryEvidenceHandler({
      ledger: new PostgresLearningLedger(deps.pool),
      ruleSets: new PostgresMasteryRuleSetRepository(deps.pool),
      clock: deps.clock,
      identifiers: deps.identifiers,
    }),
    generateReport: new GenerateDiagnosticReportHandler({ reports: new PostgresDiagnosticReportStore(deps.pool), clock: deps.clock, identifiers: deps.identifiers }),
  };
}

/**
 * What the assessment context consumes from learning (M7-28, DEC-M7-1): the concepts a remediation run should be about, as identifiers and nothing else.
 * The targeted selection strategy is Learning's judgement and Assessment's execution; this is the one door the judgement leaves through. Adding a second
 * handler here is a deliberate change to what Assessment may ask of Learning, and is reviewed as one.
 */
export interface LearningForAssessment {
  readonly remediationConcepts: SuggestRemediationConceptsHandler;
  /** The concepts the learner declared they have studied, for practice to be drawn from (M8-21). Mock exams never ask it (ADR-0060). */
  readonly learnerScope: GetLearnerScopeHandler;
}

export function learningForAssessment(deps: { readonly pool: Pool }): LearningForAssessment {
  if (deps.pool === undefined) {
    throw new Error('learning composition is missing required dependency: pool');
  }
  return {
    remediationConcepts: new SuggestRemediationConceptsHandler({ concepts: new PostgresConceptReader(deps.pool), profiles: new PostgresLearnerProfileStore(deps.pool) }),
    learnerScope: new GetLearnerScopeHandler({ profiles: new PostgresLearnerProfileStore(deps.pool) }),
  };
}

/**
 * What the learner's own surface is made of (M7-38): the handlers a route calls, over the learner's own rows. They are offered here so the surface is a reviewed set
 * (`seam-surface.spec.ts`) and not whatever a route reaches for later.
 * Bookmarks are shown at their item's standing, which is content's to say: `standings` is the port the root fills from content's seam.
 */
export interface LearningForLearner {
  readonly setErrorCause: SetErrorCauseHandler;
  readonly listErrorEntries: ListErrorEntriesHandler;
  readonly createBookmark: CreateBookmarkHandler;
  readonly listBookmarks: ListBookmarksHandler;
  /** The learner's report for a mock, findings ranked by marks lost, each with its remediation (M7-42, M7-43). */
  readonly getReport: GetDiagnosticReportHandler;
  /** The learner's time against outcome for an attempt, with what the cap threw away reported as not known (M7-46). */
  readonly paceAnalytics: GetPaceAnalyticsHandler;
  /** What the learner has due for review: concepts, never items (M7-47). */
  readonly reviewPlan: GetReviewPlanHandler;
  /** The concepts the learner would practise next, weakest first (M7-28). */
  readonly remediationConcepts: SuggestRemediationConceptsHandler;
  /** The learner's profile, and the steps of onboarding that fill it (M8-18, M8-20). */
  readonly getProfile: GetLearnerProfileHandler;
  readonly updateProfile: UpdateLearnerProfileHandler;
  readonly skipOnboarding: SkipOnboardingHandler;
  readonly examChoices: ListExamChoicesHandler;
  readonly scopeOptions: GetScopeOptionsHandler;
  /** The scope, as practice asks for it: offered here for assessment's seam and not routed (`learning-contract.spec.ts` says so). */
  readonly learnerScope: GetLearnerScopeHandler;
}

export function learningForLearner(deps: { readonly pool: Pool; readonly clock: Clock; readonly identifiers: IdentifierFactory; readonly standings: ItemStandingSource; readonly paceSlots: PaceSlotSource; readonly curriculum: CurriculumSource }): LearningForLearner {
  for (const key of ['pool', 'clock', 'identifiers', 'standings', 'paceSlots', 'curriculum'] as const) {
    if (deps[key] === undefined) {
      throw new Error(`learning composition is missing required dependency: ${key}`);
    }
  }
  const entries = new PostgresErrorEntryStore(deps.pool);
  const bookmarks = new PostgresBookmarkStore(deps.pool);
  const profiles = new PostgresLearnerProfileStore(deps.pool);
  return {
    setErrorCause: new SetErrorCauseHandler({ entries }),
    listErrorEntries: new ListErrorEntriesHandler({ entries }),
    createBookmark: new CreateBookmarkHandler({ bookmarks, clock: deps.clock, identifiers: deps.identifiers }),
    listBookmarks: new ListBookmarksHandler({ bookmarks, standings: deps.standings }),
    getReport: new GetDiagnosticReportHandler({ reports: new PostgresDiagnosticReportStore(deps.pool), concepts: new PostgresConceptReader(deps.pool) }),
    paceAnalytics: new GetPaceAnalyticsHandler({ slots: deps.paceSlots, ruleSets: new PostgresMasteryRuleSetRepository(deps.pool) }),
    reviewPlan: new GetReviewPlanHandler({ reviews: new PostgresReviewStore(deps.pool), concepts: new PostgresConceptReader(deps.pool), clock: deps.clock, profiles }),
    remediationConcepts: new SuggestRemediationConceptsHandler({ concepts: new PostgresConceptReader(deps.pool), profiles }),
    getProfile: new GetLearnerProfileHandler({ profiles, curriculum: deps.curriculum, clock: deps.clock }),
    updateProfile: new UpdateLearnerProfileHandler({ profiles, curriculum: deps.curriculum, clock: deps.clock }),
    skipOnboarding: new SkipOnboardingHandler({ profiles, curriculum: deps.curriculum, clock: deps.clock }),
    examChoices: new ListExamChoicesHandler({ curriculum: deps.curriculum }),
    scopeOptions: new GetScopeOptionsHandler({ profiles, curriculum: deps.curriculum, clock: deps.clock }),
    learnerScope: new GetLearnerScopeHandler({ profiles }),
  };
}

export interface LearningCompositionDeps {
  readonly pool: Pool;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly standings: ItemStandingSource;
  readonly paceSlots: PaceSlotSource;
  readonly principals: PrincipalResolver;
  /** What the profile needs of Curriculum, filled by the root from Curriculum's seam (M8-19). */
  readonly curriculum: CurriculumSource;
  /** Where the profile routes count (M8-20): the platform's limiter, so the limit is the same from every instance. */
  readonly limiter: RateLimiter;
  readonly limits: RouteLimits;
  readonly refusals?: RefusalLog;
}

/** The learner's routes, over the handlers `learningForLearner` offers: the same assembly, so a route reads what the seam offers and nothing more. */
export function register(deps: LearningCompositionDeps): DynamicModule {
  if (deps.principals === undefined) {
    throw new Error('learning composition is missing required dependency: principals');
  }
  for (const key of ['limiter', 'limits'] as const) {
    if (deps[key] === undefined) throw new Error(`learning composition is missing required dependency: ${key}`);
  }
  return LearningModule.register({ handlers: learningForLearner(deps), principals: deps.principals, admission: new ProfileAdmission(deps.limiter, deps.limits, deps.refusals) });
}
