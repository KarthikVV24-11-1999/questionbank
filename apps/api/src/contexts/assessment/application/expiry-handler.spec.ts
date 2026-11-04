import { describe, expect, it } from 'vitest';
import { startAttempt } from '../domain/attempt.js';
import { PRACTICE_IDLE_MS } from './handlers/expiry-handler.js';
import { conflictError } from '../domain/assessment-error.js';
import { err } from '../domain/result.js';
import { InMemoryAttempts } from '../../../testing/assessment-fakes.js';
import { TAG, anAttempt, id } from '../../../testing/assessment-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { SubmitExpiredAttemptsHandler } from './handlers/expiry-handler.js';
import type { ApplicationContext, AuditRecord } from './ports.js';

const ctx = (role = 'system'): ApplicationContext => ({ principal: { kind: 'system', id: id(TAG.student, 99), roleContext: [role] }, correlationId: 'scheduler:test' });

async function rig(now: string, attempts: { n: number; startedAt: string }[] = [{ n: 1, startedAt: '2026-10-21T09:00:00.000Z' }]) {
  const store = new InMemoryAttempts();
  const events = store.events;
  for (const { n, startedAt } of attempts) {
    const created = anAttempt({ attemptId: id(TAG.attempt, n), studentId: id(TAG.student, n) });
    store.stored.set(created.attemptId, expectValue(startAttempt(created, startedAt)));
  }
  const recorded: AuditRecord[] = [];
  const handler = new SubmitExpiredAttemptsHandler({ attempts: store, clock: { now: () => new Date(now) }, audit: { record: async (entry) => void recorded.push(entry) } });
  return { handler, store, events, recorded };
}

describe('SubmitExpiredAttempts (M6-42, D36)', () => {
  it('submits an attempt whose deadline has passed, as an expiry, with its event, under a key derived from the attempt', async () => {
    const { handler, store, events, recorded } = await rig('2026-10-21T12:00:00.000Z');
    const report = expectValue(await handler.handle({}, ctx()));
    expect(report).toEqual({ asOf: '2026-10-21T12:00:00.000Z', submitted: 1, runsFinished: 0, skipped: [] });
    const stored = store.stored.get(id(TAG.attempt, 1))!;
    expect(stored.state).toBe('submitted');
    expect(stored.submission).toEqual({ reason: 'expiry', idempotencyKey: `expiry:${id(TAG.attempt, 1)}`, submittedAt: '2026-10-21T12:00:00.000Z' });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ eventType: 'AttemptSubmitted', correlationId: 'scheduler:test', principal: { kind: 'system' }, payload: { attemptId: id(TAG.attempt, 1), reason: 'expiry', submittedAt: '2026-10-21T12:00:00.000Z' } });
    expect(recorded).toHaveLength(1);
    expect(recorded[0]).toMatchObject({ action: 'SubmitExpiredAttempts', targetContext: 'assessment' });
  });

  it('leaves alone an attempt whose deadline has not passed, and a second pass finds nothing left', async () => {
    const early = await rig('2026-10-21T11:59:59.999Z');
    expect(expectValue(await early.handler.handle({}, ctx())).submitted).toBe(0);
    expect(early.store.stored.get(id(TAG.attempt, 1))!.state).toBe('in_progress');

    const late = await rig('2026-10-21T12:00:00.000Z');
    expect(expectValue(await late.handler.handle({}, ctx())).submitted).toBe(1);
    expect(expectValue(await late.handler.handle({}, ctx())).submitted).toBe(0);
    expect(late.events).toHaveLength(1);
  });

  it('honours a limit, and reports the one that did not apply without stopping the rest', async () => {
    const limited = await rig('2026-10-21T13:00:00.000Z', [{ n: 1, startedAt: '2026-10-21T08:00:00.000Z' }, { n: 2, startedAt: '2026-10-21T08:00:00.000Z' }]);
    expect(expectValue(await limited.handler.handle({ limit: 1 }, ctx())).submitted).toBe(1);

    const raced = await rig('2026-10-21T13:00:00.000Z', [{ n: 1, startedAt: '2026-10-21T08:00:00.000Z' }, { n: 2, startedAt: '2026-10-21T08:00:00.000Z' }]);
    const original = raced.store.save.bind(raced.store);
    raced.store.save = async (attempt, expected, event) =>
      attempt.attemptId === id(TAG.attempt, 1) ? err(conflictError('CONFLICT', 'the attempt moved', 'state')) : original(attempt, expected, event);
    const report = expectValue(await raced.handler.handle({}, ctx()));
    expect(report.submitted).toBe(1);
    expect(report.skipped).toEqual([`${id(TAG.attempt, 1)}: CONFLICT`]);
  });

  it('skips an attempt the domain will not submit, naming it', async () => {
    const { handler, store } = await rig('2026-10-21T13:00:00.000Z');
    const found = store.stored.get(id(TAG.attempt, 1))!;
    // an attempt that already carries a different key cannot be submitted as an expiry under this one
    store.stored.set(found.attemptId, { ...found, submission: { reason: 'manual', idempotencyKey: 'someone-elses', submittedAt: '2026-10-21T10:00:00.000Z' } });
    const report = expectValue(await handler.handle({}, ctx()));
    expect(report.submitted).toBe(0);
    expect(report.skipped[0]).toContain('ATTEMPT_SUBMITTED_UNDER_ANOTHER_KEY');
  });

  it('is the system\'s alone, and reports a store that cannot be read', async () => {
    const { handler, store } = await rig('2026-10-21T13:00:00.000Z');
    for (const role of ['learner', 'content_ops', 'guest']) expect(expectError(await handler.handle({}, ctx(role))).kind, role).toBe('Authorization');
    store.failFindWith = { kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'down' };
    expect(expectError(await handler.handle({}, ctx())).code).toBe('STORE_UNAVAILABLE');
  });

  describe('a practice run left alone is finished for the learner (M8-36, D116)', () => {
    const START = '2026-11-01T09:00:00.000Z';
    const RUN = { mode: 'practice' as const, formId: null, sessionRef: null, shiftId: null, durationMs: null, windowClosesAt: null, deliveryPolicy: { timing: 'untimed', navigation: 'free', pausable: true } };
    const IDLE_LONG_ENOUGH = new Date(Date.parse(START) + PRACTICE_IDLE_MS).toISOString();

    async function withRun(now: string, activity?: string) {
      const store = new InMemoryAttempts();
      const run = anAttempt({ attemptId: id(TAG.attempt, 7), studentId: id(TAG.student, 7), ...RUN });
      store.stored.set(run.attemptId, expectValue(startAttempt(run, START)));
      if (activity !== undefined) store.lastActivity.set(run.attemptId, activity);
      const handler = new SubmitExpiredAttemptsHandler({ attempts: store, clock: { now: () => new Date(now) }, audit: { record: async () => undefined } });
      return { handler, store, events: store.events, run };
    }

    it('submits it as an expiry, announcing the practice event and not the paper\'s, which names a form it has not got', async () => {
      const { handler, store, events, run } = await withRun(IDLE_LONG_ENOUGH);
      const report = expectValue(await handler.handle({}, ctx()));
      expect(report).toMatchObject({ submitted: 1, runsFinished: 1, skipped: [] });
      expect(store.stored.get(run.attemptId)!.submission).toEqual({ reason: 'expiry', idempotencyKey: `expiry:${run.attemptId}`, submittedAt: IDLE_LONG_ENOUGH });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ eventType: 'PracticeAttemptSubmitted', payload: { attemptId: run.attemptId, reason: 'expiry' } });
      expect(events[0]!.payload).not.toHaveProperty('formId');
    });

    it('leaves a run alone for as long as it is active: the time is since the server last heard from it, not since it began', async () => {
      const recent = new Date(Date.parse(IDLE_LONG_ENOUGH) - 60_000).toISOString();
      const active = await withRun(IDLE_LONG_ENOUGH, recent);
      expect(expectValue(await active.handler.handle({}, ctx()))).toMatchObject({ submitted: 0, runsFinished: 0 });
      expect(active.store.stored.get(active.run.attemptId)!.state).toBe('in_progress');
      // and one instant before the cutoff is still within it, while the cutoff itself is not
      const edge = await withRun(IDLE_LONG_ENOUGH, new Date(Date.parse(IDLE_LONG_ENOUGH) - PRACTICE_IDLE_MS + 1).toISOString());
      expect(expectValue(await edge.handler.handle({}, ctx())).runsFinished).toBe(0);
      const gone = await withRun(IDLE_LONG_ENOUGH, new Date(Date.parse(IDLE_LONG_ENOUGH) - PRACTICE_IDLE_MS).toISOString());
      expect(expectValue(await gone.handler.handle({}, ctx())).runsFinished).toBe(1);
    });

    it('waits forty-eight hours, to the millisecond: a run last heard from at the cutoff is finished and one heard from a moment later is not', async () => {
      expect(PRACTICE_IDLE_MS).toBe(48 * 3_600_000);
      const heard = '2026-11-01T09:00:00.000Z';
      const justShort = await withRun('2026-11-03T08:59:59.999Z', heard);
      expect(expectValue(await justShort.handler.handle({}, ctx())).runsFinished).toBe(0);
      const there = await withRun('2026-11-03T09:00:00.000Z', heard);
      expect(expectValue(await there.handler.handle({}, ctx())).runsFinished).toBe(1);
    });

    it('a second sweep finds nothing left of it', async () => {
      const { handler, events } = await withRun(IDLE_LONG_ENOUGH);
      await handler.handle({}, ctx());
      expect(expectValue(await handler.handle({}, ctx()))).toMatchObject({ submitted: 0, runsFinished: 0 });
      expect(events).toHaveLength(1);
    });

    it('sweeps a mock whose deadline passed and a run left alone together, each announcing its own event, so a paper still reaches the consumer for papers', async () => {
      const store = new InMemoryAttempts();
      const mock = anAttempt({ attemptId: id(TAG.attempt, 1), studentId: id(TAG.student, 1) });
      store.stored.set(mock.attemptId, expectValue(startAttempt(mock, '2026-10-21T09:00:00.000Z')));
      const run = anAttempt({ attemptId: id(TAG.attempt, 7), studentId: id(TAG.student, 7), ...RUN });
      store.stored.set(run.attemptId, expectValue(startAttempt(run, '2026-10-21T09:00:00.000Z')));
      const handler = new SubmitExpiredAttemptsHandler({ attempts: store, clock: { now: () => new Date('2026-11-01T09:00:00.000Z') }, audit: { record: async () => undefined } });
      const report = expectValue(await handler.handle({}, ctx()));
      expect(report).toMatchObject({ submitted: 2, runsFinished: 1 });
      expect(store.events.map((e) => [e.eventType, e.payload['attemptId']]).sort()).toEqual([['AttemptSubmitted', mock.attemptId], ['PracticeAttemptSubmitted', run.attemptId]].sort());
      expect(store.events.find((e) => e.eventType === 'AttemptSubmitted')!.payload).toHaveProperty('formId');
    });

    it('reports a store that cannot say which runs are idle, and one run that would not submit without stopping the rest', async () => {
      const { handler, store } = await withRun(IDLE_LONG_ENOUGH);
      const find = store.findIdlePracticeRuns.bind(store);
      store.findIdlePracticeRuns = async () => err({ kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'down' });
      expect(expectError(await handler.handle({}, ctx())).code).toBe('STORE_UNAVAILABLE');
      store.findIdlePracticeRuns = find;
      const original = store.save.bind(store);
      store.save = async () => err(conflictError('CONFLICT', 'the run moved', 'state'));
      expect(expectValue(await handler.handle({}, ctx()))).toMatchObject({ submitted: 0, runsFinished: 0 });
      store.save = original;
    });
  });
});
