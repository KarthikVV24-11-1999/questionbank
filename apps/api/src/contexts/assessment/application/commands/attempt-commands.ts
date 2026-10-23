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
