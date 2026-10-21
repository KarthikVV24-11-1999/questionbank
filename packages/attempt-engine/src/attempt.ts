import { transition, type AttemptState, type AttemptTrigger } from './attempt-state.js';
import { projectResponses, type Projection, type ProjectionOptions } from './projection.js';
import type { ResponseEvent } from './response-event.js';
import { append, emptyLog, recordLate, type AppendRefusal, type ResponseLog } from './response-log.js';

export type SubmissionReason = 'manual' | 'expiry' | 'recovered';

export interface Submission {
  readonly reason: SubmissionReason;
  /** Retrying a submission with the same key cannot create a second one. */
  readonly idempotencyKey: string;
  /**
   * The events that existed when the attempt was submitted — the ones scoring
   * may see. Anything that reaches the log later is kept and excluded.
   */
  readonly scoredEventIds: ReadonlySet<string>;
}

export interface Attempt {
  readonly attemptId: string;
  readonly state: AttemptState;
  readonly log: ResponseLog;
  readonly submission: Submission | null;
}

export type AttemptRefusal =
  | { readonly reason: 'transition_prohibited'; readonly from: AttemptState; readonly trigger: AttemptTrigger }
  | { readonly reason: 'capture_prohibited'; readonly state: AttemptState }
  | { readonly reason: 'ingest_prohibited'; readonly state: AttemptState }
  | { readonly reason: 'already_submitted_under_another_key' }
  | { readonly reason: 'has_responses' }
  | AppendRefusal;

export type AttemptResult =
  | { readonly ok: true; readonly attempt: Attempt }
  | ({ readonly ok: false } & AttemptRefusal);

const REASON_TRIGGER: Readonly<Record<SubmissionReason, AttemptTrigger>> = {
  manual: 'submit_manual',
  expiry: 'submit_expiry',
  recovered: 'submit_recovered',
};

export function createAttempt(attemptId: string): Attempt {
  return { attemptId, state: 'created', log: emptyLog(attemptId), submission: null };
}

function moved(attempt: Attempt, trigger: AttemptTrigger, changes: Partial<Attempt> = {}): AttemptResult {
  const next = transition(attempt.state, trigger);
  if (next === null) return { ok: false, reason: 'transition_prohibited', from: attempt.state, trigger };
  return { ok: true, attempt: { ...attempt, ...changes, state: next } };
}

export function startAttempt(attempt: Attempt): AttemptResult {
  return moved(attempt, 'start');
}

/**
 * The device capturing a response. Only an in-progress attempt takes one:
 * not before it starts and not after it is submitted.
 */
export function captureResponse(attempt: Attempt, event: ResponseEvent): AttemptResult {
  if (attempt.state !== 'in_progress') return { ok: false, reason: 'capture_prohibited', state: attempt.state };
  const result = append(attempt.log, event);
  return result.ok ? { ok: true, attempt: { ...attempt, log: result.log } } : result;
}

/**
 * The server receiving an event the device captured earlier. While in
 * progress it is appended like any other. After submission it is **recorded
 * but excluded from scoring**: the log keeps it, `scoredEventIds` does not
 * name it, so projection drops it. Before the attempt starts and once it is
 * abandoned there is nothing for it to belong to, and it is refused.
 */
export function ingestEvent(attempt: Attempt, event: ResponseEvent): AttemptResult {
  if (attempt.state === 'in_progress') return captureResponse(attempt, event);
  if (attempt.state !== 'submitted') return { ok: false, reason: 'ingest_prohibited', state: attempt.state };
  const result = recordLate(attempt.log, event);
  return result.ok ? { ok: true, attempt: { ...attempt, log: result.log } } : result;
}

/**
 * Submits the attempt. Idempotent on the key: the same key again returns the
 * attempt unchanged; a different key on an already-submitted attempt is refused.
 */
export function submitAttempt(
  attempt: Attempt,
  request: { readonly reason: SubmissionReason; readonly idempotencyKey: string },
): AttemptResult {
  if (attempt.submission !== null) {
    return attempt.submission.idempotencyKey === request.idempotencyKey
      ? { ok: true, attempt }
      : { ok: false, reason: 'already_submitted_under_another_key' };
  }
  const submission: Submission = {
    reason: request.reason,
    idempotencyKey: request.idempotencyKey,
    scoredEventIds: new Set(attempt.log.events.map((event) => event.eventId)),
  };
  return moved(attempt, REASON_TRIGGER[request.reason], { submission });
}

/** Whether the learner answered anything — a visit or a flag alone is not a response. */
function hasResponses(log: ResponseLog): boolean {
  return log.events.some((event) => event.kind === 'select' || event.kind === 'change');
}

/** Closes an in-progress attempt nobody answered anything in. One with responses must be submitted. */
export function abandonAttempt(attempt: Attempt): AttemptResult {
  if (attempt.state === 'in_progress' && hasResponses(attempt.log)) return { ok: false, reason: 'has_responses' };
  return moved(attempt, 'abandon');
}

/** What scoring sees: the projection over the events that existed at submission. */
export function projectAttempt(attempt: Attempt, options: Omit<ProjectionOptions, 'includeEventIds'>): Projection {
  return projectResponses(
    attempt.log.events,
    attempt.submission === null ? options : { ...options, includeEventIds: attempt.submission.scoredEventIds },
  );
}
