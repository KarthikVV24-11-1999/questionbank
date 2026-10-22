import type { AssessmentError } from './assessment-error.js';
import type { AnchorPoolMember } from './anchor-pool.js';
import type { Attempt } from './attempt.js';
import type { AttemptState } from './attempt-state.js';
import type { ExposureEntry } from './exposure.js';
import type { Form, FormError, ScheduleWindow } from './form.js';
import type { ResponseEvent } from './response-event.js';
import type { Result } from './result.js';

/**
 * What the application layer needs from persistence, declared by the domain so
 * the dependency points inward. Infrastructure implements these; nothing here
 * knows how anything is stored.
 */
export type RepositoryError = AssessmentError<'CONFLICT' | 'NOT_FOUND' | 'PERSISTENCE_REJECTED' | 'STORE_UNAVAILABLE'>;

export interface FormRepository {
  /**
   * Writes a form. A new form is inserted; a draft already stored has its
   * composition replaced; a draft that arrives published is published. A form
   * already stored as published is never changed — saving the identical form is
   * a no-op and saving a different one is a `CONFLICT` (D-006).
   */
  save(form: Form): Promise<Result<Form, RepositoryError>>;

  findById(formId: string): Promise<Result<Form, RepositoryError>>;

  /**
   * Publishes a stored draft — the one path that does. In **one transaction**:
   * the anchor floor is checked against the pool as it stands, the exposure
   * ledger is written, and the form's state changes; if any of the three
   * cannot happen, none of them does. A form already published is returned as
   * it is and writes nothing, so publishing twice cannot count a form twice.
   */
  publish(formId: string, now: string): Promise<Result<Form, RepositoryError | FormError>>;

  /** published → embargoed: gives the form its window. Refused from any other state. */
  schedule(formId: string, window: ScheduleWindow, now: string): Promise<Result<Form, RepositoryError | FormError>>;

  /** embargoed → active, once the window has begun. */
  open(formId: string, now: string): Promise<Result<Form, RepositoryError | FormError>>;

  /** active → closed, once the window has ended. */
  close(formId: string, now: string): Promise<Result<Form, RepositoryError | FormError>>;

  /**
   * What a sweep would act on: scheduled forms whose window has begun, and open
   * ones whose window has ended. **Nothing calls these on a schedule** — there
   * is no scheduler (D36); the operations exist so that whatever eventually
   * does has something to call.
   */
  findDueToOpen(now: string, limit: number): Promise<Result<readonly Form[], RepositoryError>>;
  findDueToClose(now: string, limit: number): Promise<Result<readonly Form[], RepositoryError>>;
}

/** Reads of the exposure ledger. There is deliberately no write here: publication is the only writer. */
export interface ExposureLedger {
  /** How many forms each item version has been placed in. A version never placed is absent, not zero. */
  countsByItemVersion(itemVersionIds: readonly string[]): Promise<Result<ReadonlyMap<string, number>, RepositoryError>>;

  /** Every row a form wrote, in slot order and then session order. */
  entriesForForm(formId: string): Promise<Result<readonly ExposureEntry[], RepositoryError>>;

  /**
   * Exposure joined to the attempts that sat it, per session (ADR-0032): for each
   * item version and each session it was placed in, how many ledger rows placed
   * it there and how many attempts in that same session on that same form were
   * started. This join is what multi-shift normalization reads, and it is
   * possible only because the ledger's session and the attempt's session are one
   * key. A session nobody has sat yet appears with zero attempts.
   */
  exposureBySession(itemVersionIds: readonly string[]): Promise<Result<readonly SessionExposure[], RepositoryError>>;
}

export interface SessionExposure {
  readonly sessionRef: string;
  readonly itemVersionId: string;
  readonly placements: number;
  readonly attemptsSat: number;
}

export interface AttemptRepository {
  /**
   * Writes a new attempt and pins its slots, in one transaction. A student who
   * already has an active mock gets a `CONFLICT` from the database's unique
   * index, whoever raced whom; an attempt against a draft form is
   * `PERSISTENCE_REJECTED`.
   */
  create(attempt: Attempt, creationKey?: string): Promise<Result<Attempt, RepositoryError>>;

  /** The attempt a student already created under this key, if any — what makes a retried create return the same attempt. */
  findByCreationKey(studentId: string, creationKey: string): Promise<Result<Attempt | undefined, RepositoryError>>;

  /**
   * Records a move along the state machine. `expected` is the state the caller
   * read the attempt in: if another writer moved it since, nothing is written
   * and the answer is a `CONFLICT`, never a silent overwrite.
   */
  save(attempt: Attempt, expected: AttemptState): Promise<Result<Attempt, RepositoryError>>;

  findById(attemptId: string): Promise<Result<Attempt, RepositoryError>>;

  /** The student's active mock attempt — `created` or `in_progress` — if they have one. */
  findActiveMock(studentId: string): Promise<Result<Attempt | undefined, RepositoryError>>;

  /**
   * Live attempts — `created` or `in_progress` — whose window has closed, oldest
   * first: the ones that may be abandoned if they hold no response. Whether one
   * does is the response log's to say, so the caller asks `answeredSlotCount`
   * and the domain's `abandonAttempt` decides. Nothing calls this on a schedule
   * (D36).
   */
  findAbandonable(now: string, limit: number): Promise<Result<readonly Attempt[], RepositoryError>>;
}

export interface ResponseLog {
  /**
   * Appends one event to the attempt's log. Idempotent on the event id: the
   * same event again returns what is already stored and writes nothing, a
   * different event under a used id is a `CONFLICT`. The stored event carries
   * the `afterSubmission` the database decided from the attempt's state.
   */
  append(event: ResponseEvent): Promise<Result<ResponseEvent, RepositoryError>>;

  /** Every event of an attempt, in client sequence then event id, late ones included. */
  findByAttempt(attemptId: string): Promise<Result<readonly ResponseEvent[], RepositoryError>>;

  /** How many slots have a selected or changed answer among the events that count — the guard on abandoning. */
  answeredSlotCount(attemptId: string): Promise<Result<number, RepositoryError>>;
}

export interface AnchorPoolRepository {
  /** Puts an item version in the pool. One already there — retired or not — is a `CONFLICT`: a version does not come back. */
  add(member: AnchorPoolMember): Promise<Result<AnchorPoolMember, RepositoryError>>;

  /** Retires a member, once. `NOT_FOUND` for a version never in the pool, `CONFLICT` for one already retired. */
  retire(itemVersionId: string, now: string): Promise<Result<AnchorPoolMember, RepositoryError>>;

  /** The members currently in the pool, oldest first. */
  listActive(): Promise<Result<readonly AnchorPoolMember[], RepositoryError>>;
}
