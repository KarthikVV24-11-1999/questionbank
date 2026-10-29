import { randomUUID } from 'node:crypto';
import { clientEnvelopeSchema, findPii } from '@questionbank/contracts/analytics';
import { describe, expect, it } from 'vitest';
import { AnalyticsEdge } from '../analytics/edge.js';
import { ServerEmitter } from '../analytics/server-emitter.js';
import { MemorySink } from '../analytics/sink.js';
import { logEmission } from '../../testing/event-log.js';
import type { EvidenceSourceResult } from '../../contexts/learning/public/composition.js';
import { PermanentDeliveryFailure, type OutboxEnvelope } from '../outbox/relay.js';
import { LearningAttemptScoredConsumer, LearningDiagnosticReportConsumer } from './learning-consumer.js';

const envelope = (payload: Record<string, unknown> = { attemptId: randomUUID(), scoreRecordId: randomUUID() }): OutboxEnvelope => ({
  messageId: randomUUID(),
  eventType: 'AttemptScored',
  schemaVersion: 1,
  aggregateType: 'ScoreRecord',
  aggregateId: randomUUID(),
  payload,
  principal: { kind: 'system', id: randomUUID() },
  correlationId: 'corr-1',
  occurredAt: '2026-10-27T10:00:00.000Z',
  attempt: 1,
});

const assembled = (over: Partial<Extract<EvidenceSourceResult, { ok: true }>['value']> = {}): EvidenceSourceResult => ({ ok: true, value: { learnerRef: randomUUID(), evidence: [], notEvidence: 0, gaveUp: [], ...over } });

function consumer(source: EvidenceSourceResult, recorded: unknown = { ok: true, value: { recorded: 0, replayed: 0, maps: [], transitions: [], verified: [], gains: [] } }, analytics?: ServerEmitter) {
  const calls: { evidence?: unknown; command?: unknown; context?: unknown } = {};
  return {
    calls,
    consumer: new LearningAttemptScoredConsumer({
      ...(analytics === undefined ? {} : { analytics }),
      evidence: {
        evidenceForScoredAttempt: async (attempt) => {
          calls.evidence = attempt;
          return source;
        },
      },
      learning: {
        recordEvidence: {
          handle: async (command: unknown, context: unknown) => {
            calls.command = command;
            calls.context = context;
            return recorded;
          },
        } as never,
        generateReport: { handle: async () => ({ ok: true, value: { reportId: null, created: false, findings: [] } }) } as never,
      },
    }),
  };
}

const rejection = async (promise: Promise<unknown>): Promise<unknown> => promise.then(() => undefined, (error: unknown) => error);

describe('the consumer of AttemptScored', () => {
  it('hears a superseded score the way it hears a first one: the attempt and a score record, the evidence read from the owning contexts at delivery (D72)', async () => {
    const { consumer: c, calls } = consumer(assembled());
    const message = { ...envelope({ attemptId: randomUUID(), scoreRecordId: randomUUID(), supersededScoreRecordId: randomUUID(), generation: 2, rescoringOperationId: randomUUID() }), eventType: 'AttemptScoreSuperseded' };
    await c.handle(message);
    expect(calls.evidence).toMatchObject({ attemptId: message.payload['attemptId'], scoreRecordId: message.payload['scoreRecordId'] });
    expect(calls.command).toMatchObject({ attemptRef: message.payload['attemptId'] });
  });

  it('asks for the evidence of the scored attempt, dated by the event, and records it for the learner the evidence names', async () => {
    const learner = randomUUID();
    const { consumer: c, calls } = consumer(assembled({ learnerRef: learner }));
    const message = envelope();
    await c.handle(message);
    expect(calls.evidence).toEqual({ attemptId: message.payload['attemptId'], scoreRecordId: message.payload['scoreRecordId'], scoredAt: '2026-10-27T10:00:00.000Z' });
    expect(calls.command).toMatchObject({ learnerRef: learner, evidence: [], attemptRef: message.payload['attemptId'] });
    expect(calls.context).toMatchObject({ principal: { kind: 'system', roleContext: ['system'] }, correlationId: 'corr-1' });
  });

  it('retries a source that is unavailable: an ordinary failure, which the relay backs off and tries again', async () => {
    const error = await rejection(consumer({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'content could not be read' } }).consumer.handle(envelope()));
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(PermanentDeliveryFailure);
    expect((error as Error).message).toContain('SOURCE_UNAVAILABLE');
  });

  it('dead-letters, at once, every cause that retrying cannot mend', async () => {
    const causes: EvidenceSourceResult[] = [
      { ok: false, error: { code: 'ITEM_VERSION_UNRESOLVED', message: 'no published version', itemVersionIds: ['v1'] } },
      { ok: false, error: { code: 'ATTEMPT_NOT_SCORED', message: 'no score record' } },
      { ok: false, error: { code: 'RESPONSE_INSTANT_UNRESOLVED', message: 'no response standing', slotRefs: ['s1'] } },
    ];
    for (const cause of causes) {
      const error = await rejection(consumer(cause).consumer.handle(envelope()));
      expect(error, JSON.stringify(cause)).toBeInstanceOf(PermanentDeliveryFailure);
      expect((error as Error).message).toContain((cause as { error: { code: string } }).error.code);
    }
  });

  it('dead-letters a message that is not an AttemptScored: no attempt, no score record, or not text', async () => {
    for (const payload of [{}, { attemptId: 'a' }, { scoreRecordId: 's' }, { attemptId: '', scoreRecordId: 's' }, { attemptId: 'a', scoreRecordId: '' }, { attemptId: 7, scoreRecordId: 's' }]) {
      expect(await rejection(consumer(assembled()).consumer.handle(envelope(payload))), JSON.stringify(payload)).toBeInstanceOf(PermanentDeliveryFailure);
    }
  });

  it('retries a ledger that is unavailable and dead-letters any other refusal of the recorder', async () => {
    const unavailable = { ok: false, error: { kind: 'Unavailable', code: 'LEDGER_UNAVAILABLE', message: 'down' } };
    const retried = await rejection(consumer(assembled(), unavailable).consumer.handle(envelope()));
    expect(retried).toBeInstanceOf(Error);
    expect(retried).not.toBeInstanceOf(PermanentDeliveryFailure);

    const missing = { ok: false, error: { kind: 'NotFound', code: 'NO_RULE_SET', message: 'none' } };
    expect(await rejection(consumer(assembled(), missing).consumer.handle(envelope()))).toBeInstanceOf(PermanentDeliveryFailure);
  });
});

describe('the north-star event, emitted by the delivery that verified the gain (M7-62)', () => {
  const gain = { transitionId: randomUUID(), taxonomyVersionId: randomUUID(), conceptIdentityId: randomUUID(), promotedAt: '2026-10-01T10:00:00.000Z', verifiedAt: '2026-10-04T22:00:00.000Z', evidenceCount: 10 };
  const recordedWith = (gains: unknown[]) => ({ ok: true, value: { recorded: 2, replayed: 0, maps: [], transitions: [], verified: [], gains } });
  const rig = (sink = new MemorySink(), observe: typeof logEmission | null = logEmission) => {
    const edge = new AnalyticsEdge(sink, () => new Date('2026-10-29T09:00:00.000Z'));
    return { sink, edge, analytics: new ServerEmitter({ edge, appVersion: 'api', ...(observe === null ? {} : { observe }) }) };
  };

  it('emits mastery.gain_verified for the learner, a valid envelope with the concept, the days it took and the responses behind it', async () => {
    const learner = randomUUID();
    const { sink, edge, analytics } = rig();
    await consumer(assembled({ learnerRef: learner }), recordedWith([gain]), analytics).consumer.handle(envelope());
    expect(sink.events).toHaveLength(1);
    const event = sink.events[0]!;
    expect(clientEnvelopeSchema.safeParse({ ...event, received_at: undefined }).success).toBe(false); // strict: the stamp is the edge's, not part of what an emitter builds
    const { received_at: _stamp, ...built } = event;
    expect(clientEnvelopeSchema.safeParse(built).success).toBe(true);
    expect(event).toMatchObject({
      event_name: 'mastery.gain_verified',
      occurred_at: gain.verifiedAt,
      received_at: '2026-10-29T09:00:00.000Z',
      actor: { kind: 'human', pseudonymous_id: learner },
      surface: 'server',
      context: { concept_identity_id: gain.conceptIdentityId },
      payload: { concept_identity_id: gain.conceptIdentityId, days_to_verify: 3.5, evidence_count: 10 },
    });
    expect(edge.stats()).toMatchObject({ accepted: 1, quarantined: { UNKNOWN_EVENT_NAME: 0, INVALID_ENVELOPE: 0, PII: 0 } });
  });

  it('carries no personal data in the event it emits', async () => {
    const { sink, analytics } = rig();
    await consumer(assembled(), recordedWith([gain]), analytics).consumer.handle(envelope());
    expect(sink.events).toHaveLength(1);
    expect(findPii(sink.events)).toEqual([]);
  });

  it('refuses the same event with an email for its actor, so the scan sees it', async () => {
    // planted on purpose, and so not logged as an emission
    const { sink, edge, analytics } = rig(new MemorySink(), null);
    await consumer(assembled({ learnerRef: 'asha.verma@example.com' }), recordedWith([gain]), analytics).consumer.handle(envelope());
    expect(sink.events).toEqual([]);
    expect(edge.stats().quarantined.PII + edge.stats().quarantined.INVALID_ENVELOPE).toBe(1);
  });

  it('counts a gain once when the relay delivers the message twice: the event id is the transition\'s', async () => {
    const { sink, edge, analytics } = rig();
    const c = consumer(assembled(), recordedWith([gain]), analytics).consumer;
    await c.handle(envelope());
    await c.handle(envelope());
    expect(sink.events).toHaveLength(1);
    expect(edge.stats()).toMatchObject({ accepted: 1, duplicates: 1 });
  });

  it('emits nothing for a delivery that verified no gain', async () => {
    const { sink, analytics } = rig();
    await consumer(assembled(), recordedWith([]), analytics).consumer.handle(envelope());
    expect(sink.events).toEqual([]);
  });
});

describe('the consumer of the diagnostic report (M7-42)', () => {
  const slots = (result: unknown) => ({ slotsForScoredAttempt: async () => result as never });
  const reporter = (source: unknown, generated: unknown = { ok: true, value: { reportId: randomUUID(), created: true, findings: [] } }) => {
    const seen: unknown[] = [];
    return {
      seen,
      consumer: new LearningDiagnosticReportConsumer({
        slots: slots(source),
        learning: { generateReport: { handle: async (command: unknown) => (seen.push(command), generated) } } as never,
      }),
    };
  };
  const found = { ok: true, value: { learnerRef: 'learner-1', slots: [] } };

  it('makes the report for the attempt and the score record the message names, for the learner the slots name', async () => {
    const { consumer: c, seen } = reporter(found);
    const message = envelope();
    await c.handle(message);
    expect(seen).toEqual([{ learnerRef: 'learner-1', attemptRef: message.payload['attemptId'], scoreRecordRef: message.payload['scoreRecordId'], slots: [] }]);
  });

  it('dead-letters a message that names no attempt, and a source that says retrying will not help; retries one that is unavailable', async () => {
    expect(await rejection(reporter(found).consumer.handle(envelope({})))).toBeInstanceOf(PermanentDeliveryFailure);
    expect(await rejection(reporter({ ok: false, error: { code: 'ATTEMPT_NOT_SCORED', message: 'no' } }).consumer.handle(envelope()))).toBeInstanceOf(PermanentDeliveryFailure);
    const retried = await rejection(reporter({ ok: false, error: { code: 'SOURCE_UNAVAILABLE', message: 'down' } }).consumer.handle(envelope()));
    expect(retried).toBeInstanceOf(Error);
    expect(retried).not.toBeInstanceOf(PermanentDeliveryFailure);
  });

  it('retries a store that is unavailable and dead-letters any other refusal', async () => {
    const down = await rejection(reporter(found, { ok: false, error: { kind: 'Unavailable', code: 'REPORT_STORE_UNAVAILABLE', message: 'x' } }).consumer.handle(envelope()));
    expect(down).not.toBeInstanceOf(PermanentDeliveryFailure);
    expect(await rejection(reporter(found, { ok: false, error: { kind: 'Authorization', code: 'NOT_PERMITTED', message: 'x' } }).consumer.handle(envelope()))).toBeInstanceOf(PermanentDeliveryFailure);
  });
});
