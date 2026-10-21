import { logFromEvents, type AppendRefusal, type ResponseLog } from './response-log.js';

export type MergeResult =
  | { readonly ok: true; readonly log: ResponseLog }
  | { readonly ok: false; readonly reason: 'attempt_mismatch' }
  | ({ readonly ok: false } & AppendRefusal);

/**
 * Merges two logs of one attempt — the device-switch case (REL-06) — as a set
 * union by `event_id`. Never last-writer-wins: two devices produce disjoint
 * event sets, so every event from either side survives, and an event both
 * sides hold appears once. The result is in the canonical order, which makes
 * the operation commutative, associative and idempotent: the order logs
 * arrive in, and how often, cannot change the outcome.
 *
 * An event id that names different content on the two sides is not a replay
 * and is refused rather than resolved by picking a side.
 */
export function mergeLogs(a: ResponseLog, b: ResponseLog): MergeResult {
  if (a.attemptId !== b.attemptId) return { ok: false, reason: 'attempt_mismatch' };
  return logFromEvents(a.attemptId, [...a.events, ...b.events]);
}
