import type { Attempt } from './attempt.js';
import { ruleViolationError, validationError, type AssessmentError } from './assessment-error.js';
import { err, ok, type Result } from './result.js';
import { isNonBlank, isNonNegativeInteger, isUtcTimestamp, isUuid } from './uuid.js';

/**
 * `ResponseEvent` — one thing a learner did to one slot, as the server keeps it.
 *
 * This is the server's copy of what the device's engine captured, and unlike
 * the device's it carries **authority**: it is the append-only record scoring
 * and analytics are derived from. The vocabulary is the same closed seven; the
 * two lists are separate implementations, and an integration spec holds this
 * one to the database's check constraint.
 *
 * ASSESSMENT-ENGINE §12 makes four things about a response non-negotiable, and
 * each is a field that cannot be null:
 *
 *  - **the item version, pinned per response** — copied here from the
 *    attempt's slot, never taken from the device and never resolved at read
 *    time, so statistics cannot silently mix versions of an item;
 *  - **per-item timing** — `clientMonotonicMs`, the device's monotonic
 *    reading, which the visit/leave intervals are differences of;
 *  - **the full answer-change sequence** — every `change` is its own event, so
 *    nothing here collapses a run of edits into the last one;
 *  - **when the server heard** — `serverReceivedAt`, which orders events
 *    across slots (§4).
 *
 * The ability estimate per step in §12 belongs to practice attempts (H1) and
 * has nothing to attach to in a mock; it is out of scope here.
 */
export const RESPONSE_EVENT_KINDS = ['select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag'] as const;
export type ResponseEventKind = (typeof RESPONSE_EVENT_KINDS)[number];

const ANSWER_BEARING: readonly ResponseEventKind[] = ['select', 'change'];

export type ResponseAnswer = string | number | readonly (string | number)[];

export interface ResponseEvent {
  readonly eventId: string;
  readonly attemptId: string;
  readonly slotId: string;
  readonly itemVersionId: string;
  readonly sequence: number;
  readonly kind: ResponseEventKind;
  /** Present for `select` and `change`, `null` for every other kind. */
  readonly answer: ResponseAnswer | null;
  readonly clientMonotonicMs: number;
  readonly serverReceivedAt: string;
  readonly deviceRef: string;
  /**
   * True when the event reached the server after the attempt was submitted.
   * Such an event is recorded and excluded from scoring (§4): preserve the
   * record, protect the result.
   */
  readonly afterSubmission: boolean;
}

/** What the device sends. It does not say which item version, and could not be believed if it did. */
export interface ResponseEventDraft {
  readonly eventId: string;
  readonly attemptId: string;
  readonly slotId: string;
  readonly sequence: number;
  readonly kind: ResponseEventKind;
  readonly answer?: ResponseAnswer | null;
  readonly clientMonotonicMs: number;
  readonly deviceRef: string;
}

export type ResponseEventErrorCode =
  | 'EVENT_ID_INVALID'
  | 'EVENT_ATTEMPT_MISMATCH'
  | 'EVENT_SLOT_NOT_IN_ATTEMPT'
  | 'EVENT_SEQUENCE_INVALID'
  | 'EVENT_KIND_INVALID'
  | 'EVENT_ANSWER_INVALID'
  | 'EVENT_TIMING_INVALID'
  | 'EVENT_DEVICE_INVALID'
  | 'EVENT_RECEIVED_AT_INVALID'
  | 'ATTEMPT_NOT_ACCEPTING_RESPONSES';

export type ResponseEventError = AssessmentError<ResponseEventErrorCode>;

function isAnswerValue(value: unknown): value is string | number {
  return (typeof value === 'string' && value.length > 0) || (typeof value === 'number' && Number.isFinite(value));
}

function isAnswer(value: unknown): value is ResponseAnswer {
  return Array.isArray(value) ? value.length > 0 && value.every(isAnswerValue) : isAnswerValue(value);
}

function invalid(code: ResponseEventErrorCode, message: string, location: string): ResponseEventError {
  return validationError(code, message, location);
}

/**
 * Receives one event for an attempt. The attempt decides whether it is heard
 * at all and whether it will count:
 *
 *  - `in_progress` — recorded, counts;
 *  - `submitted` — recorded, `afterSubmission`, excluded from scoring;
 *  - `created` and `abandoned` — refused, there is nothing for it to belong to.
 */
export function acceptResponseEvent(
  attempt: Attempt,
  draft: ResponseEventDraft,
  serverReceivedAt: string,
): Result<ResponseEvent, ResponseEventError> {
  if (attempt.state !== 'in_progress' && attempt.state !== 'submitted') {
    return err(ruleViolationError('ATTEMPT_NOT_ACCEPTING_RESPONSES', `a ${attempt.state} attempt takes no responses`, 'state'));
  }
  if (!isUuid(draft.eventId)) return err(invalid('EVENT_ID_INVALID', 'eventId must be a uuid', 'eventId'));
  if (draft.attemptId !== attempt.attemptId) {
    return err(invalid('EVENT_ATTEMPT_MISMATCH', 'the event belongs to another attempt', 'attemptId'));
  }
  const slot = attempt.slots.find((candidate) => candidate.slotId === draft.slotId);
  if (slot === undefined) return err(invalid('EVENT_SLOT_NOT_IN_ATTEMPT', 'the attempt has no such slot', 'slotId'));
  if (!isNonNegativeInteger(draft.sequence)) {
    return err(invalid('EVENT_SEQUENCE_INVALID', 'sequence must be a non-negative whole number', 'sequence'));
  }
  if (!(RESPONSE_EVENT_KINDS as readonly string[]).includes(draft.kind)) {
    return err(invalid('EVENT_KIND_INVALID', `kind is one of ${RESPONSE_EVENT_KINDS.join(', ')}`, 'kind'));
  }
  const bearsAnswer = ANSWER_BEARING.includes(draft.kind);
  const answer = draft.answer ?? null;
  if (bearsAnswer ? !isAnswer(answer) : answer !== null) {
    return err(
      invalid('EVENT_ANSWER_INVALID', bearsAnswer ? `${draft.kind} carries an answer` : `${draft.kind} carries no answer`, 'answer'),
    );
  }
  if (!isNonNegativeInteger(draft.clientMonotonicMs)) {
    return err(invalid('EVENT_TIMING_INVALID', 'every event records the device\'s monotonic reading', 'clientMonotonicMs'));
  }
  if (!isNonBlank(draft.deviceRef)) return err(invalid('EVENT_DEVICE_INVALID', 'every event names its device', 'deviceRef'));
  if (!isUtcTimestamp(serverReceivedAt)) {
    return err(invalid('EVENT_RECEIVED_AT_INVALID', 'serverReceivedAt must be a UTC timestamp with milliseconds', 'serverReceivedAt'));
  }

  return ok(
    Object.freeze({
      eventId: draft.eventId,
      attemptId: attempt.attemptId,
      slotId: slot.slotId,
      itemVersionId: slot.itemVersionId,
      sequence: draft.sequence,
      kind: draft.kind,
      answer: answer === null ? null : (Array.isArray(answer) ? Object.freeze([...answer]) : answer),
      clientMonotonicMs: draft.clientMonotonicMs,
      serverReceivedAt,
      deviceRef: draft.deviceRef,
      afterSubmission: attempt.state === 'submitted',
    }),
  );
}

/** What scoring may see: everything that reached the server in time. */
export function scoredEvents(events: readonly ResponseEvent[]): readonly ResponseEvent[] {
  return events.filter((event) => !event.afterSubmission);
}
