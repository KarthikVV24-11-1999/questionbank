import { describe, expect, it } from 'vitest';
import {
  ATTEMPT_ACTIONS,
  ATTEMPT_STATES,
  ATTEMPT_TRIGGERS,
  permits,
  transition,
  type AttemptAction,
  type AttemptState,
  type AttemptTrigger,
} from './attempt-state.js';

// The design's table, written out pair by pair. Not derived from the code.
const EXPECTED_TRANSITIONS: readonly (readonly [AttemptState, AttemptTrigger, AttemptState | null])[] = [
  ['created', 'start', 'in_progress'],
  ['created', 'submit_manual', null],
  ['created', 'submit_expiry', null],
  ['created', 'submit_recovered', null],
  ['created', 'abandon', null],
  ['in_progress', 'start', null],
  ['in_progress', 'submit_manual', 'submitted'],
  ['in_progress', 'submit_expiry', 'submitted'],
  ['in_progress', 'submit_recovered', 'submitted'],
  ['in_progress', 'abandon', 'abandoned'],
  ['submitted', 'start', null],
  ['submitted', 'submit_manual', null],
  ['submitted', 'submit_expiry', null],
  ['submitted', 'submit_recovered', null],
  ['submitted', 'abandon', null],
  ['abandoned', 'start', null],
  ['abandoned', 'submit_manual', null],
  ['abandoned', 'submit_expiry', null],
  ['abandoned', 'submit_recovered', null],
  ['abandoned', 'abandon', null],
];

const PERMITTED: Readonly<Record<AttemptState, readonly AttemptAction[]>> = {
  created: ['download_package', 'preflight'],
  in_progress: ['capture_response', 'navigate', 'sync', 'submit'],
  submitted: ['score', 'review', 'rescore'],
  abandoned: [],
};

describe('the transition matrix', () => {
  it('names the four states and five triggers the design has', () => {
    expect([...ATTEMPT_STATES]).toEqual(['created', 'in_progress', 'submitted', 'abandoned']);
    expect([...ATTEMPT_TRIGGERS]).toEqual(['start', 'submit_manual', 'submit_expiry', 'submit_recovered', 'abandon']);
  });

  it('the expectation covers every pair exactly once: 4 × 5 = 20', () => {
    const pairs = EXPECTED_TRANSITIONS.map(([from, trigger]) => `${from}/${trigger}`);
    const everyPair = ATTEMPT_STATES.flatMap((from) => ATTEMPT_TRIGGERS.map((trigger) => `${from}/${trigger}`));
    expect(new Set(pairs).size).toBe(20);
    expect([...pairs].sort()).toEqual([...everyPair].sort());
  });

  it.each(EXPECTED_TRANSITIONS)('%s + %s → %s', (from, trigger, to) => {
    expect(transition(from, trigger)).toBe(to);
  });

  it('only three transitions leave in_progress and only one leaves created', () => {
    const allowed = EXPECTED_TRANSITIONS.filter(([, , to]) => to !== null).map(([from, trigger]) => `${from}/${trigger}`);
    expect(allowed).toEqual([
      'created/start',
      'in_progress/submit_manual',
      'in_progress/submit_expiry',
      'in_progress/submit_recovered',
      'in_progress/abandon',
    ]);
  });

  it('submitted and abandoned are terminal: no trigger leaves them', () => {
    for (const state of ['submitted', 'abandoned'] as const) {
      expect(ATTEMPT_TRIGGERS.filter((trigger) => transition(state, trigger) !== null)).toEqual([]);
    }
  });
});

describe('the permission matrix', () => {
  const everyPair = ATTEMPT_STATES.flatMap((state) => ATTEMPT_ACTIONS.map((action) => [state, action] as const));

  it('covers every state × action pair: 4 × 11 = 44', () => {
    expect(everyPair).toHaveLength(44);
  });

  it.each(everyPair)('%s / %s', (state, action) => {
    expect(permits(state, action)).toBe(PERMITTED[state].includes(action));
  });

  it('the headline prohibitions hold', () => {
    expect(permits('created', 'capture_response')).toBe(false);
    expect(permits('submitted', 'capture_response')).toBe(false);
    expect(permits('in_progress', 'mutate_form')).toBe(false);
    expect(permits('in_progress', 'access_keys')).toBe(false);
    expect(ATTEMPT_ACTIONS.filter((action) => permits('abandoned', action))).toEqual([]);
  });

  it('no action is permitted in two states: the phases do not overlap', () => {
    for (const action of ATTEMPT_ACTIONS) {
      expect(ATTEMPT_STATES.filter((state) => permits(state, action)).length).toBeLessThanOrEqual(1);
    }
  });
});
