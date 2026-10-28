import type { MasteryEvidence } from './mastery-evidence.js';
import { err, ok, type Result } from './result.js';
import type { LearningError } from './mastery-evidence.js';

/**
 * `ErrorEntry` — a line in the learner's error notebook (M7-38, DOMAIN-MODEL 12).
 *
 * **Made for every response that was wrong, and for every question the learner gave up on.** A give-up is not a wrong response and is not evidence — D-002 counts
 * responses, and a learner who gives up has said they do not know, not what they got wrong — so it is an entry of its own kind with its own cause and moves no mastery
 * state (DEC-M7-16). A wrong response is evidence and an entry both.
 *
 * **Cleared by one thing: a verified mastery transition for the concept** (`resolvedByTransitionId`), never by a correct re-attempt and never by time. The rule is
 * the table's (`learning.guard_error_entry`), stated once and in SQL, because it is a condition over a transition's stored facts; this module holds no second copy of it.
 *
 * **The cause is the learner's** for a wrong response — one of five — and the system's for a give-up. Entries are retained for the life of the account.
 */
export const LEARNER_ERROR_CAUSES = ['conceptual', 'calculation', 'misread', 'time', 'guess'] as const;
export type LearnerErrorCause = (typeof LEARNER_ERROR_CAUSES)[number];
export const GAVE_UP_CAUSE = 'gave_up';
export type ErrorCause = LearnerErrorCause | typeof GAVE_UP_CAUSE;
export type ErrorEntryKind = 'incorrect' | 'gave_up';

export interface ErrorEntry {
  readonly errorEntryId: string;
  readonly learnerRef: string;
  readonly attemptRef: string;
  readonly slotRef: string;
  readonly itemVersionRef: string;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly kind: ErrorEntryKind;
  readonly errorCause: ErrorCause | null;
  /** The instant of the response, or of the give-up. */
  readonly occurredAt: string;
  readonly resolvedByTransitionId: string | null;
}

/** A question the learner gave up on, as Learning is told of it: identifiers and an instant, no answer and no outcome. */
export interface GaveUpSlot {
  readonly attemptRef: string;
  readonly slotRef: string;
  readonly itemVersionRef: string;
  readonly conceptIdentityId: string;
  readonly taxonomyVersionId: string;
  readonly occurredAt: string;
}

/** The entry a wrong response makes, or `null` for a response that was right. */
export function errorEntryFromEvidence(learnerRef: string, errorEntryId: string, evidence: MasteryEvidence): ErrorEntry | null {
  if (evidence.outcome !== 'incorrect') return null;
  return Object.freeze({
    errorEntryId,
    learnerRef,
    attemptRef: evidence.attemptRef,
    slotRef: evidence.slotRef,
    itemVersionRef: evidence.itemVersionRef,
    conceptIdentityId: evidence.conceptIdentityId,
    taxonomyVersionId: evidence.taxonomyVersionId,
    kind: 'incorrect' as const,
    errorCause: null,
    occurredAt: evidence.occurredAt,
    resolvedByTransitionId: null,
  });
}

export function errorEntryFromGaveUp(learnerRef: string, errorEntryId: string, gaveUp: GaveUpSlot): ErrorEntry {
  return Object.freeze({
    errorEntryId,
    learnerRef,
    attemptRef: gaveUp.attemptRef,
    slotRef: gaveUp.slotRef,
    itemVersionRef: gaveUp.itemVersionRef,
    conceptIdentityId: gaveUp.conceptIdentityId,
    taxonomyVersionId: gaveUp.taxonomyVersionId,
    kind: 'gave_up' as const,
    errorCause: GAVE_UP_CAUSE,
    occurredAt: gaveUp.occurredAt,
    resolvedByTransitionId: null,
  });
}

export type ErrorCauseErrorCode = 'ERROR_CAUSE_INVALID' | 'ERROR_CAUSE_NOT_THE_LEARNERS';

/** Whether a learner may give this cause: one of the five, and never for a give-up, whose cause is the system's. */
export function chooseErrorCause(kind: ErrorEntryKind, cause: unknown): Result<LearnerErrorCause, LearningError<ErrorCauseErrorCode>> {
  if (kind === 'gave_up') return err(Object.freeze({ kind: 'Validation', code: 'ERROR_CAUSE_NOT_THE_LEARNERS', message: 'a question you gave up on keeps that cause' }));
  if (!(LEARNER_ERROR_CAUSES as readonly unknown[]).includes(cause)) {
    return err(Object.freeze({ kind: 'Validation', code: 'ERROR_CAUSE_INVALID', message: `a cause is one of ${LEARNER_ERROR_CAUSES.join(', ')}` }));
  }
  return ok(cause as LearnerErrorCause);
}
