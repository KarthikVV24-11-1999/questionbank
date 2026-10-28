import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { InMemoryIdempotencyStore } from '../../contexts/content/application/ports.js';
import { contentForLearning } from '../../contexts/content/public/composition.js';
import { createAnswerKey } from '../../contexts/scoring/domain/answer-key.js';
import { DEFAULT_AGGREGATION } from '../../contexts/scoring/domain/aggregation-data.js';
import { createScoringInput, type CreateScoredSlot } from '../../contexts/scoring/domain/scoring-input.js';
import { scoringForAssessment, scoringForLearning } from '../../contexts/scoring/public/composition.js';
import type { ScoreAttempt } from '../../contexts/scoring/public/index.js';
import { createMediaStore } from '../persistence/filesystem-media-store.js';
import { JEE_MAIN_RULE_SET } from '../../testing/marking-fixtures.js';
import { itemContent, publishItem, uuid } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectValue } from '../../testing/expect-result.js';
import { assessmentForLearning } from '../../contexts/assessment/public/composition.js';
import { PostgresAttemptRepository } from '../../contexts/assessment/infrastructure/attempt.repository.js';
import { PostgresResponseLog } from '../../contexts/assessment/infrastructure/response-log.repository.js';
import { startAttempt, submitAttempt } from '../../contexts/assessment/domain/attempt.js';
import { acceptResponseEvent } from '../../contexts/assessment/domain/response-event.js';
import { TAG, anAttempt, formProps, id } from '../../testing/assessment-fixtures.js';
import { storeActiveForm } from '../../testing/assessment-store.js';
import { ScoredAttemptEvidenceSource, scoredAttemptOf, type ScoredAttemptEvent } from './learning-evidence.js';
import { learningForRelay } from '../../contexts/learning/public/composition.js';
import { OutboxRelay, type OutboxConsumer, type OutboxEnvelope } from '../outbox/relay.js';
import { LearningAttemptScoredConsumer } from './learning-consumer.js';
import { createApplication } from './app-factory.js';
import { PostgresScoreRecordRepository } from '../../contexts/scoring/infrastructure/score-record.repository.js';
import { PostgresRescoringOperationRepository } from '../../contexts/scoring/infrastructure/rescoring-operation.repository.js';
import { ApproveRescoringHandler, DraftRescoringHandler, ExecuteRescoringHandler, RunRescoringDryRunHandler } from '../../contexts/scoring/application/handlers/rescoring-handlers.js';
import { BACKGROUND, type Background } from './background.js';
import { createRecordingTelemetry } from '../observability/recording-telemetry.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { uuidFactory } from '../../testing/generation-context.js';

/**
 * A scored attempt in, the evidence rows out (M7-05): real Postgres, items published through content's own handlers, scored by
 * the real handler — whose event is written in the score's transaction (M7-01) — and read back through the two seams.
 */
let database: TestDatabase;
let source: ScoredAttemptEvidenceSource;
let base: { pool: TestDatabase['pool']; clock: { now(): Date }; identifiers: { next(): string }; audit: { record(): Promise<undefined> }; principals: { resolve(): null } };
let learning: ReturnType<typeof learningForRelay>;
let score: ReturnType<typeof scoringForAssessment>['scoreAttempt'];

const HASH = '4fe24605633c';
const clock = { now: () => new Date('2026-10-27T10:00:00.000Z') };
const identifiers = { next: () => randomUUID() };
const audit = { record: async () => undefined };
const principals = { resolve: () => null };
const system = { principal: { kind: 'system' as const, id: uuid(), roleContext: ['system'] }, correlationId: 'c' };
const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  base = { pool: database.pool, clock, identifiers, audit: audit as never, principals };
  learning = learningForRelay(base);
  score = scoringForAssessment(base).scoreAttempt;
  source = new ScoredAttemptEvidenceSource({
    scoring: scoringForLearning(base),
    assessment: assessmentForLearning(base),
    content: contentForLearning({
      ...base,
      mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
      idempotency: new InMemoryIdempotencyStore(),
      reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
    }),
  });
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const TAXONOMY = randomUUID();
const tag = (conceptIdentityId: string, weight: number, isPrimary: boolean) => ({ conceptIdentityId, taxonomyVersionId: TAXONOMY, weight, isPrimary });

async function published(stem: string, difficulty: 'foundational' | 'advanced', tags: ReturnType<typeof tag>[]) {
  const item = await publishItem(database.pool, { ...itemContent(stem, difficulty), taxonomyTags: tags });
  return item.versions[0]!.versionId;
}

/** One thing the learner did, at the instant the server heard it. `late` is sent after the attempt was submitted. */
interface Did {
  readonly slot: number;
  readonly kind: 'select' | 'change' | 'clear';
  readonly answer?: string;
  readonly at: string;
  readonly late?: boolean;
}

const SUBMITTED_AT = '2026-10-21T10:00:00.000Z';
let attemptCounter = 0;

/**
 * A mock really sat in assessment's tables — a stored active form, an attempt on it, responses at known server instants, a submission — and then
 * really scored: the answers scoring is given are the ones that counted (not the late ones), as the scoring consumer reads them from the log.
 */
async function sat(versions: string[], did: Did[]): Promise<{ attemptId: string; event: ScoredAttemptEvent; rescoreWith(keys: Map<number, typeof key>): ScoreAttempt }> {
  attemptCounter += 1;
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.anchor_pool_member, assessment.response_event, assessment.attempt_slot, assessment.attempt, assessment.form_slot, assessment.form_section, assessment.form CASCADE');
  const slots = versions.map((itemVersionId, i) => ({ slotId: id(TAG.slot, i + 1), ordinal: i + 1, itemId: id(TAG.item, i + 1), itemVersionId, stimulusVersionId: null }));
  await storeActiveForm(database.pool, {
    blueprintConformance: { satisfied: true, sections: 1 },
    sections: [{ ordinal: 1, sectionSpecRef: 'physics-a', slots: slots.map((slot, i) => ({ ...slot, marksAvailable: 4, isAnchor: i === 0 })) }],
  });
  const attemptId = id(TAG.attempt, 100 + attemptCounter);
  const attempts = new PostgresAttemptRepository(database.pool);
  const log = new PostgresResponseLog(database.pool);

  const created = anAttempt({ attemptId, slots, studentId: id(TAG.student, 100 + attemptCounter) });
  expectValue(await attempts.create(created));
  const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
  expectValue(await attempts.save(started, 'created'));

  let sequence = 0;
  const send = async (attempt: typeof started, step: Did) => {
    sequence += 1;
    const draft = { eventId: id(TAG.event, 1000 * attemptCounter + sequence), attemptId, slotId: slots[step.slot]!.slotId, sequence, kind: step.kind, answer: step.kind === 'clear' ? null : step.answer!, clientMonotonicMs: sequence * 1000, deviceRef: 'd' };
    expectValue(await log.append(expectValue(acceptResponseEvent(attempt, draft, step.at))));
  };
  for (const step of did.filter((d) => d.late !== true)) await send(started, step);
  const submitted = expectValue(submitAttempt(started, { reason: 'manual', idempotencyKey: `k${attemptCounter}` }, SUBMITTED_AT));
  expectValue(await attempts.save(submitted, 'in_progress'));
  for (const step of did.filter((d) => d.late === true)) await send(submitted, step);

  // what stood at submission, per slot, among the answers that counted
  const stood = new Map<number, string | undefined>();
  for (const step of did.filter((d) => d.late !== true)) stood.set(step.slot, step.kind === 'clear' ? undefined : step.answer);
  const commandWith = (keys: Map<number, typeof key>): ScoreAttempt => ({
    input: expectValue(
      createScoringInput({
        attemptId,
        pin: { examProfileVersionId: randomUUID(), markingRuleSetHash: HASH, ruleSchemaVersion: 1, taxonomyVersionId: TAXONOMY, itemVersionIds: versions },
        sections: [{ ordinal: 1, slots: versions.map((itemVersionId, i) => ({ ...slot(i + 1, itemVersionId, stood.get(i)), slotId: slots[i]!.slotId, answerKey: keys.get(i) ?? key })) }],
        overrides: [],
      }),
    ),
    ruleSet: JEE_MAIN_RULE_SET,
    ruleSetHash: HASH,
    aggregation: DEFAULT_AGGREGATION,
    idempotencyKey: attemptId,
  });
  const command = commandWith(new Map());
  const record = expectValue(await score.handle(command, system));
  // the event as the relay would hand it on: read back from the outbox, not rebuilt
  const row = (await database.pool.query('SELECT payload, occurred_at FROM platform.outbox_message WHERE aggregate_id = $1', [record.scoreRecordId])).rows[0];
  return { attemptId, event: { payload: row.payload, occurredAt: row.occurred_at }, rescoreWith: commandWith };
}

function slot(n: number, itemVersionId: string, chosen: string | undefined): CreateScoredSlot {
  return {
    slotId: `s${n}`,
    ordinal: n,
    itemType: 'SINGLE_CORRECT_MCQ',
    itemVersionId,
    marksAvailable: 4,
    answerKey: key,
    ...(chosen === undefined ? {} : { response: { kind: 'OPTION_SELECTION' as const, optionIds: [chosen] } }),
  };
}

const T = (hhmm: string) => `2026-10-21T${hhmm}:00.000Z`;

describe('a sat and scored attempt becomes evidence for each item\'s primary concept, dated by the response', () => {
  it('counts one piece of evidence per response, for the primary concept only, whatever the secondary tags weigh', async () => {
    const [primaryA, secondary1, secondary2, primaryB] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
    const three = await published('An item carrying three tags, one of them primary.', 'advanced', [tag(primaryA, 0.1, true), tag(secondary1, 0.9, false), tag(secondary2, 0.8, false)]);
    const plain = await published('An item carrying one tag.', 'foundational', [tag(primaryB, 1, true)]);
    const skipped = await published('An item the learner left alone.', 'foundational', [tag(randomUUID(), 1, true)]);

    const { attemptId, event } = await sat([three, plain, skipped], [
      { slot: 0, kind: 'select', answer: 'B', at: T('09:05') },
      { slot: 1, kind: 'select', answer: 'A', at: T('09:20') },
    ]);
    const result = await source.evidenceForScoredAttempt(scoredAttemptOf(event));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.notEvidence).toBe(1);
    // two responses, two rows: the three-tag item yields one row, for its primary, and nothing for the other two
    expect(result.value.evidence).toHaveLength(2);
    expect(result.value.evidence.map((e) => [e.slotRef, e.conceptIdentityId, e.outcome, e.difficultyEstimate])).toEqual([
      [id(TAG.slot, 1), primaryA, 'correct', 'advanced'],
      [id(TAG.slot, 2), primaryB, 'incorrect', 'foundational'],
    ]);
    const concepts = result.value.evidence.map((e) => e.conceptIdentityId);
    expect(concepts).not.toContain(secondary1);
    expect(concepts).not.toContain(secondary2);
    expect(result.value.evidence.every((e) => e.attemptRef === attemptId && e.taxonomyVersionId === TAXONOMY)).toBe(true);
    expect(result.value.evidence.map((e) => e.itemVersionRef)).toEqual([three, plain]);
  });

  it('dates each response by the instant it was given: more than one distinct occurredAt in one attempt, and the score\'s instant kept apart', async () => {
    const [a, b, c] = [await published('First item for timing.', 'foundational', [tag(randomUUID(), 1, true)]), await published('Second item for timing.', 'foundational', [tag(randomUUID(), 1, true)]), await published('Third item for timing.', 'advanced', [tag(randomUUID(), 1, true)])];
    const { event } = await sat([a, b, c], [
      { slot: 0, kind: 'select', answer: 'B', at: T('09:05') },
      { slot: 1, kind: 'select', answer: 'A', at: T('09:20') },
      { slot: 2, kind: 'select', answer: 'B', at: T('09:41') },
    ]);
    const result = await source.evidenceForScoredAttempt(scoredAttemptOf(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence.map((e) => e.occurredAt)).toEqual([T('09:05'), T('09:20'), T('09:41')]);
    expect(new Set(result.value.evidence.map((e) => e.occurredAt)).size).toBeGreaterThan(1);
    // scored days later, once, for every slot: that is a different instant and is not what the evidence is dated by
    expect(new Set(result.value.evidence.map((e) => e.scoredAt))).toEqual(new Set(['2026-10-27T10:00:00.000Z']));
  });

  it('dates a changed answer by the change that stood, and ignores an event that reached the server after submission', async () => {
    const [a, b] = [await published('Changed item.', 'foundational', [tag(randomUUID(), 1, true)]), await published('Late item.', 'foundational', [tag(randomUUID(), 1, true)])];
    const { event } = await sat([a, b], [
      { slot: 0, kind: 'select', answer: 'A', at: T('09:05') },
      { slot: 0, kind: 'change', answer: 'B', at: T('09:30') },
      { slot: 1, kind: 'select', answer: 'B', at: T('09:10') },
      // sent after submission: recorded, excluded from scoring, and not evidence either
      { slot: 1, kind: 'change', answer: 'A', at: T('10:30'), late: true },
    ]);
    const result = await source.evidenceForScoredAttempt(scoredAttemptOf(event));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.evidence.map((e) => [e.outcome, e.occurredAt])).toEqual([['correct', T('09:30')], ['correct', T('09:10')]]);
    expect(result.value.evidence.map((e) => e.occurredAt)).not.toContain(T('10:30'));
  });

  it('fails the attempt whole, naming the version, when one item version is not one content published', async () => {
    const known = await published('A published item.', 'foundational', [tag(randomUUID(), 1, true)]);
    const draftless = randomUUID();
    const { event } = await sat([known, draftless], [
      { slot: 0, kind: 'select', answer: 'B', at: T('09:05') },
      { slot: 1, kind: 'select', answer: 'B', at: T('09:06') },
    ]);
    const result = await source.evidenceForScoredAttempt(scoredAttemptOf(event));
    expect(result).toMatchObject({ ok: false, error: { code: 'ITEM_VERSION_UNRESOLVED', itemVersionIds: [draftless] } });
  });

  it('says an attempt that was never scored is not scored', async () => {
    const result = await source.evidenceForScoredAttempt({ attemptId: randomUUID(), scoreRecordId: randomUUID(), scoredAt: '2026-10-27T10:00:00.000Z' });
    expect(result).toMatchObject({ ok: false, error: { code: 'ATTEMPT_NOT_SCORED' } });
  });
});


/**
 * Learning's consumer on the real relay (M7-16): a scored attempt becomes learning rows by being drained, and not by being called. The outbox is cleared first, so
 * a message from an earlier test is not drained into this one's counts.
 */
describe('a re-score reaches the learner through the composed relay (D72)', () => {
  const NOW = new Date('2026-10-27T10:00:30.000Z');
  const keyA = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'A' }));
  const admin = { principal: { kind: 'human' as const, id: uuid(), roleContext: ['admin'] }, correlationId: 'rescore', stepUpSatisfied: true };

  it('delivers the announcement of a superseded score, and the outcome Learning holds is corrected beside the one it first recorded', async () => {
    await database.pool.query('ALTER TABLE platform.outbox_message DISABLE TRIGGER outbox_message_event_immutable');
    await database.pool.query('DELETE FROM platform.outbox_message');
    await database.pool.query('ALTER TABLE platform.outbox_message ENABLE TRIGGER outbox_message_event_immutable');
    const [a, b] = [await published('Rescore item one.', 'foundational', [tag(randomUUID(), 1, true)]), await published('Rescore item two.', 'advanced', [tag(randomUUID(), 1, true)])];
    // slot 2 was answered A, and the key says B: incorrect — until a re-score finds the key was wrong
    const sitting = await sat([a, b], [{ slot: 0, kind: 'select', answer: 'B', at: T('09:05') }, { slot: 1, kind: 'select', answer: 'A', at: T('09:20') }]);

    const app = await createApplication(COMPOSED_CONFIG, { pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => NOW }, identifiers: uuidFactory });
    await app.init();
    try {
      const relay = app.get<Background>(BACKGROUND).relay;
      expect(await relay.drain(NOW)).toMatchObject({ delivered: 1, deadLettered: 0 });
      const outcomes = async () => (await database.pool.query(`SELECT e.slot_ref, COALESCE(c.outcome, e.outcome) AS now, e.outcome AS first FROM learning.mastery_evidence e LEFT JOIN LATERAL (SELECT outcome FROM learning.evidence_correction WHERE evidence_id = e.evidence_id ORDER BY correction_seq DESC LIMIT 1) c ON true WHERE e.attempt_ref = $1 ORDER BY e.slot_ref`, [sitting.attemptId])).rows;
      expect(await outcomes()).toEqual([{ slot_ref: expect.any(String), now: 'correct', first: 'correct' }, { slot_ref: expect.any(String), now: 'incorrect', first: 'incorrect' }]);

      const records = new PostgresScoreRecordRepository(database.pool);
      const operations = new PostgresRescoringOperationRepository(database.pool);
      const deps = { records, operations, clock: { now: () => NOW }, identifiers: { next: () => randomUUID() }, audit: { record: async () => undefined } };
      const corrected = [sitting.rescoreWith(new Map([[1, keyA]]))];
      const operation = expectValue(await new DraftRescoringHandler(deps).handle({ trigger: 'KEY_DEFECT_CONFIRMED', scope: 'ITEM_VERSION', scopeRef: b, reason: 'the key was wrong' }, admin));
      expectValue(await new RunRescoringDryRunHandler(deps).handle({ operationId: operation.operationId, attempts: corrected }, admin));
      expectValue(await new ApproveRescoringHandler(deps).handle({ operationId: operation.operationId }, admin));
      expectValue(await new ExecuteRescoringHandler(deps).handle({ operationId: operation.operationId, attempts: corrected }, admin));

      expect(await relay.drain(NOW)).toMatchObject({ delivered: 1, deadLettered: 0, retried: 0 });
      const [, second] = await outcomes();
      expect(second).toMatchObject({ first: 'incorrect', now: 'correct' });
      expect((await database.pool.query(`SELECT count(*)::int AS n FROM learning.evidence_correction`)).rows[0].n).toBe(1);
    } finally {
      await app.close();
    }
  });
});

describe('the relay delivers a scored attempt to learning', () => {
  const NOW = new Date('2026-10-27T10:00:30.000Z');
  const clearOutbox = async () => {
    await database.pool.query('ALTER TABLE platform.outbox_message DISABLE TRIGGER outbox_message_event_immutable');
    await database.pool.query('DELETE FROM platform.outbox_message');
    await database.pool.query('ALTER TABLE platform.outbox_message ENABLE TRIGGER outbox_message_event_immutable');
  };
  const relayWith = (consumer: OutboxConsumer) => new OutboxRelay(database.pool, new Map([['AttemptScored', [consumer]]]));
  const learningConsumer = (evidence = source) => new LearningAttemptScoredConsumer({ evidence, learning });
  const learningRows = async (table: string, learnerFilter = '') => (await database.pool.query(`SELECT count(*)::int AS n FROM learning.${table} ${learnerFilter}`)).rows[0].n as number;
  const envelopeOf = async (event: ScoredAttemptEvent & { payload: { scoreRecordId: string } }): Promise<OutboxEnvelope> => {
    const row = (await database.pool.query('SELECT * FROM platform.outbox_message WHERE aggregate_id = $1', [event.payload.scoreRecordId])).rows[0];
    return { messageId: row.outbox_message_id, eventType: row.event_type, schemaVersion: row.schema_version, aggregateType: row.aggregate_type, aggregateId: row.aggregate_id, payload: row.payload, principal: { kind: row.principal_kind, id: row.principal_id }, correlationId: row.correlation_id, occurredAt: row.occurred_at.toISOString(), attempt: 1 };
  };

  async function twoAnswered() {
    const [a, b, c] = [await published('Relay item one.', 'foundational', [tag(randomUUID(), 1, true)]), await published('Relay item two.', 'advanced', [tag(randomUUID(), 1, true)]), await published('Relay item three.', 'foundational', [tag(randomUUID(), 1, true)])];
    return sat([a, b, c], [
      { slot: 0, kind: 'select', answer: 'B', at: T('09:05') },
      { slot: 1, kind: 'select', answer: 'A', at: T('09:20') },
    ]);
  }

  it('drains an AttemptScored into the learner\'s evidence, dated by the responses, with a state for each concept', async () => {
    await clearOutbox();
    const { event } = await twoAnswered();
    const report = await relayWith(learningConsumer()).drain(NOW);
    expect(report).toMatchObject({ claimed: 1, delivered: 1, retried: 0, deadLettered: 0 });

    const rows = (await database.pool.query(`SELECT occurred_at, outcome FROM learning.mastery_evidence WHERE attempt_ref = (SELECT payload->>'attemptId' FROM platform.outbox_message WHERE aggregate_id = $1)::uuid ORDER BY occurred_at`, [event.payload.scoreRecordId])).rows;
    expect(rows.map((r) => [r.occurred_at.toISOString(), r.outcome])).toEqual([[T('09:05'), 'correct'], [T('09:20'), 'incorrect']]);
    expect((await database.pool.query(`SELECT published_at FROM platform.outbox_message WHERE event_type = 'AttemptScored'`)).rows[0].published_at).not.toBeNull();
  });

  it('has an effect once however often it is delivered: the same message again records nothing and recomputes nothing', async () => {
    await clearOutbox();
    const { event } = await twoAnswered();
    const message = await envelopeOf(event as never);
    const c = learningConsumer();
    await c.handle(message);
    const evidenceBefore = await learningRows('mastery_evidence');
    const statesBefore = (await database.pool.query('SELECT concept_identity_id, decay_applied_at FROM learning.concept_state ORDER BY concept_identity_id')).rows;
    await c.handle(message);
    await c.handle({ ...message, attempt: 3 });
    expect(await learningRows('mastery_evidence')).toBe(evidenceBefore);
    expect((await database.pool.query('SELECT concept_identity_id, decay_applied_at FROM learning.concept_state ORDER BY concept_identity_id')).rows).toEqual(statesBefore);
  });

  it('retries a delivery whose source is unavailable, writes nothing meanwhile, and delivers once the source is back', async () => {
    await clearOutbox();
    await twoAnswered();
    const down = new ScoredAttemptEvidenceSource({
      scoring: scoringForLearning(base as never),
      content: contentForLearning({ ...base, mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }), idempotency: new InMemoryIdempotencyStore(), reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 } }),
      assessment: { responseTimings: { handle: async () => ({ ok: false, error: { kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'down' } }) } } as never,
    });
    const before = await learningRows('mastery_evidence');
    const first = await relayWith(learningConsumer(down)).drain(NOW);
    expect(first).toMatchObject({ delivered: 0, retried: 1, deadLettered: 0 });
    expect(await learningRows('mastery_evidence')).toBe(before);
    const row = (await database.pool.query(`SELECT dead_at, retry_at, last_error FROM platform.outbox_message WHERE event_type = 'AttemptScored'`)).rows[0];
    expect(row.dead_at).toBeNull();
    expect(row.last_error).toContain('SOURCE_UNAVAILABLE');

    const later = await relayWith(learningConsumer()).drain(new Date(row.retry_at.getTime() + 1_000));
    expect(later).toMatchObject({ delivered: 1, retried: 0 });
    expect(await learningRows('mastery_evidence')).toBe(before + 2);
  });

  it('dead-letters, on the first delivery, an attempt with an item version content cannot resolve, and records nothing of it', async () => {
    await clearOutbox();
    const known = await published('Known to relay.', 'foundational', [tag(randomUUID(), 1, true)]);
    await sat([known, randomUUID()], [
      { slot: 0, kind: 'select', answer: 'B', at: T('09:05') },
      { slot: 1, kind: 'select', answer: 'B', at: T('09:06') },
    ]);
    const before = await learningRows('mastery_evidence');
    const report = await relayWith(learningConsumer()).drain(NOW);
    expect(report).toMatchObject({ claimed: 1, delivered: 0, retried: 0, deadLettered: 1 });
    const row = (await database.pool.query(`SELECT dead_at, attempts, last_error FROM platform.outbox_message WHERE event_type = 'AttemptScored'`)).rows[0];
    expect(row.dead_at).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.last_error).toContain('ITEM_VERSION_UNRESOLVED');
    // all or nothing: the version it could resolve was not recorded either
    expect(await learningRows('mastery_evidence')).toBe(before);
  });

  it('is what the composed application\'s own relay does with an AttemptScored: the wiring, not only the parts', async () => {
    await clearOutbox();
    const { event } = await twoAnswered();
    const app = await createApplication(COMPOSED_CONFIG, { pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => NOW }, identifiers: uuidFactory });
    await app.init();
    try {
      const report = await app.get<Background>(BACKGROUND).relay.drain(NOW);
      expect(report).toMatchObject({ delivered: 1, deadLettered: 0 });
      const attempt = (await database.pool.query(`SELECT payload->>'attemptId' AS attempt FROM platform.outbox_message WHERE aggregate_id = $1`, [event.payload.scoreRecordId])).rows[0].attempt;
      expect(await learningRows('mastery_evidence', `WHERE attempt_ref = '${attempt}'`)).toBe(2);
    } finally {
      await app.close();
    }
  });
});
