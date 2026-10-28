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
  /**
   * The learner's latest word on the slot is that they gave up on it: set by a `skip`, withdrawn by a later `select` or `change`. A skip never
   * discards a recorded answer — the answer stands until it is cleared — so this can be true beside an answer; the log's order decides, and the
   * log's order is the same wherever the events were captured.
   */
  readonly skipped: boolean;
  /**
   * What was counted (M7-45, DEC-M7-22): every visit → leave interval, each limited to the cap. It is a **lower bound** on the time the learner spent on the slot, and it
   * is exact only when `truncatedIntervals` and `unclosedVisits` are both 0. Read it with them: two slots with the same value can differ in
   * what was thrown away to get it.
   */
  readonly timeOnItemMs: number;
  /** Intervals that ran past the cap and were cut to it. Beside `timeOnItemMs` and from the same pass. */
  readonly truncatedIntervals: number;
  /** Milliseconds those intervals ran beyond the cap, summed. The slot's time was at most `timeOnItemMs + discardedMs`, unless a visit was never closed. */
  readonly discardedMs: number;
  /** Visits that never reached a leave — the app died, or the log ends inside one — whose duration is not known at all. Counted as nothing in `timeOnItemMs`. */
  readonly unclosedVisits: number;
}

export interface Projection {
  /** Every slot the log mentions, ordered by slot id. */
  readonly slots: readonly SlotProjection[];
}

interface SlotState {
  answer: ResponseAnswer | null;
  answerChanges: number;
  flagged: boolean;
  skipped: boolean;
  timeOnItemMs: number;
  truncatedIntervals: number;
  discardedMs: number;
  unclosedVisits: number;
  openVisitAtMs: number | null;
}

function newSlotState(): SlotState {
  return { answer: null, answerChanges: 0, flagged: false, skipped: false, timeOnItemMs: 0, truncatedIntervals: 0, discardedMs: 0, unclosedVisits: 0, openVisitAtMs: null };
}

function apply(state: SlotState, event: ResponseEvent, intervalCapMs: number): void {
  switch (event.kind) {
    case 'select':
      state.answer = event.answer;
      state.skipped = false;
      return;
    case 'change':
      state.answer = event.answer;
      state.answerChanges += 1;
      state.skipped = false;
      return;
    case 'skip':
      state.skipped = true;
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
      // counts as nothing and the new visit starts fresh — but the loss is recorded, since "nothing" here means "not known".
      if (state.openVisitAtMs !== null) state.unclosedVisits += 1;
      state.openVisitAtMs = event.monotonicMs;
      return;
    case 'leave': {
      // A leave with no visit has no start to measure from: ignored.
      if (state.openVisitAtMs === null) return;
      const interval = event.monotonicMs - state.openVisitAtMs;
      const counted = Math.min(Math.max(interval, 0), intervalCapMs);
      state.timeOnItemMs += counted;
      if (interval > intervalCapMs) {
        state.truncatedIntervals += 1;
        state.discardedMs += interval - intervalCapMs;
      }
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
      skipped: state.skipped,
      timeOnItemMs: state.timeOnItemMs,
      truncatedIntervals: state.truncatedIntervals,
      discardedMs: state.discardedMs,
      // a visit still open when the log ends is as lost as one a later visit overwrote
      unclosedVisits: state.unclosedVisits + (state.openVisitAtMs === null ? 0 : 1),
    };
  });
  return { slots };
}
