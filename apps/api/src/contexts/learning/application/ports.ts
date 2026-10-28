import type { PrincipalRef } from '@questionbank/domain-types';
import type { Bookmark, ItemStanding } from '../domain/bookmark.js';
import type { ErrorCause, ErrorEntry } from '../domain/error-entry.js';
import type { EvidenceOutcome, MasteryEvidence } from '../domain/mastery-evidence.js';
import type { MasteryRuleSet, MasteryThresholds } from '../domain/mastery-rule-set.js';
import type { Result } from '../domain/result.js';
import type { ReviewSchedule } from '../domain/review-schedule.js';
import type { ApplicationError, AuthorizationContext } from './authorization.js';

export interface ApplicationContext extends AuthorizationContext {
  readonly correlationId: string;
}

/** One row per consequential command (DATA-ARCHITECTURE P3). */
export interface AuditRecord {
  readonly principal: PrincipalRef;
  readonly action: string;
  readonly targetContext: 'learning';
  readonly targetType: string;
  readonly targetId: string;
  readonly targetVersion?: number;
  readonly correlationId: string;
  readonly occurredAt: Date;
}

export interface AuditRecorder {
  record(entry: AuditRecord): Promise<void>;
}

/** The clock lives here, not in the domain: every instant the domain reasons about is supplied. */
export interface Clock {
  now(): Date;
}

export interface IdentifierFactory {
  next(): string;
}

/**
 * Where mastery thresholds are kept (M7-12). Versions are appended and never changed; the repository has no update and no delete, and the table
 * refuses both.
 */
export interface MasteryRuleSetRepository {
  /**
   * Publishes the next version for a scope. The version number is assigned in the same statement that inserts the row, so two publications of the same
   * scope cannot take one number: the second is a `Conflict`.
   */
  append(draft: {
    readonly ruleSetId: string;
    readonly taxonomyVersionId: string | null;
    readonly thresholds: MasteryThresholds;
    readonly thresholdsHash: string;
    readonly principal: PrincipalRef;
    readonly createdAt: Date;
  }): Promise<Result<MasteryRuleSet, ApplicationError>>;

  /** The latest version published for the taxonomy, or the latest platform default where nothing is published for it. */
  currentFor(taxonomyVersionId: string): Promise<Result<MasteryRuleSet, ApplicationError>>;

  /** A version by its identifier: what a transition pinned. */
  byId(ruleSetId: string): Promise<Result<MasteryRuleSet, ApplicationError>>;
}

/**
 * Where Learning's evidence comes from — a port Learning defines and does not implement (M7-04).
 *
 * The implementation lives in `platform/composition/`, which reads scoring and content through the two seams each offers and
 * joins them (M7-05). Learning therefore has no production import of either context, and no event it consumes has to carry a
 * copy of what the owning context knows (DEC-M7-1).
 */

/** The `AttemptScored` fact the evidence is assembled for: identifiers and an instant, nothing of the score. */
export interface ScoredAttemptRef {
  readonly attemptId: string;
  readonly scoreRecordId: string;
  /**
   * When the attempt was scored. It is the same for every slot of the attempt and is **not** the instant of any response: the evidence's
   * `occurredAt` comes from the response log (M7-11), and this is kept on the evidence as `scoredAt`.
   */
  readonly scoredAt: string;
}

/** What assembly decided about a scored attempt, so a response left out is counted and not silently lost. */
export interface AssembledEvidence {
  /** Whose evidence it is. */
  readonly learnerRef: string;
  readonly evidence: readonly MasteryEvidence[];
  /** Slots that were not evidence: unattempted, dropped, bonus, indeterminate. */
  readonly notEvidence: number;
  /** Questions the learner gave up on, which are among the `notEvidence` and are not evidence either; each is an entry in the error notebook (M7-38). */
  readonly gaveUp: readonly import('../domain/error-entry.js').GaveUpSlot[];
}

export type EvidenceSourceFailure =
  | { readonly code: 'ATTEMPT_NOT_SCORED'; readonly message: string }
  | { readonly code: 'ITEM_VERSION_UNRESOLVED'; readonly message: string; readonly itemVersionIds: readonly string[] }
  /** A slot scoring counted as a response has no response standing in the log: the two disagree, and a retry will not make them agree. */
  | { readonly code: 'RESPONSE_INSTANT_UNRESOLVED'; readonly message: string; readonly slotRefs: readonly string[] }
  | { readonly code: 'SOURCE_UNAVAILABLE'; readonly message: string };

export type EvidenceSourceResult =
  | { readonly ok: true; readonly value: AssembledEvidence }
  | { readonly ok: false; readonly error: EvidenceSourceFailure };

export interface MasteryEvidenceSource {
  /**
   * The evidence one scored attempt implies. **All or nothing**: an attempt with a slot whose item version cannot be resolved
   * yields a failure naming it, never the evidence for the others, because a mastery update from part of an attempt is a
   * wrong update that nothing would flag.
   */
  evidenceForScoredAttempt(attempt: ScoredAttemptRef): Promise<EvidenceSourceResult>;
}

/** What a stored response counts as: a re-score can change it, and can say it no longer counts. */
export type EvidenceCorrectionOutcome = EvidenceOutcome | 'withdrawn';

export interface StoredAttemptEvidence {
  readonly evidenceId: string;
  readonly slotRef: string;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly outcome: EvidenceCorrectionOutcome;
}

/** A response ready to be stored: the evidence, whose it is, and what it is called. */
export interface NewEvidenceRow {
  readonly evidenceId: string;
  readonly learnerRef: string;
  readonly evidence: MasteryEvidence;
  readonly recordedAt: Date;
}

/**
 * What one learner's ledger offers inside a transaction (M7-14). Every call is for the learner the transaction was opened for, so a handler cannot
 * read or write another learner's evidence by accident; and everything written commits together or not at all, so evidence, the sittings it was placed in
 * and the states it produced are never out of step.
 */
export interface LedgerTransaction {
  /** What the learner's ledger holds for one attempt, each response at what it counts as now: its latest correction if it has one. */
  attemptEvidence(attemptRef: string): Promise<readonly StoredAttemptEvidence[]>;
  /** Records what a re-score made of responses already stored; the rows they correct are left as they were (D72). */
  correctEvidence(corrections: readonly { readonly evidenceId: string; readonly outcome: EvidenceCorrectionOutcome }[], recordedAt: Date): Promise<void>;
  /** A concept's transitions that have not been revoked, oldest first. */
  activeTransitions(taxonomyVersionId: string, conceptIdentityId: string): Promise<readonly import('../domain/mastery-transition.js').MasteryTransition[]>;
  /** Revokes transitions a correction does not support. They are kept, with the responses they were made on, and no longer read as where the concept stands. */
  revokeTransitions(transitionIds: readonly string[], revokedAt: Date): Promise<void>;
  /** Stores the evidence rows that are new, and returns those: a response already stored for its attempt and slot is not stored twice. */
  insertEvidence(rows: readonly NewEvidenceRow[]): Promise<readonly NewEvidenceRow[]>;
  /** The learner's sittings, earliest first. */
  sessions(): Promise<readonly import('../domain/study-session.js').StudySession[]>;
  /** Places a response in a sitting: records its extent, assigns the response to it, and folds the sittings it bridged into it. */
  placeEvidence(
    evidenceId: string,
    session: import('../domain/study-session.js').StudySession,
    absorbed: readonly string[],
  ): Promise<void>;
  /** The evidence behind each of the concepts, with the sitting each response is in. */
  conceptEvidence(
    taxonomyVersionId: string,
    conceptIdentityIds: readonly string[],
  ): Promise<ReadonlyMap<string, readonly import('../domain/concept-state.js').ConceptEvidence[]>>;
  saveConceptStates(
    taxonomyVersionId: string,
    states: readonly import('../domain/concept-state.js').ConceptState[],
    ruleSetId: string,
    /** Per concept, the weakest state since it was last strong; absent or `null` while it is held at `strong`. */
    floors: ReadonlyMap<string, import('../domain/concept-state.js').MasteryState | null>,
  ): Promise<void>;
  /** Removes the states of concepts a correction left with no evidence at all: a state is derived, and there is nothing left to derive it from. */
  dropConceptStates(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<void>;
  /** Where each concept stands in its history of transitions: held at `strong` or not, the floor, and a promotion still awaiting verification. */
  conceptTracking(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<ReadonlyMap<string, ConceptTracking>>;
  /** Appends transitions with their qualifying and verifying responses. */
  saveTransitions(taxonomyVersionId: string, transitions: readonly import('../domain/mastery-transition.js').MasteryTransition[], recordedAt: Date): Promise<void>;
  /** Verifies a stored promotion, once. */
  verifyTransition(transitionId: string, verifiedAt: string, verifyingEvidence: readonly string[]): Promise<void>;
  /** Stores the error entries that are new; one already stored for its attempt and slot is left as it is, which is what makes a replay write nothing more (M7-38). */
  insertErrorEntries(entries: readonly ErrorEntry[], recordedAt: Date): Promise<void>;
  /**
   * Clears the learner's open entries for the concept a verified transition is about, that happened no later than the transition (M7-38). The table's own guard decides
   * whether the transition may clear them and refuses if it may not; this asks it to, and says how many it did.
   */
  resolveErrorEntries(transitionId: string): Promise<number>;
  /** Stores the schedules of concepts a delivery touched, replacing each one's previous (M7-47): a schedule is derived, and is the same row recomputed. */
  saveReviewSchedules(taxonomyVersionId: string, schedules: readonly import('../domain/review-schedule.js').ReviewSchedule[], ruleSetId: string): Promise<void>;
  /**
   * Records that concepts have lapsed often enough to be escalated (M7-48), and returns the ones that were **not already** escalated: a concept has one open escalation
   * at a time, and a delivery that finds it escalated writes nothing and reports nothing. A concept whose earlier escalation was resolved can be escalated again (D85).
   */
  escalate(taxonomyVersionId: string, escalations: readonly { readonly conceptIdentityId: string; readonly lapseCount: number }[], ruleSetId: string, escalatedAt: Date): Promise<readonly string[]>;
  /**
   * Resolves the open escalations of these concepts (D85), each with why, and returns the ones that had one. The escalation is not changed: the resolution is a row
   * beside it, and a concept with none open is passed over.
   */
  resolveEscalations(taxonomyVersionId: string, resolutions: readonly { readonly conceptIdentityId: string; readonly reason: 'recovered' | 'lapses_corrected' }[], ruleSetId: string, resolvedAt: Date): Promise<readonly { readonly conceptIdentityId: string; readonly reason: 'recovered' | 'lapses_corrected' }[]>;
  /** Removes the schedules of concepts a correction left with no evidence at all. */
  dropReviewSchedules(taxonomyVersionId: string, conceptIdentityIds: readonly string[]): Promise<void>;
}

/** The learner's own error notebook entries, outside the evidence transaction: the one thing a learner edits is the cause. */
export interface ErrorEntryStore {
  find(learnerRef: string, errorEntryId: string): Promise<Result<ErrorEntry, ApplicationError>>;
  list(learnerRef: string, options: { readonly openOnly: boolean }): Promise<Result<readonly ErrorEntry[], ApplicationError>>;
  setCause(learnerRef: string, errorEntryId: string, cause: ErrorCause): Promise<Result<ErrorEntry, ApplicationError>>;
}

export interface BookmarkStore {
  /** Adds a bookmark; the same item again returns the one already there. */
  add(bookmark: Bookmark): Promise<Result<Bookmark, ApplicationError>>;
  list(learnerRef: string): Promise<Result<readonly Bookmark[], ApplicationError>>;
}

/** Where an item's standing comes from — a port whose adapter calls content through the seam the composition root passes; Learning names no content handler. */
export interface ItemStandingSource {
  standings(itemIds: readonly string[], context: ApplicationContext): Promise<Result<readonly ItemStanding[], ApplicationError>>;
}

/** What the ledger knows of one concept's transitions, from the last one stored. */
export interface ConceptTracking {
  readonly held: boolean;
  readonly floor: import('../domain/concept-state.js').MasteryState | null;
  /** The last transition if it is a promotion not yet verified. */
  readonly open: {
    readonly transitionId: string;
    readonly occurredAt: string;
    readonly qualifyingEvidence: readonly string[];
    readonly ruleSetId: string;
    readonly ruleSetHash: string;
  } | null;
}

/** Thrown inside a transaction to roll it back and report a specific failure, where an ordinary error would be reported as the ledger being unavailable. */
export class LedgerAbort extends Error {
  constructor(readonly failure: ApplicationError) {
    super(failure.message);
  }
}

export interface LearningLedger {
  /** Runs `work` in one transaction for one learner, serialised against any other for the same learner; a failure rolls everything back. */
  inTransaction<T>(learnerRef: string, work: (tx: LedgerTransaction) => Promise<T>): Promise<Result<T, ApplicationError>>;
}

/** A schedule with the taxonomy version its concept is in, as the learner reads it. */
export interface ScheduledConcept extends ReviewSchedule {
  readonly taxonomyVersionId: string;
}

/** The learner's review schedule, outside the evidence transaction: what is due now. */
export interface ReviewStore {
  /** Concepts due at or before `asOf`, most overdue first. A concept that has been escalated is not here: it is not repeated again (M7-48). */
  due(learnerRef: string, asOf: Date): Promise<Result<readonly ScheduledConcept[], ApplicationError>>;
  /** The concepts escalated to remediation, earliest first. */
  escalations(learnerRef: string): Promise<Result<readonly EscalatedConcept[], ApplicationError>>;
}

export interface EscalatedConcept {
  readonly taxonomyVersionId: string;
  readonly conceptIdentityId: string;
  readonly lapseCount: number;
  readonly escalatedAt: string;
}

/** The learner's concept states, read for remediation (M7-28): the concepts to work on, weakest first, as identifiers and nothing else. */
export interface ConceptReader {
  weakest(learnerRef: string, taxonomyVersionId: string, limit: number): Promise<Result<readonly string[], ApplicationError>>;
}

/** One scored attempt's slots as a report reads them: every slot, attributed to its concept, with marks as decimal text. */
export interface ReportSlotSource {
  slotsForScoredAttempt(attempt: ScoredAttemptRef): Promise<
    | { readonly ok: true; readonly value: { readonly learnerRef: string; readonly slots: readonly import('../domain/diagnostic-report.js').ReportSlot[] } }
    | { readonly ok: false; readonly error: EvidenceSourceFailure }
  >;
}

/**
 * One scored attempt's responses with the time each took, for the learner it belongs to (M7-46): every response that was given, attributed to its concept, with the
 * time on item as the response log counts it and what that count lost (M7-45). A port Learning defines and the composition root implements from scoring, assessment and
 * content; an attempt that is not the learner's is not found, and says no more than an attempt that does not exist.
 */
export interface PaceSlotSource {
  paceSlotsForAttempt(learnerRef: string, attemptId: string): Promise<Result<readonly import('../domain/pace-analytics.js').PaceSlot[], ApplicationError>>;
}

export interface StoredReport {
  readonly reportId: string;
  readonly learnerRef: string;
  readonly attemptRef: string;
  readonly scoreRecordRef: string;
  readonly generatedAt: string;
  readonly findings: readonly import('../domain/diagnostic-report.js').Finding[];
}

/** Reports are appended and never changed. */
export interface DiagnosticReportStore {
  /** Stores the report; `false` where one already exists for the attempt's score record, which is left as it was. */
  insert(report: StoredReport): Promise<Result<boolean, ApplicationError>>;
  /** The newest report for the learner's attempt, which after a re-score is the one for the score that stands. */
  latest(learnerRef: string, attemptRef: string): Promise<Result<StoredReport | null, ApplicationError>>;
}
