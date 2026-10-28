import type { ResponseEventDraft } from '../../domain/response-event.js';
import type { SubmissionReason } from '../../domain/attempt.js';

/**
 * A student creates an attempt on a form. `idempotencyKey` is theirs: the same key again returns the same
 * attempt. No deadline, duration or window is accepted — those are the server's and are not part of the command.
 */
export interface CreateAttempt {
  readonly formId: string;
  readonly sessionRef: string;
  /** The shift label the attempt is normalized under; defaults to the session when the caller names none. */
  readonly shiftId?: string;
  readonly idempotencyKey: string;
}

export interface StartAttempt {
  readonly attemptId: string;
}

export interface GetAttempt {
  readonly attemptId: string;
}

export interface IngestResponseEvents {
  readonly attemptId: string;
  readonly events: readonly ResponseEventDraft[];
}

export interface GetAttemptResult {
  readonly attemptId: string;
}

export interface SubmitAttempt {
  readonly attemptId: string;
  readonly reason: SubmissionReason;
  readonly idempotencyKey: string;
}

/**
 * A learner starts a practice run (M7-28, M7-29). The strategy and its scope are the learner's, or Learning's for `targeted`; the number of items
 * is bounded. No duration, deadline or window is accepted: a practice run has none, and the delivery document is derived on the server (M7-26).
 */
export interface CreatePracticeAttempt {
  readonly examProfileVersionId: string;
  readonly selectionStrategy: string;
  readonly scopeFilter?: {
    readonly conceptIdentityIds?: readonly string[];
    readonly subject?: string | null;
    readonly itemTypes?: readonly string[];
  };
  readonly difficultyBand?: string | null;
  readonly excludeRecentlySeen?: boolean;
  /** How many items to start with, from 1 to `MAX_PRACTICE_RUN`. */
  readonly count: number;
  readonly idempotencyKey: string;
}

/** More items for a run in progress, chosen under the policy the run was created under. */
export interface GrowPracticeAttempt {
  readonly attemptId: string;
  readonly count: number;
}

/** The solution for one slot of the learner's own attempt, if the effort gate has opened it (M7-36). */
export interface GetSlotSolution {
  readonly attemptId: string;
  readonly slotId: string;
  readonly depth: 'basic' | 'full';
}

/** The immediate feedback for one slot of the learner's own practice run. */
export interface GetPracticeFeedback {
  readonly attemptId: string;
  readonly slotId: string;
}
