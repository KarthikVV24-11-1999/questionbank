/**
 * A form's lifecycle (DOMAIN-MODEL §6, D-006):
 *
 *   draft ──▶ published ──▶ embargoed ──▶ active ──▶ closed
 *
 *  - **draft** — composition may still change (substitution is draft-only).
 *  - **published** — frozen, exposure counted, not yet scheduled. Nothing can
 *    be sat on it.
 *  - **embargoed** — scheduled: it has a window, and its content is sealed
 *    until the window opens.
 *  - **active** — the window has opened; attempts may be created on it.
 *  - **closed** — the window has ended.
 *
 * The edges are the four triggers below and nothing else: a form never goes
 * back, never skips scheduling and never reopens. Both the transition table
 * and the database's trigger are written out in full, and an integration spec
 * holds the two to one answer over every pair.
 *
 * Which state follows `published` was the design's to say and it did not: the
 * order above is the one DOMAIN-MODEL's own list of states gives (draft,
 * published, embargoed, active, closed), with the embargo read as what sits
 * between being scheduled and the window opening.
 */
export const FORM_STATES = ['draft', 'published', 'embargoed', 'active', 'closed'] as const;
export type FormState = (typeof FORM_STATES)[number];

export const FORM_TRIGGERS = ['publish', 'schedule', 'open', 'close'] as const;
export type FormTrigger = (typeof FORM_TRIGGERS)[number];

/** `null` is a prohibited transition. */
const TRANSITIONS: Readonly<Record<FormState, Readonly<Record<FormTrigger, FormState | null>>>> = {
  draft: { publish: 'published', schedule: null, open: null, close: null },
  published: { publish: null, schedule: 'embargoed', open: null, close: null },
  embargoed: { publish: null, schedule: null, open: 'active', close: null },
  active: { publish: null, schedule: null, open: null, close: 'closed' },
  closed: { publish: null, schedule: null, open: null, close: null },
};

export function transition(state: FormState, trigger: FormTrigger): FormState | null {
  return TRANSITIONS[state][trigger];
}

/** Whether any trigger leads from one state to another — the shape the database trigger checks. */
export function canMove(from: FormState, to: FormState): boolean {
  return FORM_TRIGGERS.some((trigger) => TRANSITIONS[from][trigger] === to);
}

/** A form past `draft` is frozen: its composition is immutable, whatever its state. */
export function isFrozen(state: FormState): boolean {
  return state !== 'draft';
}
