import { compareEvents, sameEvent, type ResponseEvent } from './response-event.js';

/**
 * The append-only record of everything a learner did in one attempt. It has
 * no update, no delete and no reorder: the only operations return a new log
 * and leave the old one exactly as it was.
 */
export interface ResponseLog {
  readonly attemptId: string;
  readonly events: readonly ResponseEvent[];
}

export type AppendRefusal =
  | { readonly reason: 'wrong_attempt'; readonly eventId: string }
  | { readonly reason: 'sequence_regression'; readonly eventId: string; readonly lastSequence: number }
  | { readonly reason: 'conflicting_event'; readonly eventId: string };

export type AppendResult =
  | { readonly ok: true; readonly log: ResponseLog }
  | ({ readonly ok: false } & AppendRefusal);

export function emptyLog(attemptId: string): ResponseLog {
  return { attemptId, events: [] };
}

function lastSequence(log: ResponseLog): number {
  const last = log.events.at(-1);
  return last === undefined ? -Infinity : last.sequence;
}

/** The earlier copy of an event id already in the log, if any. */
function existing(log: ResponseLog, eventId: string): ResponseEvent | undefined {
  return log.events.find((candidate) => candidate.eventId === eventId);
}

/**
 * Appends one event. A duplicate `event_id` is silently ignored — the log
 * comes back unchanged — because idempotent replay is the sync protocol's
 * core property (§4) and the log is the place that has to guarantee it.
 * A *different* event under a used id is refused: that is a bug somewhere,
 * not a replay. Anything new must carry a sequence above every one before it.
 */
export function append(log: ResponseLog, event: ResponseEvent): AppendResult {
  if (event.attemptId !== log.attemptId) return { ok: false, reason: 'wrong_attempt', eventId: event.eventId };
  const seen = existing(log, event.eventId);
  if (seen !== undefined) {
    return sameEvent(seen, event)
      ? { ok: true, log }
      : { ok: false, reason: 'conflicting_event', eventId: event.eventId };
  }
  const last = lastSequence(log);
  if (event.sequence <= last) {
    return { ok: false, reason: 'sequence_regression', eventId: event.eventId, lastSequence: last };
  }
  return { ok: true, log: { attemptId: log.attemptId, events: [...log.events, event] } };
}

/**
 * Records an event that arrived after the attempt was submitted. It is kept —
 * the record is preserved — but it was captured on the device before the
 * learner's submission reached the server, so its sequence has no obligation
 * to exceed the log's last one. Only de-duplication and attempt identity apply.
 */
export function recordLate(log: ResponseLog, event: ResponseEvent): AppendResult {
  if (event.attemptId !== log.attemptId) return { ok: false, reason: 'wrong_attempt', eventId: event.eventId };
  const seen = existing(log, event.eventId);
  if (seen !== undefined) {
    return sameEvent(seen, event)
      ? { ok: true, log }
      : { ok: false, reason: 'conflicting_event', eventId: event.eventId };
  }
  return { ok: true, log: { attemptId: log.attemptId, events: [...log.events, event] } };
}

/**
 * Builds a log from events in any order: de-duplicated by `event_id` and put
 * into the canonical order (sequence, then id). The one place order is
 * decided, so two logs holding the same events are always equal.
 */
export function logFromEvents(attemptId: string, events: readonly ResponseEvent[]): AppendResult {
  const byId = new Map<string, ResponseEvent>();
  for (const event of events) {
    if (event.attemptId !== attemptId) return { ok: false, reason: 'wrong_attempt', eventId: event.eventId };
    const seen = byId.get(event.eventId);
    if (seen === undefined) byId.set(event.eventId, event);
    else if (!sameEvent(seen, event)) return { ok: false, reason: 'conflicting_event', eventId: event.eventId };
  }
  return { ok: true, log: { attemptId, events: [...byId.values()].sort(compareEvents) } };
}
