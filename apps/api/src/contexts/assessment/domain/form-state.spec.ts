import { describe, expect, it } from 'vitest';
import { FORM_STATES, FORM_TRIGGERS, canMove, isFrozen, transition, type FormState, type FormTrigger } from './form-state.js';

// The lifecycle, written out pair by pair — not derived from the code.
const EXPECTED: readonly (readonly [FormState, FormTrigger, FormState | null])[] = [
  ['draft', 'publish', 'published'],
  ['draft', 'schedule', null],
  ['draft', 'open', null],
  ['draft', 'close', null],
  ['published', 'publish', null],
  ['published', 'schedule', 'embargoed'],
  ['published', 'open', null],
  ['published', 'close', null],
  ['embargoed', 'publish', null],
  ['embargoed', 'schedule', null],
  ['embargoed', 'open', 'active'],
  ['embargoed', 'close', null],
  ['active', 'publish', null],
  ['active', 'schedule', null],
  ['active', 'open', null],
  ['active', 'close', 'closed'],
  ['closed', 'publish', null],
  ['closed', 'schedule', null],
  ['closed', 'open', null],
  ['closed', 'close', null],
];

describe('the form lifecycle matrix', () => {
  it('names the five states and four triggers', () => {
    expect([...FORM_STATES]).toEqual(['draft', 'published', 'embargoed', 'active', 'closed']);
    expect([...FORM_TRIGGERS]).toEqual(['publish', 'schedule', 'open', 'close']);
  });

  it('the expectation covers every state × trigger pair exactly once: 5 × 4 = 20', () => {
    const pairs = EXPECTED.map(([from, trigger]) => `${from}/${trigger}`);
    const every = FORM_STATES.flatMap((from) => FORM_TRIGGERS.map((trigger) => `${from}/${trigger}`));
    expect(new Set(pairs).size).toBe(20);
    expect([...pairs].sort()).toEqual([...every].sort());
  });

  it.each(EXPECTED)('%s + %s → %s', (from, trigger, to) => {
    expect(transition(from, trigger)).toBe(to);
  });

  it('is a straight line: four edges, each state followed by exactly one other, and closed is terminal', () => {
    const edges = EXPECTED.filter(([, , to]) => to !== null).map(([from, , to]) => `${from}>${to}`);
    expect(edges).toEqual(['draft>published', 'published>embargoed', 'embargoed>active', 'active>closed']);
    expect(FORM_TRIGGERS.filter((trigger) => transition('closed', trigger) !== null)).toEqual([]);
  });
});

describe('canMove — the shape the database trigger checks', () => {
  const edges = new Set(EXPECTED.filter(([, , to]) => to !== null).map(([from, , to]) => `${from}>${to}`));

  it.each(FORM_STATES.flatMap((from) => FORM_STATES.map((to) => [from, to] as const)))('%s → %s', (from, to) => {
    expect(canMove(from, to)).toBe(edges.has(`${from}>${to}`));
  });
});

describe('frozen', () => {
  it('is every state past draft, so composition never thaws', () => {
    expect(FORM_STATES.filter(isFrozen)).toEqual(['published', 'embargoed', 'active', 'closed']);
    expect(isFrozen('draft')).toBe(false);
  });
});
