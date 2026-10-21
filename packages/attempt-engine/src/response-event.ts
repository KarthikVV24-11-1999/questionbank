/**
 * The closed vocabulary of things a learner can do to a question slot
 * (ASSESSMENT-ENGINE §4). An eighth kind is a compile error everywhere the
 * kinds are switched over, because every such switch is exhaustive.
 */
export const RESPONSE_EVENT_KINDS = ['select', 'change', 'clear', 'visit', 'leave', 'flag', 'unflag'] as const;

export type ResponseEventKind = (typeof RESPONSE_EVENT_KINDS)[number];

/** What the learner chose: one option, a number, or several options. */
export type ResponseAnswer = string | number | readonly (string | number)[];

interface EventBase {
  /** Globally unique and stable across retries — the idempotency key of replay. */
  readonly eventId: string;
  readonly attemptId: string;
  /** The question slot within the form the event is about. */
  readonly slot: string;
  /** Client-assigned, monotonic per attempt. */
  readonly sequence: number;
  /**
   * The client's monotonic reading when the event happened, in milliseconds.
   * Never a wall-clock time: only differences between two readings mean anything.
   */
  readonly monotonicMs: number;
}

export interface SelectEvent extends EventBase {
  readonly kind: 'select';
  readonly answer: ResponseAnswer;
}

export interface ChangeEvent extends EventBase {
  readonly kind: 'change';
  readonly answer: ResponseAnswer;
}

export interface ClearEvent extends EventBase {
  readonly kind: 'clear';
}

export interface VisitEvent extends EventBase {
  readonly kind: 'visit';
}

export interface LeaveEvent extends EventBase {
  readonly kind: 'leave';
}

export interface FlagEvent extends EventBase {
  readonly kind: 'flag';
}

export interface UnflagEvent extends EventBase {
  readonly kind: 'unflag';
}

export type ResponseEvent =
  | SelectEvent
  | ChangeEvent
  | ClearEvent
  | VisitEvent
  | LeaveEvent
  | FlagEvent
  | UnflagEvent;

/** Total order every consumer uses: client sequence, then event id as the tie-break. */
export function compareEvents(a: ResponseEvent, b: ResponseEvent): number {
  if (a.sequence !== b.sequence) return a.sequence - b.sequence;
  if (a.eventId < b.eventId) return -1;
  return a.eventId > b.eventId ? 1 : 0;
}

/** Structural equality, so a replayed event can be told from a conflicting one. */
export function sameEvent(a: ResponseEvent, b: ResponseEvent): boolean {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]),
    );
  }
  return value;
}
