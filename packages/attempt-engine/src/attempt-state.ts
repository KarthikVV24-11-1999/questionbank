/**
 * The attempt state machine (ASSESSMENT-ENGINE §5):
 *
 *   created ──▶ in_progress ──┬──▶ submitted   (manual | expiry | recovered)
 *                             └──▶ abandoned   (window closed, no responses)
 *
 * The transition table and the permission table are both written out in
 * full, one entry per pair, and typed so that a missing pair is a compile
 * error. The spec enumerates every pair again rather than sampling.
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
    abandon: null,
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

export const ATTEMPT_ACTIONS = [
  'download_package',
  'preflight',
  'capture_response',
  'navigate',
  'sync',
  'submit',
  'score',
  'review',
  'rescore',
  'mutate_form',
  'access_keys',
] as const;
export type AttemptAction = (typeof ATTEMPT_ACTIONS)[number];

/** What each state permits; everything not listed is prohibited. */
const PERMITTED: Readonly<Record<AttemptState, readonly AttemptAction[]>> = {
  created: ['download_package', 'preflight'],
  in_progress: ['capture_response', 'navigate', 'sync', 'submit'],
  submitted: ['score', 'review', 'rescore'],
  abandoned: [],
};

export function permits(state: AttemptState, action: AttemptAction): boolean {
  return PERMITTED[state].includes(action);
}
