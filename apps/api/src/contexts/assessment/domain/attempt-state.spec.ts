import { describe, expect, it } from 'vitest';
import {
  ACTIVE_STATES,
  ATTEMPT_STATES,
  ATTEMPT_TRIGGERS,
  canMove,
  isActiveState,
  transition,
  type AttemptState,
  type AttemptTrigger,
} from './attempt-state.js';

// The design as amended by ADR-0030, written out pair by pair — not derived from the code.
const EXPECTED: readonly (readonly [AttemptState, AttemptTrigger, AttemptState | null])[] = [
  ['created', 'start', 'in_progress'],
  ['created', 'submit_manual', null],
  ['created', 'submit_expiry', null],
  ['created', 'submit_recovered', null],
  ['created', 'abandon', 'abandoned'],
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

describe('the transition matrix', () => {
  it('covers every state × trigger pair exactly once: 4 × 5 = 20', () => {
    const pairs = EXPECTED.map(([from, trigger]) => `${from}/${trigger}`);
    const every = ATTEMPT_STATES.flatMap((from) => ATTEMPT_TRIGGERS.map((trigger) => `${from}/${trigger}`));
    expect(new Set(pairs).size).toBe(20);
    expect([...pairs].sort()).toEqual([...every].sort());
  });

  it.each(EXPECTED)('%s + %s → %s', (from, trigger, to) => {
    expect(transition(from, trigger)).toBe(to);
  });

  it('created has a terminal edge (D53, ADR-0030): an attempt never started can end', () => {
    expect(transition('created', 'abandon')).toBe('abandoned');
  });

  it('submitted and abandoned are terminal', () => {
    for (const state of ['submitted', 'abandoned'] as const) {
      expect(ATTEMPT_TRIGGERS.filter((trigger) => transition(state, trigger) !== null)).toEqual([]);
    }
  });
});

describe('canMove — the shape the database trigger checks', () => {
  const edges = new Set(EXPECTED.filter(([, , to]) => to !== null).map(([from, , to]) => `${from}>${to}`));

  it.each(ATTEMPT_STATES.flatMap((from) => ATTEMPT_STATES.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    expect(canMove(from, to)).toBe(edges.has(`${from}>${to}`));
  });

  it('the permitted edges are exactly the four distinct ones', () => {
    expect([...edges].sort()).toEqual(['created>abandoned', 'created>in_progress', 'in_progress>abandoned', 'in_progress>submitted']);
  });
});

describe('active', () => {
  it('is the two live states and nothing else', () => {
    expect([...ACTIVE_STATES]).toEqual(['created', 'in_progress']);
    expect(ATTEMPT_STATES.filter(isActiveState)).toEqual(['created', 'in_progress']);
  });

  it('is a function of the state alone: it takes one argument and no time', () => {
    expect(isActiveState.length).toBe(1);
  });
});
