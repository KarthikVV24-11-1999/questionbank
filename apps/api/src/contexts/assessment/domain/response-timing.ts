import { compareEvents } from '@questionbank/attempt-engine';
import type { Attempt } from './attempt.js';
import { toEngineEvent, projectLog } from './response-log.js';
import type { ResponseEvent } from './response-event.js';

/**
 * When the learner responded, per slot — the instant mastery is measured on (M7-11).
 *
 * A response has an instant: the server stamped each event when it arrived (`serverReceivedAt`), and the answer that **stands** at submission is the
 * one the last answer-affecting event left. That event's instant is the slot's. It is not the instant the attempt was scored, which is one value
 * for every slot of an attempt: measuring a study sitting or a forty-eight-hour gap on it would compute a number from data in which only one value
 * is possible.
 *
 * **The events that count are the ones the engine's projection counts**: those that reached the server before submission. A late event is recorded
 * and excluded from scoring (§4, ADR-0036), and it is not evidence either — the response that stands is the one the learner gave in time.
 *
 * **Which event stands** is the last, in the engine's canonical order, of `select`, `change` and `clear` — the three kinds the projection lets set an
 * answer. A slot whose last such event is a `clear`, or that has none, has no response standing and reports `null`. Those kinds are named here, so
 * `response-timing.spec.ts` holds this to the projection over generated logs: where the two disagree, this fails and not a learner's state.
 *
 * Instants, durations and identifiers only: no answer, no event payload and no `kind` leaves this function.
 */
export interface SlotResponseTiming {
  readonly slotId: string;
  readonly itemVersionId: string;
  /** The server's instant for the response that stands; `null` when no response stands. */
  readonly respondedAt: string | null;
  /**
   * The server's instant for the learner giving up on the slot (M7-38): the last `skip` that no later `select` or `change` withdrew, on a slot with no response
   * standing. `null` otherwise, and always `null` where a response stands — an answer given and then skipped is still an answer. The projection states the same
   * thing as `skipped` with no answer; `response-timing.spec.ts` holds the two to each other over generated logs.
   */
  readonly gaveUpAt: string | null;
  /** The slot's cumulative time on item under the attempt's own interval cap. */
  readonly timeOnItemMs: number;
}

const ANSWER_AFFECTING = ['select', 'change', 'clear'] as const;

export function responseTimings(
  attempt: Pick<Attempt, 'attemptId' | 'intervalCapMs' | 'slots'>,
  events: readonly ResponseEvent[],
): readonly SlotResponseTiming[] {
  const counted = events.filter((event) => !event.afterSubmission);
  const ordered = [...counted].sort((a, b) => compareEvents(toEngineEvent(a), toEngineEvent(b)));

  const standing = new Map<string, ResponseEvent>();
  for (const event of ordered) {
    if ((ANSWER_AFFECTING as readonly string[]).includes(event.kind)) standing.set(event.slotId, event);
  }

  const skipped = new Map<string, ResponseEvent>();
  for (const event of ordered) {
    if (event.kind === 'skip') skipped.set(event.slotId, event);
    else if (event.kind === 'select' || event.kind === 'change') skipped.delete(event.slotId);
  }

  const time = new Map(projectLog(attempt, events).slots.map((slot) => [slot.slot, slot.timeOnItemMs]));

  return Object.freeze(
    [...attempt.slots]
      .sort((a, b) => a.ordinal - b.ordinal)
      .map((slot) => {
        const last = standing.get(slot.slotId);
        const responded = last === undefined || last.kind === 'clear' ? null : last.serverReceivedAt;
        return Object.freeze({
          slotId: slot.slotId,
          itemVersionId: slot.itemVersionId,
          respondedAt: responded,
          gaveUpAt: responded === null ? (skipped.get(slot.slotId)?.serverReceivedAt ?? null) : null,
          timeOnItemMs: time.get(slot.slotId) ?? 0,
        });
      }),
  );
}
