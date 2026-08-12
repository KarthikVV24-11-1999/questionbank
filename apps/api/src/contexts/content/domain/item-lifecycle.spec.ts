import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  applyTransition,
  isDeletable,
  isLifecycleState,
  isLifecycleTransition,
  isStudentVisible,
  isTerminal,
  LIFECYCLE_STATES,
  LIFECYCLE_TRANSITIONS,
  PUBLISHING_TRANSITION,
  transitionsFrom,
  type LifecycleState,
  type LifecycleTransition,
} from './item-lifecycle.js';

/**
 * The legal transitions, written out independently of the implementation. If
 * the table and this list disagree, one of them is wrong and the exhaustive
 * sweep below says which cell.
 */
const LEGAL: readonly (readonly [LifecycleState, LifecycleTransition, LifecycleState])[] = [
  ['draft', 'submit_for_review', 'in_review'],
  ['in_review', 'withdraw', 'draft'],
  ['in_review', 'request_changes', 'changes_requested'],
  ['in_review', 'approve', 'approved'],
  ['in_review', 'reject', 'rejected'],
  ['changes_requested', 'submit_for_review', 'in_review'],
  ['approved', 'publish', 'published'],
  ['approved', 'request_changes', 'changes_requested'],
  ['rejected', 'submit_for_review', 'in_review'],
  ['published', 'suspend', 'suspended'],
  ['published', 'retire', 'retired'],
  ['suspended', 'reinstate', 'published'],
  ['suspended', 'retire', 'retired'],
];

describe('the vocabulary', () => {
  it('is FR-QM-01’s eight states', () => {
    expect([...LIFECYCLE_STATES]).toEqual([
      'draft',
      'in_review',
      'changes_requested',
      'approved',
      'rejected',
      'published',
      'suspended',
      'retired',
    ]);
  });

  it('names nine transitions', () => {
    expect([...LIFECYCLE_TRANSITIONS]).toEqual([
      'submit_for_review',
      'withdraw',
      'request_changes',
      'approve',
      'reject',
      'publish',
      'suspend',
      'reinstate',
      'retire',
    ]);
  });

  it('recognises each state and rejects anything else', () => {
    for (const state of LIFECYCLE_STATES) expect(isLifecycleState(state)).toBe(true);
    expect(isLifecycleState('archived')).toBe(false);
  });

  it('recognises each transition and rejects anything else', () => {
    for (const transition of LIFECYCLE_TRANSITIONS) expect(isLifecycleTransition(transition)).toBe(true);
    expect(isLifecycleTransition('unpublish')).toBe(false);
  });

  it('names the publishing transition once, so preconditions attach to one place', () => {
    expect(PUBLISHING_TRANSITION).toBe('publish');
  });
});

describe('the exhaustive 8 × 9 transition matrix', () => {
  const legalKeys = new Set(LEGAL.map(([from, transition]) => `${from}:${transition}`));

  for (const from of LIFECYCLE_STATES) {
    for (const transition of LIFECYCLE_TRANSITIONS) {
      const expected = LEGAL.find(([state, name]) => state === from && name === transition);

      if (expected !== undefined) {
        it(`permits ${transition} from ${from}, reaching ${expected[2]}`, () => {
          expect(expectValue(applyTransition(from, transition))).toBe(expected[2]);
        });
      } else {
        it(`refuses ${transition} from ${from}`, () => {
          const failure = expectError(applyTransition(from, transition));
          expect(failure.code).toBe('TRANSITION_ILLEGAL');
          expect(failure.kind).toBe('RuleViolation');
          expect(failure.message).toContain(transition);
          expect(failure.message).toContain(from);
        });
      }
    }
  }

  it('covers every cell of the matrix exactly once', () => {
    expect(LIFECYCLE_STATES.length * LIFECYCLE_TRANSITIONS.length).toBe(72);
    expect(legalKeys.size).toBe(LEGAL.length);
    expect(LEGAL).toHaveLength(13);
  });
});

describe('refusals name what was attempted', () => {
  it('rejects an unknown state', () => {
    const failure = expectError(applyTransition('archived' as LifecycleState, 'publish'));
    expect(failure.code).toBe('STATE_UNKNOWN');
  });

  it('rejects an unknown transition', () => {
    const failure = expectError(applyTransition('draft', 'unpublish' as LifecycleTransition));
    expect(failure.code).toBe('TRANSITION_UNKNOWN');
  });

  it('reports the location it was given', () => {
    expect(expectError(applyTransition('draft', 'publish', 'item.lifecycleState')).location).toBe(
      'item.lifecycleState',
    );
  });
});

describe('what each state permits', () => {
  it.each([
    ['draft', ['submit_for_review']],
    ['in_review', ['withdraw', 'request_changes', 'approve', 'reject']],
    ['changes_requested', ['submit_for_review']],
    ['approved', ['publish', 'request_changes']],
    ['rejected', ['submit_for_review']],
    ['published', ['suspend', 'retire']],
    ['suspended', ['reinstate', 'retire']],
    ['retired', []],
  ] as const)('offers %s exactly %j', (state, expected) => {
    expect([...transitionsFrom(state)].sort()).toEqual([...expected].sort());
  });
});

describe('the properties the rest of the model reads', () => {
  // FR-QM-01 rule 3.
  it('makes only published content student-visible', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(isStudentVisible(state)).toBe(state === 'published');
    }
  });

  // FR-QM-01 rule 5: nothing is hard-deleted after draft.
  it('permits deletion only from draft', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(isDeletable(state)).toBe(state === 'draft');
    }
  });

  // FR-QM-07 rule 2 keeps history, statistics and bookmarks pointing at a
  // retired item, so there is nothing to gain from a way back.
  it('makes retired the only terminal state', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(isTerminal(state)).toBe(state === 'retired');
    }
  });

  it('lets a suspension be reversed, so a wrong defect report costs nothing permanently', () => {
    expect(expectValue(applyTransition('suspended', 'reinstate'))).toBe('published');
  });

  it('refuses to reinstate anything that was not suspended', () => {
    for (const state of LIFECYCLE_STATES) {
      if (state === 'suspended') continue;
      expect(expectError(applyTransition(state, 'reinstate')).code).toBe('TRANSITION_ILLEGAL');
    }
  });

  it('refuses to publish anything that is not approved', () => {
    for (const state of LIFECYCLE_STATES) {
      if (state === 'approved') continue;
      expect(expectError(applyTransition(state, 'publish')).code).toBe('TRANSITION_ILLEGAL');
    }
  });

  // The path a rejected item takes back is through review, never straight to
  // publication.
  it('routes a rejected item back through review', () => {
    expect(expectValue(applyTransition('rejected', 'submit_for_review'))).toBe('in_review');
    expect(expectError(applyTransition('rejected', 'publish')).code).toBe('TRANSITION_ILLEGAL');
  });
});
