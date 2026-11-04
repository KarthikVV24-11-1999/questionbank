import { clientEnvelopeSchema, findPii } from '@questionbank/contracts/analytics';
import { describe, expect, it } from 'vitest';
import { AnalyticsEdge } from '../../../../platform/analytics/edge.js';
import { ServerEmitter } from '../../../../platform/analytics/server-emitter.js';
import { MemorySink } from '../../../../platform/analytics/sink.js';
import { logEmission } from '../../../../testing/event-log.js';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../../platform/config/config.js';
import { TAG, id } from '../../../../testing/assessment-fixtures.js';
import type { Attempt } from '../../domain/attempt.js';
import { err, ok } from '../../domain/result.js';
import type { ResponseEvent } from '../../domain/response-event.js';
import { MockAttemptEventsConsumer } from './mock-attempt-events-consumer.js';
import { ScoringFailure } from './scoring-consumer.js';

const SUBMITTED_AT = '2026-11-05T11:00:00.000Z';
const slots = [1, 2, 3, 4].map((n) => ({ slotId: id(TAG.slot, n), itemVersionId: id(TAG.itemVersion, n), ordinal: n }));
const attempt = (reason: 'manual' | 'expiry' | 'recovered' = 'manual', over: Partial<Attempt> = {}): Attempt =>
  ({ attemptId: id(TAG.attempt, 1), studentId: id(TAG.student, 1), formId: id(TAG.form), examProfileVersionId: id(TAG.profile), state: 'submitted', intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS, slots, submission: { reason, submittedAt: SUBMITTED_AT, idempotencyKey: 'k' }, ...over }) as unknown as Attempt;
const response = (n: number, kind: 'select' | 'flag', slot: number, receivedAt: string, extra: Partial<ResponseEvent> = {}): ResponseEvent =>
  ({ eventId: id(TAG.event, n), attemptId: id(TAG.attempt, 1), slotId: slots[slot]!.slotId, itemVersionId: slots[slot]!.itemVersionId, sequence: n, kind, ...(kind === 'select' ? { answer: 'b' } : {}), clientMonotonicMs: n * 1_000, serverReceivedAt: receivedAt, deviceRef: 'd', afterSubmission: false, ...extra }) as ResponseEvent;

function rig(over: { attempt?: Attempt; log?: ResponseEvent[]; observe?: typeof logEmission | null } = {}) {
  const sink = new MemorySink();
  const edge = new AnalyticsEdge(sink, () => new Date('2026-11-05T12:00:00.000Z'));
  const emitter = new ServerEmitter({ edge, appVersion: 'api', ...(over.observe === null ? {} : { observe: over.observe ?? logEmission }) });
  const consumer = new MockAttemptEventsConsumer({ attempts: { findById: async () => ok(over.attempt ?? attempt()) }, responses: { findByAttempt: async () => ok(over.log ?? []) }, events: emitter });
  const deliver = () => consumer.handle({ messageId: 'm', correlationId: 'c', payload: { attemptId: id(TAG.attempt, 1) } });
  return { sink, edge, deliver, consumer };
}

describe('saying that a mock attempt was submitted (M8-54)', () => {
  it('emits mock.attempt_submitted as a valid server envelope for the learner, with the counts and the mode, and no personal data in it', async () => {
    const log = [response(1, 'select', 0, '2026-11-05T10:58:00.000Z'), response(2, 'select', 1, '2026-11-05T10:59:30.000Z'), response(3, 'flag', 1, '2026-11-05T10:59:40.000Z')];
    const { sink, edge, deliver } = rig({ log });
    await deliver();
    expect(sink.events).toHaveLength(1);
    const { received_at: _stamp, ...built } = sink.events[0]!;
    expect(clientEnvelopeSchema.safeParse(built).success).toBe(true);
    expect(sink.events[0]).toMatchObject({
      event_name: 'mock.attempt_submitted',
      surface: 'server',
      actor: { kind: 'human', pseudonymous_id: id(TAG.student, 1) },
      occurred_at: SUBMITTED_AT,
      context: { attempt_id: id(TAG.attempt, 1) },
      payload: { submission_mode: 'manual', answered: 2, unanswered: 2, flagged: 1, sync_lag_ms: 20_000 },
    });
    expect(findPii(sink.events)).toEqual([]);
    expect(edge.stats()).toMatchObject({ accepted: 1, quarantined: { UNKNOWN_EVENT_NAME: 0, INVALID_ENVELOPE: 0, PII: 0 } });
  });

  it('names the three ways a submission can be made, as the taxonomy does', async () => {
    const modes: string[] = [];
    for (const reason of ['manual', 'expiry', 'recovered'] as const) {
      const { sink, deliver } = rig({ attempt: attempt(reason), observe: null });
      await deliver();
      modes.push((sink.events[0]!.payload as { submission_mode: string }).submission_mode);
    }
    expect(modes).toEqual(['manual', 'auto_expiry', 'recovered']);
  });

  it('counts an answer that was cleared as unanswered, and a skip as still holding its answer, by the log\'s own projection', async () => {
    const log = [response(1, 'select', 0, '2026-11-05T10:58:00.000Z'), response(2, 'select', 1, '2026-11-05T10:58:10.000Z'), { ...response(3, 'select', 1, '2026-11-05T10:58:20.000Z'), kind: 'clear', answer: undefined } as unknown as ResponseEvent];
    const { sink, deliver } = rig({ log, observe: null });
    await deliver();
    expect(sink.events[0]!.payload).toMatchObject({ answered: 1, unanswered: 3 });
  });

  it('takes no account of what arrived after the submission when it measures the lag, and says 0 when nothing was received', async () => {
    const late = response(2, 'select', 1, '2026-11-05T11:30:00.000Z', { afterSubmission: true });
    const first = rig({ log: [response(1, 'select', 0, '2026-11-05T10:59:59.000Z'), late], observe: null });
    await first.deliver();
    expect((first.sink.events[0]!.payload as { sync_lag_ms: number }).sync_lag_ms).toBe(1_000);
    const none = rig({ log: [], observe: null });
    await none.deliver();
    expect(none.sink.events[0]!.payload).toMatchObject({ answered: 0, unanswered: 4, flagged: 0, sync_lag_ms: 0 });
  });

  it('never reports a negative lag, whatever the clocks say', async () => {
    const { sink, deliver } = rig({ log: [response(1, 'select', 0, '2026-11-05T11:00:05.000Z')], observe: null });
    await deliver();
    expect((sink.events[0]!.payload as { sync_lag_ms: number }).sync_lag_ms).toBe(0);
  });

  it('counts an attempt once when the relay delivers it twice: the event\'s id is the attempt\'s', async () => {
    const { sink, edge, deliver } = rig({ observe: null });
    await deliver();
    await deliver();
    expect(sink.events).toHaveLength(1);
    expect(edge.stats()).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it('fails, naming why, for a message that names no attempt, an attempt that is not there, one not submitted, and a practice run', async () => {
    const consumerOf = (attemptResult: unknown, logResult: unknown = ok([])) => new MockAttemptEventsConsumer({ attempts: { findById: async () => attemptResult as never }, responses: { findByAttempt: async () => logResult as never }, events: { emit: async () => undefined } });
    const envelope = { messageId: 'm', correlationId: 'c', payload: { attemptId: id(TAG.attempt, 1) } };
    await expect(consumerOf(ok(attempt())).handle({ ...envelope, payload: {} })).rejects.toThrow('PAYLOAD_INVALID');
    await expect(consumerOf(err({ code: 'NOT_FOUND', message: 'no such attempt' })).handle(envelope)).rejects.toThrow('NOT_FOUND');
    await expect(consumerOf(ok(attempt('manual', { submission: null, state: 'in_progress' } as never))).handle(envelope)).rejects.toThrow('ATTEMPT_NOT_SUBMITTED');
    await expect(consumerOf(ok(attempt('manual', { formId: null } as never))).handle(envelope)).rejects.toThrow('ATTEMPT_IS_NOT_ON_A_FORM');
    await expect(consumerOf(ok(attempt()), err({ code: 'DOWN', message: 'database is down' })).handle(envelope)).rejects.toBeInstanceOf(ScoringFailure);
  });
});
