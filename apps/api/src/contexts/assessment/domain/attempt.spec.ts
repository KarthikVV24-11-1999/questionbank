import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, anAttempt, attemptProps, id, slots } from '../../../testing/assessment-fixtures.js';
import {
  abandonAttempt,
  admitNewAttempt,
  createAttempt,
  isActive,
  isExpired,
  restoreAttempt,
  startAttempt,
  submitAttempt,
  type AttemptMode,
  type AttemptSnapshot,
  type CreateAttemptProps,
} from './attempt.js';
import { ATTEMPT_STATES, type AttemptState } from './attempt-state.js';

const OPEN = '2026-10-21T09:00:00.000Z';
const AFTER_WINDOW = '2026-10-21T12:00:00.000Z';
const started = () => expectValue(startAttempt(anAttempt(), OPEN));
const submitted = () => expectValue(submitAttempt(started(), { reason: 'manual', idempotencyKey: 'k1' }, OPEN));

describe('creating an attempt', () => {
  it('starts in created with nothing anchored yet', () => {
    const attempt = anAttempt();
    expect(attempt.state).toBe('created');
    expect([attempt.startedAt, attempt.deadline, attempt.submission, attempt.abandonedAt]).toEqual([null, null, null, null]);
    expect(Object.isFrozen(attempt)).toBe(true);
    expect(Object.isFrozen(attempt.slots)).toBe(true);
    expect(Object.isFrozen(attempt.slots[0])).toBe(true);
    expect(Object.isFrozen(attempt.deliveryPolicy)).toBe(true);
  });

  it('orders the slots by ordinal whatever order they were given', () => {
    const attempt = anAttempt({ slots: [...slots(3)].reverse() });
    expect(attempt.slots.map((s) => s.ordinal)).toEqual([1, 2, 3]);
  });

  it('pins the item VERSION of every slot, not just the item', () => {
    const attempt = anAttempt();
    expect(attempt.slots.map((s) => s.itemVersionId)).toEqual([id(TAG.itemVersion, 1), id(TAG.itemVersion, 2), id(TAG.itemVersion, 3)]);
    expect(attempt.slots[0]?.itemVersionId).not.toBe(attempt.slots[0]?.itemId);
  });

  it('copies its inputs: editing the props afterwards changes nothing', () => {
    const props = attemptProps();
    const attempt = expectValue(createAttempt(props));
    (props.deliveryPolicy as Record<string, unknown>)['timing'] = 'changed';
    expect(attempt.deliveryPolicy['timing']).toBe('strict');
  });

  const REFUSALS: readonly (readonly [string, Partial<CreateAttemptProps>, string])[] = [
    ['a bad attempt id', { attemptId: 'nope' }, 'ATTEMPT_ID_INVALID'],
    ['a bad student id', { studentId: 'nope' }, 'ATTEMPT_STUDENT_INVALID'],
    ['an unknown mode', { mode: 'practice' as AttemptMode }, 'ATTEMPT_MODE_INVALID'],
    ['a bad form id', { formId: 'nope' }, 'ATTEMPT_FORM_INVALID'],
    ['a bad profile version id', { examProfileVersionId: 'nope' }, 'ATTEMPT_PROFILE_INVALID'],
    ['a marking hash that is not a SHA-256', { markingRuleSetHash: 'abc' }, 'ATTEMPT_MARKING_HASH_INVALID'],
    ['a bad taxonomy version', { taxonomyVersionId: 'nope' }, 'ATTEMPT_TAXONOMY_INVALID'],
    ['a delivery policy that is not an object', { deliveryPolicy: [] as unknown as Record<string, unknown> }, 'ATTEMPT_DELIVERY_POLICY_INVALID'],
    ['no session (§12)', { sessionId: '' }, 'ATTEMPT_SESSION_INVALID'],
    ['a blank shift (§12)', { shiftId: '   ' }, 'ATTEMPT_SHIFT_INVALID'],
    ['a zero duration', { durationMs: 0 }, 'ATTEMPT_DURATION_INVALID'],
    ['a fractional duration', { durationMs: 1.5 }, 'ATTEMPT_DURATION_INVALID'],
    ['a window without milliseconds', { windowClosesAt: '2026-10-21T12:00:00Z' }, 'ATTEMPT_WINDOW_INVALID'],
    ['an impossible created-at', { createdAt: '2026-13-45T99:00:00.000Z' }, 'ATTEMPT_CREATED_AT_INVALID'],
    ['no slots', { slots: [] }, 'ATTEMPT_SLOTS_INVALID'],
    ['a slot without an item version', { slots: [{ ...slots(1)[0]!, itemVersionId: 'nope' }] }, 'ATTEMPT_SLOTS_INVALID'],
    ['a slot with a bad stimulus', { slots: [{ ...slots(1)[0]!, stimulusVersionId: 'nope' }] }, 'ATTEMPT_SLOTS_INVALID'],
    ['a negative ordinal', { slots: [{ ...slots(1)[0]!, ordinal: -1 }] }, 'ATTEMPT_SLOTS_INVALID'],
    ['a repeated slot id', { slots: [slots(2)[0]!, { ...slots(2)[1]!, slotId: slots(2)[0]!.slotId }] }, 'ATTEMPT_SLOTS_INVALID'],
    ['a repeated ordinal', { slots: [slots(2)[0]!, { ...slots(2)[1]!, ordinal: 1 }] }, 'ATTEMPT_SLOTS_INVALID'],
  ];

  it.each(REFUSALS)('refuses %s', (_name, overrides, code) => {
    const error = expectError(createAttempt(attemptProps(overrides)));
    expect(error.code).toBe(code);
    expect(error.kind).toBe('Validation');
  });

  it('accepts a slot that has no stimulus', () => {
    expect(anAttempt({ slots: [{ ...slots(1)[0]!, stimulusVersionId: null }] }).slots[0]?.stimulusVersionId).toBeNull();
  });
});

describe('starting', () => {
  it('anchors the deadline at the server\'s now plus the duration', () => {
    const attempt = started();
    expect(attempt.state).toBe('in_progress');
    expect(attempt.startedAt).toBe(OPEN);
    expect(attempt.deadline).toBe('2026-10-21T12:00:00.000Z');
  });

  it('is anchored to the parameter alone: a later start gets a later deadline', () => {
    const later = expectValue(startAttempt(anAttempt(), '2026-10-21T10:30:00.000Z'));
    expect(later.deadline).toBe('2026-10-21T13:30:00.000Z');
  });

  it('refuses once the window has closed, including at the closing instant', () => {
    expect(expectError(startAttempt(anAttempt(), AFTER_WINDOW)).code).toBe('ATTEMPT_WINDOW_CLOSED');
    expect(expectError(startAttempt(anAttempt(), '2026-10-21T12:00:00.001Z')).code).toBe('ATTEMPT_WINDOW_CLOSED');
    expect(startAttempt(anAttempt(), '2026-10-21T11:59:59.999Z').ok).toBe(true);
  });

  it('is refused from every state but created', () => {
    for (const attempt of [started(), submitted()]) {
      expect(expectError(startAttempt(attempt, OPEN)).code).toBe('ATTEMPT_TRANSITION_PROHIBITED');
    }
  });

  it('refuses a malformed now', () => {
    expect(expectError(startAttempt(anAttempt(), 'yesterday')).code).toBe('ATTEMPT_NOW_INVALID');
  });

  it('does not change the attempt it was given', () => {
    const before = anAttempt();
    startAttempt(before, OPEN);
    expect(before.state).toBe('created');
    expect(before.deadline).toBeNull();
  });
});

describe('expiry is computed from the anchored deadline', () => {
  it('is false before, true at and after the deadline', () => {
    const attempt = started();
    expect(isExpired(attempt, '2026-10-21T11:59:59.999Z')).toBe(false);
    expect(isExpired(attempt, '2026-10-21T12:00:00.000Z')).toBe(true);
    expect(isExpired(attempt, '2026-10-21T13:00:00.000Z')).toBe(true);
  });

  it('is false for an attempt with no deadline yet', () => {
    expect(isExpired(anAttempt(), '2030-01-01T00:00:00.000Z')).toBe(false);
  });
});

describe('submitting', () => {
  it('submits an in-progress attempt, recording how', () => {
    for (const reason of ['manual', 'expiry', 'recovered'] as const) {
      const attempt = expectValue(submitAttempt(started(), { reason, idempotencyKey: `k-${reason}` }, OPEN));
      expect(attempt.state).toBe('submitted');
      expect(attempt.submission).toEqual({ reason, idempotencyKey: `k-${reason}`, submittedAt: OPEN });
    }
  });

  it('is idempotent on the key: the same key returns the attempt unchanged', () => {
    const once = submitted();
    expect(expectValue(submitAttempt(once, { reason: 'manual', idempotencyKey: 'k1' }, '2026-10-21T10:00:00.000Z'))).toBe(once);
  });

  it('a different key on a submitted attempt is a conflict, not a second submission', () => {
    const error = expectError(submitAttempt(submitted(), { reason: 'manual', idempotencyKey: 'k2' }, OPEN));
    expect(error.code).toBe('ATTEMPT_SUBMITTED_UNDER_ANOTHER_KEY');
    expect(error.kind).toBe('Conflict');
  });

  it('is refused from created and abandoned', () => {
    const abandoned = expectValue(abandonAttempt(anAttempt(), AFTER_WINDOW, 0));
    for (const attempt of [anAttempt(), abandoned]) {
      expect(expectError(submitAttempt(attempt, { reason: 'manual', idempotencyKey: 'k' }, OPEN)).code).toBe('ATTEMPT_TRANSITION_PROHIBITED');
    }
  });

  it('refuses a blank key, an unknown reason and a malformed now', () => {
    expect(expectError(submitAttempt(started(), { reason: 'manual', idempotencyKey: ' ' }, OPEN)).code).toBe('ATTEMPT_SUBMISSION_INVALID');
    expect(expectError(submitAttempt(started(), { reason: 'whim' as 'manual', idempotencyKey: 'k' }, OPEN)).code).toBe('ATTEMPT_SUBMISSION_INVALID');
    expect(expectError(submitAttempt(started(), { reason: 'manual', idempotencyKey: 'k' }, 'soon')).code).toBe('ATTEMPT_NOW_INVALID');
  });
});

describe('abandoning (D53, ADR-0030)', () => {
  it('ends a created attempt that was never started once its window has closed', () => {
    const attempt = expectValue(abandonAttempt(anAttempt(), AFTER_WINDOW, 0));
    expect(attempt.state).toBe('abandoned');
    expect(attempt.abandonedAt).toBe(AFTER_WINDOW);
  });

  it('ends an in-progress attempt with no responses once its window has closed', () => {
    expect(expectValue(abandonAttempt(started(), AFTER_WINDOW, 0)).state).toBe('abandoned');
  });

  it('refuses while the window is still open', () => {
    expect(expectError(abandonAttempt(anAttempt(), '2026-10-21T11:59:59.999Z', 0)).code).toBe('ATTEMPT_WINDOW_STILL_OPEN');
  });

  it('refuses an attempt with responses: that one is submitted', () => {
    expect(expectError(abandonAttempt(started(), AFTER_WINDOW, 1)).code).toBe('ATTEMPT_HAS_RESPONSES');
  });

  it('is refused from submitted and abandoned', () => {
    const abandoned = expectValue(abandonAttempt(anAttempt(), AFTER_WINDOW, 0));
    for (const attempt of [submitted(), abandoned]) {
      expect(expectError(abandonAttempt(attempt, AFTER_WINDOW, 0)).code).toBe('ATTEMPT_TRANSITION_PROHIBITED');
    }
  });

  it('refuses a malformed now', () => {
    expect(expectError(abandonAttempt(anAttempt(), 'later', 0)).code).toBe('ATTEMPT_NOW_INVALID');
  });
});

describe('one active mock attempt per student — what "active" means, pinned', () => {
  const MODES: AttemptMode[] = ['mock', 'diagnostic'];

  it('is active exactly when the state is created or in_progress, whatever the time', () => {
    const byState: Record<AttemptState, boolean> = { created: true, in_progress: true, submitted: false, abandoned: false };
    for (const state of ATTEMPT_STATES) expect(isActive({ state })).toBe(byState[state]);
  });

  it('a created attempt past its window is STILL active until something abandons it (the rejected alternative must not creep back)', () => {
    const stale = anAttempt();
    expect(isActive(stale)).toBe(true);
    // nothing about the clock enters: the same attempt, asked at any "now", is active
    expect(isActive(stale)).toBe(isExpired(stale, '2099-01-01T00:00:00.000Z') || isActive(stale));
    expect(isActive.length).toBe(1);
    expect(admitNewAttempt('mock', [stale]).ok).toBe(false);
    // and abandoning it is what frees the student
    const abandoned = expectValue(abandonAttempt(stale, AFTER_WINDOW, 0));
    expect(admitNewAttempt('mock', [abandoned]).ok).toBe(true);
  });

  it('admits a mock only when no mock of theirs is active — every mode × state pair', () => {
    for (const mode of MODES) {
      for (const state of ATTEMPT_STATES) {
        const blocks = mode === 'mock' && (state === 'created' || state === 'in_progress');
        const result = admitNewAttempt('mock', [{ attemptId: id(TAG.attempt, 9), mode, state }]);
        expect(result.ok, `${mode}/${state}`).toBe(!blocks);
      }
    }
  });

  it('never blocks a diagnostic, and names the attempt in the way', () => {
    const live = { attemptId: id(TAG.attempt, 9), mode: 'mock' as const, state: 'in_progress' as const };
    expect(admitNewAttempt('diagnostic', [live]).ok).toBe(true);
    const error = expectError(admitNewAttempt('mock', [live]));
    expect(error.code).toBe('ACTIVE_MOCK_ATTEMPT_EXISTS');
    expect(error.kind).toBe('Conflict');
    expect(error.message).toContain(live.attemptId);
  });

  it('admits when the student has no attempts', () => {
    expect(admitNewAttempt('mock', []).ok).toBe(true);
  });
});

describe('restoring an attempt from storage', () => {
  const NOT_YET = { startedAt: null, deadline: null, submission: null, abandonedAt: null };
  const SUBMISSION = { reason: 'manual' as const, idempotencyKey: 'k1', submittedAt: '2026-10-21T10:00:00.000Z' };
  const STARTED = { startedAt: '2026-10-21T09:00:00.000Z', deadline: '2026-10-21T12:00:00.000Z' };
  const snapshot = (overrides: Partial<AttemptSnapshot>): AttemptSnapshot => ({ ...attemptProps(), state: 'created', ...NOT_YET, ...overrides });

  const VALID: readonly (readonly [string, Partial<AttemptSnapshot>])[] = [
    ['created', {}],
    ['in_progress', { state: 'in_progress', ...STARTED }],
    ['submitted', { state: 'submitted', ...STARTED, submission: SUBMISSION }],
    ['abandoned from created', { state: 'abandoned', abandonedAt: '2026-10-21T12:30:00.000Z' }],
    ['abandoned from in_progress', { state: 'abandoned', ...STARTED, abandonedAt: '2026-10-21T12:30:00.000Z' }],
  ];

  it.each(VALID)('restores a %s attempt exactly as it was', (_name, overrides) => {
    const wanted = snapshot(overrides);
    const attempt = expectValue(restoreAttempt(wanted));
    expect(attempt.state).toBe(wanted.state);
    expect(attempt.startedAt).toBe(wanted.startedAt);
    expect(attempt.deadline).toBe(wanted.deadline);
    expect(attempt.submission).toEqual(wanted.submission);
    expect(attempt.abandonedAt).toBe(wanted.abandonedAt);
    expect(Object.isFrozen(attempt)).toBe(true);
    if (attempt.submission !== null) expect(Object.isFrozen(attempt.submission)).toBe(true);
  });

  it('keeps a deadline that is not start plus duration: the stored anchor wins', () => {
    const attempt = expectValue(restoreAttempt(snapshot({ state: 'in_progress', startedAt: STARTED.startedAt, deadline: '2026-10-21T11:00:00.000Z' })));
    expect(attempt.deadline).toBe('2026-10-21T11:00:00.000Z');
  });

  const INVALID: readonly (readonly [string, Partial<AttemptSnapshot>])[] = [
    ['an unknown state', { state: 'paused' as AttemptState }],
    ['created with a start time', { startedAt: STARTED.startedAt, deadline: STARTED.deadline }],
    ['in_progress with no deadline', { state: 'in_progress', startedAt: STARTED.startedAt }],
    ['in_progress with a deadline and no start', { state: 'in_progress', deadline: STARTED.deadline }],
    ['in_progress carrying a submission', { state: 'in_progress', ...STARTED, submission: SUBMISSION }],
    ['submitted with no submission', { state: 'submitted', ...STARTED }],
    ['submitted without ever starting', { state: 'submitted', submission: SUBMISSION }],
    ['submitted and abandoned at once', { state: 'submitted', ...STARTED, submission: SUBMISSION, abandonedAt: '2026-10-21T12:30:00.000Z' }],
    ['abandoned with no time', { state: 'abandoned' }],
    ['abandoned and submitted', { state: 'abandoned', submission: SUBMISSION, abandonedAt: '2026-10-21T12:30:00.000Z' }],
    ['a malformed start time', { state: 'in_progress', startedAt: 'yesterday', deadline: STARTED.deadline }],
    ['a submission with a blank key', { state: 'submitted', ...STARTED, submission: { ...SUBMISSION, idempotencyKey: ' ' } }],
    ['a submission with an unknown reason', { state: 'submitted', ...STARTED, submission: { ...SUBMISSION, reason: 'whim' as 'manual' } }],
    ['a malformed submission time', { state: 'submitted', ...STARTED, submission: { ...SUBMISSION, submittedAt: 'later' } }],
  ];

  it.each(INVALID)('refuses %s', (_name, overrides) => {
    expect(expectError(restoreAttempt(snapshot(overrides))).code).toBe('ATTEMPT_STORED_STATE_INVALID');
  });

  it('refuses a snapshot the creation rules refuse, with their own code', () => {
    expect(expectError(restoreAttempt(snapshot({ shiftId: '' }))).code).toBe('ATTEMPT_SHIFT_INVALID');
  });
});
