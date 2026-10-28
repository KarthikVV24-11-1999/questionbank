/**
 * The learning context's composition seam (DEC-M0-5, ADR-0015). The composition root imports this module and nothing else of
 * the context, so what the root needs to implement Learning's port is offered here: the port and the shapes it speaks in, and
 * the one constructor that makes evidence. Everything the root assembles it assembles from the other contexts' seams.
 *
 * It has no `register` yet: the context has no routes. What the root runs of it is the recorder the relay's consumer calls, and nothing else.
 */
import type { Pool } from 'pg';
import { SuggestRemediationConceptsHandler } from '../application/handlers/remediation-handler.js';
import { RecordMasteryEvidenceHandler } from '../application/handlers/record-evidence-handler.js';
import type { Clock, IdentifierFactory } from '../application/ports.js';
import { CreateBookmarkHandler, ListBookmarksHandler, ListErrorEntriesHandler, SetErrorCauseHandler } from '../application/handlers/notebook-handlers.js';
import type { ItemStandingSource } from '../application/ports.js';
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
export type { ItemStandingSource, ReportSlotSource } from '../application/ports.js';
export type { ReportSlot, Finding } from '../domain/diagnostic-report.js';
export type { DiagnosticReportView, ReportedFinding, Remediation } from '../application/handlers/report-handlers.js';
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
}

export function learningForAssessment(deps: { readonly pool: Pool }): LearningForAssessment {
  if (deps.pool === undefined) {
    throw new Error('learning composition is missing required dependency: pool');
  }
  return { remediationConcepts: new SuggestRemediationConceptsHandler({ concepts: new PostgresConceptReader(deps.pool) }) };
}

/**
 * What the learner's own notebook and bookmarks are made of (M7-38): the handlers a route will call, over the learner's own rows. Learning has no routes yet, so the
 * root does not mount these; they are offered here so the surface is a reviewed set (`seam-surface.spec.ts`) and not whatever a route reaches for later.
 * Bookmarks are shown at their item's standing, which is content's to say: `standings` is the port the root fills from content's seam.
 */
export interface LearningForLearner {
  readonly setErrorCause: SetErrorCauseHandler;
  readonly listErrorEntries: ListErrorEntriesHandler;
  readonly createBookmark: CreateBookmarkHandler;
  readonly listBookmarks: ListBookmarksHandler;
  /** The learner's report for a mock, findings ranked by marks lost, each with its remediation (M7-42, M7-43). */
  readonly getReport: GetDiagnosticReportHandler;
}

export function learningForLearner(deps: { readonly pool: Pool; readonly clock: Clock; readonly identifiers: IdentifierFactory; readonly standings: ItemStandingSource }): LearningForLearner {
  for (const key of ['pool', 'clock', 'identifiers', 'standings'] as const) {
    if (deps[key] === undefined) {
      throw new Error(`learning composition is missing required dependency: ${key}`);
    }
  }
  const entries = new PostgresErrorEntryStore(deps.pool);
  const bookmarks = new PostgresBookmarkStore(deps.pool);
  return {
    setErrorCause: new SetErrorCauseHandler({ entries }),
    listErrorEntries: new ListErrorEntriesHandler({ entries }),
    createBookmark: new CreateBookmarkHandler({ bookmarks, clock: deps.clock, identifiers: deps.identifiers }),
    listBookmarks: new ListBookmarksHandler({ bookmarks, standings: deps.standings }),
    getReport: new GetDiagnosticReportHandler({ reports: new PostgresDiagnosticReportStore(deps.pool), concepts: new PostgresConceptReader(deps.pool) }),
  };
}
