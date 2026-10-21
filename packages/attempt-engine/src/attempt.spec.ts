import { describe, expect, it } from 'vitest';
import {
  abandonAttempt,
  captureResponse,
  createAttempt,
  ingestEvent,
  projectAttempt,
  startAttempt,
  submitAttempt,
  type Attempt,
  type AttemptResult,
} from './attempt.js';
import { ATTEMPT_STATES } from './attempt-state.js';
import type { ResponseEvent } from './response-event.js';

const OPTIONS = { intervalCapMs: 60_000 };

function ev(eventId: string, sequence: number, kind: ResponseEvent['kind'] = 'select', answer = 'A', slot = 'q1'): ResponseEvent {
  const base = { eventId, attemptId: 'a1', slot, sequence, monotonicMs: sequence * 100 };
  return kind === 'select' || kind === 'change' ? { ...base, kind, answer } : { ...base, kind };
}

function ok(result: AttemptResult): Attempt {
  if (!result.ok) throw new Error(`refused: ${result.reason}`);
  return result.attempt;
}

const started = () => ok(startAttempt(createAttempt('a1')));
const submitted = (events: ResponseEvent[] = []) =>
  ok(submitAttempt(events.reduce((a, e) => ok(captureResponse(a, e)), started()), { reason: 'manual', idempotencyKey: 'k1' }));
const abandoned = () => ok(abandonAttempt(started()));

describe('lifecycle', () => {
  it('walks created → in_progress → submitted', () => {
    expect(createAttempt('a1').state).toBe('created');
    expect(started().state).toBe('in_progress');
    expect(submitted().state).toBe('submitted');
  });

  it('records which kind of submission it was', () => {
    for (const reason of ['manual', 'expiry', 'recovered'] as const) {
      const attempt = ok(submitAttempt(started(), { reason, idempotencyKey: reason }));
      expect(attempt.state).toBe('submitted');
      expect(attempt.submission?.reason).toBe(reason);
    }
  });

  it('refuses a prohibited transition and names the pair', () => {
    expect(startAttempt(started())).toEqual({ ok: false, reason: 'transition_prohibited', from: 'in_progress', trigger: 'start' });
    expect(submitAttempt(createAttempt('a1'), { reason: 'manual', idempotencyKey: 'k' })).toEqual({
      ok: false,
      reason: 'transition_prohibited',
      from: 'created',
      trigger: 'submit_manual',
    });
    expect(submitAttempt(abandoned(), { reason: 'expiry', idempotencyKey: 'k' })).toEqual({
      ok: false,
      reason: 'transition_prohibited',
      from: 'abandoned',
      trigger: 'submit_expiry',
    });
  });

  it('does not change the attempt it was given', () => {
    const before = started();
    submitAttempt(before, { reason: 'manual', idempotencyKey: 'k' });
    expect(before.state).toBe('in_progress');
    expect(before.submission).toBeNull();
  });
});

describe('response capture', () => {
  it('is refused in created', () => {
    expect(captureResponse(createAttempt('a1'), ev('e1', 1))).toEqual({ ok: false, reason: 'capture_prohibited', state: 'created' });
  });

  it('is accepted in progress', () => {
    expect(ok(captureResponse(started(), ev('e1', 1))).log.events).toHaveLength(1);
  });

  it('is refused after submission, and the log is untouched', () => {
    const attempt = submitted([ev('e1', 1)]);
    expect(captureResponse(attempt, ev('e2', 2))).toEqual({ ok: false, reason: 'capture_prohibited', state: 'submitted' });
    expect(attempt.log.events).toHaveLength(1);
  });

  it('is refused once abandoned', () => {
    expect(captureResponse(abandoned(), ev('e1', 1))).toEqual({ ok: false, reason: 'capture_prohibited', state: 'abandoned' });
  });

  it('every state other than in_progress refuses capture', () => {
    const byState: Record<(typeof ATTEMPT_STATES)[number], Attempt> = {
      created: createAttempt('a1'),
      in_progress: started(),
      submitted: submitted(),
      abandoned: abandoned(),
    };
    expect(ATTEMPT_STATES.filter((s) => captureResponse(byState[s], ev('e1', 1)).ok)).toEqual(['in_progress']);
  });

  it('passes the log\'s own refusals through: a sequence regression, a foreign attempt', () => {
    const attempt = ok(captureResponse(started(), ev('e1', 5)));
    expect(captureResponse(attempt, ev('e2', 3))).toMatchObject({ ok: false, reason: 'sequence_regression' });
    expect(captureResponse(attempt, { ...ev('e3', 9), attemptId: 'other' })).toMatchObject({ ok: false, reason: 'wrong_attempt' });
  });

  it('ignores a replayed event', () => {
    const attempt = ok(captureResponse(started(), ev('e1', 1)));
    expect(ok(captureResponse(attempt, ev('e1', 1))).log).toBe(attempt.log);
  });
});

describe('events arriving after submission', () => {
  const lateEvent = ev('late', 2, 'change', 'B');

  it('are recorded: the log keeps them', () => {
    const attempt = ok(ingestEvent(submitted([ev('e1', 1)]), lateEvent));
    expect(attempt.log.events.map((e) => e.eventId)).toEqual(['e1', 'late']);
  });

  it('are excluded from scoring: the projection drops them', () => {
    const attempt = ok(ingestEvent(submitted([ev('e1', 1, 'select', 'A')]), lateEvent));
    expect(projectAttempt(attempt, OPTIONS).slots[0]).toMatchObject({ answer: 'A', answerChanges: 0 });
  });

  it('are kept even when their sequence is behind the log, as an offline queue delivers them', () => {
    const attempt = ok(ingestEvent(submitted([ev('e9', 9)]), ev('late', 2)));
    expect(attempt.log.events.map((e) => e.eventId)).toEqual(['e9', 'late']);
  });

  it('a replay of one is a no-op, and a replay of a scored event is too', () => {
    const attempt = ok(ingestEvent(submitted([ev('e1', 1)]), lateEvent));
    expect(ok(ingestEvent(attempt, lateEvent)).log).toBe(attempt.log);
    expect(ok(ingestEvent(attempt, ev('e1', 1))).log).toBe(attempt.log);
  });

  it('would have counted had they arrived in time: the same events, submitted later, score', () => {
    const inTime = ok(submitAttempt(ok(captureResponse(started(), ev('e1', 1))), { reason: 'manual', idempotencyKey: 'k' }));
    const late = ok(ingestEvent(inTime, ev('e2', 2, 'change', 'B')));
    const onTime = submitted([ev('e1', 1), ev('e2', 2, 'change', 'B')]);
    expect(projectAttempt(late, OPTIONS).slots[0]?.answer).toBe('A');
    expect(projectAttempt(onTime, OPTIONS).slots[0]?.answer).toBe('B');
  });

  it('are refused before the attempt starts and once it is abandoned', () => {
    expect(ingestEvent(createAttempt('a1'), lateEvent)).toEqual({ ok: false, reason: 'ingest_prohibited', state: 'created' });
    expect(ingestEvent(abandoned(), lateEvent)).toEqual({ ok: false, reason: 'ingest_prohibited', state: 'abandoned' });
  });

  it('are appended like any other event while the attempt is in progress', () => {
    expect(ok(ingestEvent(started(), ev('e1', 1))).log.events).toHaveLength(1);
  });

  it('still refuse a foreign attempt and a conflicting id', () => {
    const attempt = submitted([ev('e1', 1, 'select', 'A')]);
    expect(ingestEvent(attempt, { ...lateEvent, attemptId: 'other' })).toMatchObject({ ok: false, reason: 'wrong_attempt' });
    expect(ingestEvent(attempt, ev('e1', 1, 'select', 'Z'))).toMatchObject({ ok: false, reason: 'conflicting_event' });
  });
});

describe('submission is idempotent on its key', () => {
  it('the same key again returns the attempt unchanged', () => {
    const attempt = submitted([ev('e1', 1)]);
    expect(submitAttempt(attempt, { reason: 'manual', idempotencyKey: 'k1' })).toEqual({ ok: true, attempt });
  });

  it('a retry with the same key but a different reason is still the same submission', () => {
    const attempt = submitted();
    const retry = submitAttempt(attempt, { reason: 'recovered', idempotencyKey: 'k1' });
    expect(retry.ok && retry.attempt).toBe(attempt);
  });

  it('a different key on a submitted attempt is refused', () => {
    expect(submitAttempt(submitted(), { reason: 'manual', idempotencyKey: 'k2' })).toEqual({
      ok: false,
      reason: 'already_submitted_under_another_key',
    });
  });

  it('a retry after late events does not widen what is scored', () => {
    const attempt = ok(ingestEvent(submitted([ev('e1', 1)]), ev('late', 2)));
    const retried = ok(submitAttempt(attempt, { reason: 'manual', idempotencyKey: 'k1' }));
    expect([...(retried.submission?.scoredEventIds ?? [])]).toEqual(['e1']);
  });
});

describe('abandoning', () => {
  it('closes an in-progress attempt with no answers, even one that was only visited or flagged', () => {
    const attempt = [ev('v', 1, 'visit'), ev('f', 2, 'flag'), ev('l', 3, 'leave')].reduce((a, e) => ok(captureResponse(a, e)), started());
    expect(ok(abandonAttempt(attempt)).state).toBe('abandoned');
  });

  it('refuses when anything was answered: that attempt must be submitted', () => {
    for (const kind of ['select', 'change'] as const) {
      const attempt = ok(captureResponse(started(), ev('e1', 1, kind)));
      expect(abandonAttempt(attempt)).toEqual({ ok: false, reason: 'has_responses' });
    }
  });

  it('closes a created attempt that was never started (D53, ADR-0030)', () => {
    expect(ok(abandonAttempt(createAttempt('a1'))).state).toBe('abandoned');
  });

  it('is refused from submitted and abandoned by the transition table', () => {
    for (const attempt of [submitted(), abandoned()]) {
      expect(abandonAttempt(attempt)).toMatchObject({ ok: false, reason: 'transition_prohibited', trigger: 'abandon' });
    }
  });
});

describe('projecting an attempt', () => {
  it('projects everything while in progress', () => {
    const attempt = [ev('e1', 1, 'select', 'A'), ev('e2', 2, 'change', 'B')].reduce((a, e) => ok(captureResponse(a, e)), started());
    expect(projectAttempt(attempt, OPTIONS).slots[0]).toMatchObject({ answer: 'B', answerChanges: 1 });
  });

  it('is deterministic across a device-switch style replay after submission', () => {
    const a = submitted([ev('e1', 1, 'select', 'A'), ev('e2', 2, 'change', 'B')]);
    const replayed = ok(ingestEvent(ok(ingestEvent(a, ev('e2', 2, 'change', 'B'))), ev('e1', 1, 'select', 'A')));
    expect(projectAttempt(replayed, OPTIONS)).toEqual(projectAttempt(a, OPTIONS));
  });
});
