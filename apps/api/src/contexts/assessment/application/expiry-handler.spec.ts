import { describe, expect, it } from 'vitest';
import { startAttempt } from '../domain/attempt.js';
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
    expect(report).toEqual({ asOf: '2026-10-21T12:00:00.000Z', submitted: 1, skipped: [] });
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
});
