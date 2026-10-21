import { compareEvents, type ResponseAnswer, type ResponseEvent } from './response-event.js';

export interface ProjectionOptions {
  /**
   * The longest a single visit → leave interval may count towards time on
   * item, in milliseconds. A learner who backgrounds the app mid-question
   * produces a long interval that was not spent on the item; the cap
   * discards the excess. The value is a policy still to be settled
   * (ASSESSMENT-ENGINE §14, unresolved 5), so it is a parameter, never a
   * constant here.
   */
  readonly intervalCapMs: number;
  /**
   * When given, only these events are projected. This is how events that
   * arrived after submission stay in the log yet stay out of the result.
   */
  readonly includeEventIds?: ReadonlySet<string>;
}

export interface SlotProjection {
  readonly slot: string;
  /** `null` when nothing was ever chosen, or the last choice was cleared. */
  readonly answer: ResponseAnswer | null;
  readonly answerChanges: number;
  readonly flagged: boolean;
  readonly timeOnItemMs: number;
}

export interface Projection {
  /** Every slot the log mentions, ordered by slot id. */
  readonly slots: readonly SlotProjection[];
}

interface SlotState {
  answer: ResponseAnswer | null;
  answerChanges: number;
  flagged: boolean;
  timeOnItemMs: number;
  openVisitAtMs: number | null;
}

function newSlotState(): SlotState {
  return { answer: null, answerChanges: 0, flagged: false, timeOnItemMs: 0, openVisitAtMs: null };
}

function apply(state: SlotState, event: ResponseEvent, intervalCapMs: number): void {
  switch (event.kind) {
    case 'select':
      state.answer = event.answer;
      return;
    case 'change':
      state.answer = event.answer;
      state.answerChanges += 1;
      return;
    case 'clear':
      state.answer = null;
      return;
    case 'flag':
      state.flagged = true;
      return;
    case 'unflag':
      state.flagged = false;
      return;
    case 'visit':
      // A second visit with no leave between means the first was never
      // closed — the app died or was killed. Its time is unknown, so it
      // counts as nothing and the new visit starts fresh.
      state.openVisitAtMs = event.monotonicMs;
      return;
    case 'leave': {
      // A leave with no visit has no start to measure from: ignored.
      if (state.openVisitAtMs === null) return;
      const interval = event.monotonicMs - state.openVisitAtMs;
      state.timeOnItemMs += Math.min(Math.max(interval, 0), intervalCapMs);
      state.openVisitAtMs = null;
      return;
    }
  }
}

/**
 * Derives the answers from the log (ASSESSMENT-ENGINE §4). The log is
 * authoritative; this is a pure function of it. Input order does not matter:
 * events are de-duplicated by id and put into the one canonical order
 * (client sequence, then id) before anything is derived, so the same set of
 * events always yields the same projection — scoring inherits its
 * determinism from here.
 */
export function projectResponses(events: readonly ResponseEvent[], options: ProjectionOptions): Projection {
  const unique = new Map<string, ResponseEvent>();
  for (const event of events) {
    if (options.includeEventIds !== undefined && !options.includeEventIds.has(event.eventId)) continue;
    if (!unique.has(event.eventId)) unique.set(event.eventId, event);
  }
  const ordered = [...unique.values()].sort(compareEvents);

  const states = new Map<string, SlotState>();
  for (const event of ordered) {
    let state = states.get(event.slot);
    if (state === undefined) {
      state = newSlotState();
      states.set(event.slot, state);
    }
    apply(state, event, options.intervalCapMs);
  }

  const slots = [...states.keys()].sort().map((slot) => {
    const state = states.get(slot) as SlotState;
    return {
      slot,
      answer: state.answer,
      answerChanges: state.answerChanges,
      flagged: state.flagged,
      timeOnItemMs: state.timeOnItemMs,
    };
  });
  return { slots };
}
