import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, anAttempt, id } from '../../../testing/assessment-fixtures.js';
import { startAttempt, submitAttempt } from '../domain/attempt.js';
import { err, ok } from '../domain/result.js';
import { notFoundError, unavailableError } from '../domain/assessment-error.js';
import type { ResponseEvent } from '../domain/response-event.js';
import { GetResponseTimingsHandler } from './handlers/response-timing-handler.js';

const system = { principal: { kind: 'system' as const, id: id(TAG.student, 9), roleContext: ['system'] }, correlationId: 'c' };
const created = anAttempt();
const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
const submitted = expectValue(submitAttempt(started, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z'));

const event = (afterSubmission = false): ResponseEvent => ({
  eventId: id(TAG.event, 1),
  attemptId: created.attemptId,
  slotId: created.slots[0]!.slotId,
  itemVersionId: created.slots[0]!.itemVersionId,
  sequence: 1,
  kind: 'select',
  answer: 'B',
  clientMonotonicMs: 1000,
  serverReceivedAt: '2026-10-21T09:30:00.000Z',
  deviceRef: 'd',
  afterSubmission,
});

function handler(attempt: ReturnType<typeof anAttempt> | 'missing' | 'unreachable', events: 'unreachable' | ResponseEvent[] = [event()]) {
  return new GetResponseTimingsHandler({
    attempts: {
      findById: async () =>
        attempt === 'missing' ? err(notFoundError('NOT_FOUND', 'no attempt')) : attempt === 'unreachable' ? err(unavailableError('STORE_UNAVAILABLE', 'down')) : ok(attempt),
    } as never,
    responses: { findByAttempt: async () => (events === 'unreachable' ? err(unavailableError('STORE_UNAVAILABLE', 'down')) : ok(events)) } as never,
  });
}

describe('GetResponseTimings', () => {
  it('is the system\'s alone', async () => {
    expect(handler(submitted).policy.allowedRoles).toEqual(['system']);
    const learner = { principal: { kind: 'human' as const, id: id(TAG.student), roleContext: ['learner'] }, correlationId: 'c' };
    expect(expectError(await handler(submitted).handle({ attemptId: created.attemptId }, learner)).kind).toBe('Authorization');
  });

  it('answers a submitted attempt per slot, with the keys named and nothing else', async () => {
    const answer = expectValue(await handler(submitted).handle({ attemptId: created.attemptId }, system));
    expect(Object.keys(answer).sort()).toEqual(['learnerRef', 'slots']);
    expect(answer.learnerRef).toBe(created.studentId);
    const views = answer.slots;
    expect(views).toHaveLength(created.slots.length);
    expect(views[0]).toEqual({ slotRef: created.slots[0]!.slotId, itemVersionId: created.slots[0]!.itemVersionId, respondedAt: '2026-10-21T09:30:00.000Z', gaveUpAt: null, timeOnItemMs: 0, truncatedIntervals: 0, discardedMs: 0, unclosedVisits: 0 });
    expect(Object.keys(views[0]!).sort()).toEqual(['discardedMs', 'gaveUpAt', 'itemVersionId', 'respondedAt', 'slotRef', 'timeOnItemMs', 'truncatedIntervals', 'unclosedVisits']);
  });

  it('carries what the cap threw away, and the visits that never closed, to the view with each in its own field (M7-45)', async () => {
    const cap = created.intervalCapMs;
    const at = (n: number, kind: 'visit' | 'leave', ms: number): ResponseEvent => ({ ...event(), eventId: id(TAG.event, 10 + n), sequence: n + 1, kind, answer: null, clientMonotonicMs: ms });
    const events = [at(1, 'visit', 0), at(2, 'leave', cap + 7_000), at(3, 'visit', cap + 10_000), at(4, 'visit', cap + 20_000)];
    const views = expectValue(await handler(submitted, events).handle({ attemptId: created.attemptId }, system)).slots;
    expect(views[0]).toMatchObject({ timeOnItemMs: cap, truncatedIntervals: 1, discardedMs: 7_000, unclosedVisits: 2 });
  });

  it('refuses an attempt that is not submitted rather than answering part of a log still being written', async () => {
    for (const attempt of [created, started]) {
      expect(expectError(await handler(attempt).handle({ attemptId: created.attemptId }, system)).kind).toBe('PreconditionFailed');
    }
  });

  it('says not found for an attempt there is none of, and unavailable when either store is down', async () => {
    expect(expectError(await handler('missing').handle({ attemptId: created.attemptId }, system)).kind).toBe('NotFound');
    expect(expectError(await handler('unreachable').handle({ attemptId: created.attemptId }, system)).kind).toBe('Unavailable');
    expect(expectError(await handler(submitted, 'unreachable').handle({ attemptId: created.attemptId }, system)).kind).toBe('Unavailable');
  });
});
