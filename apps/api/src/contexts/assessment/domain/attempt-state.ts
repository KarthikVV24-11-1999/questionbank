/**
 * The server's attempt state machine (ASSESSMENT-ENGINE §5, amended by
 * ADR-0030):
 *
 *   created ──▶ in_progress ──┬──▶ submitted   (manual | expiry | recovered)
 *      │                      └──▶ abandoned   (window closed, no responses)
 *      └───────────────────────────▶ abandoned   (window closed, never started)
 *
 * **This is a second implementation of a rule the client engine also holds.**
 * `packages/attempt-engine` is the device's copy and `apps/api` does not import
 * it, so the two cannot share code; each enumerates its full matrix in its own
 * spec, and the database enforces the same edges by trigger, checked against
 * this table by an integration spec.
 *
 * **`created` can be abandoned (D53, ADR-0030).** The diagram once reached
 * `abandoned` only from `in_progress`, leaving an attempt downloaded and never
 * started with no way to end.
 */
export const ATTEMPT_STATES = ['created', 'in_progress', 'submitted', 'abandoned'] as const;
export type AttemptState = (typeof ATTEMPT_STATES)[number];

export const ATTEMPT_TRIGGERS = ['start', 'submit_manual', 'submit_expiry', 'submit_recovered', 'abandon'] as const;
export type AttemptTrigger = (typeof ATTEMPT_TRIGGERS)[number];

/** `null` is a prohibited transition. */
const TRANSITIONS: Readonly<Record<AttemptState, Readonly<Record<AttemptTrigger, AttemptState | null>>>> = {
  created: {
    start: 'in_progress',
    submit_manual: null,
    submit_expiry: null,
    submit_recovered: null,
    abandon: 'abandoned',
  },
  in_progress: {
    start: null,
    submit_manual: 'submitted',
    submit_expiry: 'submitted',
    submit_recovered: 'submitted',
    abandon: 'abandoned',
  },
  submitted: {
    start: null,
    submit_manual: null,
    submit_expiry: null,
    submit_recovered: null,
    abandon: null,
  },
  abandoned: {
    start: null,
    submit_manual: null,
    submit_expiry: null,
    submit_recovered: null,
    abandon: null,
  },
};

export function transition(state: AttemptState, trigger: AttemptTrigger): AttemptState | null {
  return TRANSITIONS[state][trigger];
}

/** Whether any trigger leads from one state to another — the shape the database trigger checks. */
export function canMove(from: AttemptState, to: AttemptState): boolean {
  return ATTEMPT_TRIGGERS.some((trigger) => TRANSITIONS[from][trigger] === to);
}

/**
 * The states in which an attempt is **active**. A fact about the stored state
 * and nothing else: it takes no time, because a definition that read the clock
 * could not be a unique index, and one active mock per student is only a rule
 * the database can hold if it is (ADR-0030).
 */
export const ACTIVE_STATES = ['created', 'in_progress'] as const satisfies readonly AttemptState[];

export function isActiveState(state: AttemptState): boolean {
  return (ACTIVE_STATES as readonly AttemptState[]).includes(state);
}
