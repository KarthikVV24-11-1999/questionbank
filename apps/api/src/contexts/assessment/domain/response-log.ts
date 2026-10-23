import {
  logFromEvents,
  mergeLogs,
  projectResponses,
  type Projection,
  type ResponseEvent as EngineEvent,
  type ResponseLog as EngineLog,
} from '@questionbank/attempt-engine';
import { conflictError, type AssessmentError } from './assessment-error.js';
import type { Attempt } from './attempt.js';
import type { ResponseEvent } from './response-event.js';
import { err, ok, type Result } from './result.js';

/**
 * The server's side of REL-06 — set union by `event_id` — **is the attempt engine's**
 * (ADR-0035). Nothing in this module, or anywhere in this context, unions, de-duplicates or
 * compares events by id: it hands the engine's `mergeLogs` the two sets and reads the answer.
 * A second implementation of the one rule that guarantees nothing is lost would be the worst
 * place in the system to have one, so a spec asserts there is not one.
 *
 * The server's event carries what the device's does not (the pinned item version, the time the
 * server heard, whether it counted); the engine's event is what both sides agree on. This module
 * is the mapping between the two, and the engine decides everything about identity and order.
 */
export type ResponseLogErrorCode = 'EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT';
/** Names the event whose id was reused, so a caller can refuse that one and keep the rest. */
export type ResponseLogError = AssessmentError<ResponseLogErrorCode> & { readonly eventId: string };

function reused(eventId: string, message: string): ResponseLogError {
  return { ...conflictError('EVENT_ID_REUSED_WITH_DIFFERENT_CONTENT', message, 'eventId'), eventId };
}

/** What the engine knows of an event: the device's account of it. */
export function toEngineEvent(event: ResponseEvent): EngineEvent {
  const base = {
    eventId: event.eventId,
    attemptId: event.attemptId,
    slot: event.slotId,
    sequence: event.sequence,
    monotonicMs: event.clientMonotonicMs,
  };
  switch (event.kind) {
    case 'select':
    case 'change':
      // `acceptResponseEvent` guarantees an answer for these two kinds; the engine's type needs it said.
      return { ...base, kind: event.kind, answer: event.answer as NonNullable<ResponseEvent['answer']> };
    case 'clear':
    case 'visit':
    case 'leave':
    case 'flag':
    case 'unflag':
      return { ...base, kind: event.kind };
  }
}

function engineLog(attemptId: string, events: readonly ResponseEvent[]): Result<EngineLog, ResponseLogError> {
  const built = logFromEvents(attemptId, events.map(toEngineEvent));
  if (built.ok) return ok(built.log);
  return err(
    reused(
      built.eventId,
      built.reason === 'wrong_attempt'
        ? `event ${built.eventId} belongs to another attempt`
        : `event ${built.eventId} was sent twice with different content`,
    ),
  );
}

export interface IngestMerge {
  /** Events the log did not hold, in the order they arrived (the first copy of each id). */
  readonly fresh: readonly ResponseEvent[];
  /** Ids of incoming events the log already held, with the same content. */
  readonly replayedIds: ReadonlySet<string>;
  /** Every event id of the union, in the canonical order. */
  readonly unionIds: readonly string[];
}

/**
 * The union of what is stored and what arrived, by the engine's rule. A same-id event with
 * different content on the two sides is refused, naming it, and resolved by neither.
 */
export function mergeIncoming(attemptId: string, stored: readonly ResponseEvent[], incoming: readonly ResponseEvent[]): Result<IngestMerge, ResponseLogError> {
  const storedLog = engineLog(attemptId, stored);
  if (!storedLog.ok) return storedLog;
  const incomingLog = engineLog(attemptId, incoming);
  if (!incomingLog.ok) return incomingLog;

  const merged = mergeLogs(storedLog.value, incomingLog.value);
  if (!merged.ok) {
    // Both logs were built for `attemptId` above, so the engine can refuse the union only over an event id.
    const { eventId } = merged as { readonly eventId: string };
    return err(reused(eventId, `event ${eventId} was already recorded with different content`));
  }

  const storedIds = new Set(storedLog.value.events.map((event) => event.eventId));
  const seen = new Set<string>();
  const fresh: ResponseEvent[] = [];
  const replayedIds = new Set<string>();
  for (const event of incoming) {
    if (storedIds.has(event.eventId)) replayedIds.add(event.eventId);
    else if (!seen.has(event.eventId)) {
      seen.add(event.eventId);
      fresh.push(event);
    }
  }
  return ok(Object.freeze({ fresh: Object.freeze(fresh), replayedIds, unionIds: Object.freeze(merged.log.events.map((event) => event.eventId)) }));
}

/**
 * What a log says the learner did, derived by the engine's projection over the events that counted — those that reached
 * the server before submission (§4). Scoring and analytics read this, not the events, so what a device projects locally
 * and what the server derives cannot differ.
 *
 * **The cap is the attempt's own**, pinned when it was created and told to the device (M6-37): the server cannot choose
 * one here, because it is not a parameter.
 */
export function projectLog(attempt: Pick<Attempt, 'attemptId' | 'intervalCapMs'>, events: readonly ResponseEvent[]): Projection {
  const counted = events.filter((event) => !event.afterSubmission);
  const log = engineLog(attempt.attemptId, counted);
  // Stored events were each accepted once under the same rule, so a stored log cannot conflict with itself.
  return projectResponses(log.ok ? log.value.events : [], { intervalCapMs: attempt.intervalCapMs });
}
