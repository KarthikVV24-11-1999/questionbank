import type { AssessmentError } from './assessment-error.js';
import type { Attempt } from './attempt.js';
import type { AttemptState } from './attempt-state.js';
import type { Form } from './form.js';
import type { ResponseEvent } from './response-event.js';
import type { Result } from './result.js';

/**
 * What the application layer needs from persistence, declared by the domain so
 * the dependency points inward. Infrastructure implements these; nothing here
 * knows how anything is stored.
 */
export type RepositoryError = AssessmentError<'CONFLICT' | 'NOT_FOUND' | 'PERSISTENCE_REJECTED'>;

export interface FormRepository {
  /**
   * Writes a form. A new form is inserted; a draft already stored has its
   * composition replaced; a draft that arrives published is published. A form
   * already stored as published is never changed — saving the identical form is
   * a no-op and saving a different one is a `CONFLICT` (D-006).
   */
  save(form: Form): Promise<Result<Form, RepositoryError>>;

  findById(formId: string): Promise<Result<Form, RepositoryError>>;
}

export interface AttemptRepository {
  /**
   * Writes a new attempt and pins its slots, in one transaction. A student who
   * already has an active mock gets a `CONFLICT` from the database's unique
   * index, whoever raced whom; an attempt against a draft form is
   * `PERSISTENCE_REJECTED`.
   */
  create(attempt: Attempt): Promise<Result<Attempt, RepositoryError>>;

  /**
   * Records a move along the state machine. `expected` is the state the caller
   * read the attempt in: if another writer moved it since, nothing is written
   * and the answer is a `CONFLICT`, never a silent overwrite.
   */
  save(attempt: Attempt, expected: AttemptState): Promise<Result<Attempt, RepositoryError>>;

  findById(attemptId: string): Promise<Result<Attempt, RepositoryError>>;

  /** The student's active mock attempt — `created` or `in_progress` — if they have one. */
  findActiveMock(studentId: string): Promise<Result<Attempt | undefined, RepositoryError>>;
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
