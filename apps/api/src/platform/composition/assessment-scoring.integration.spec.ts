import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '../auth/roles.js';
import { issue } from '../auth/token.js';
import { createRecordingTelemetry } from '../observability/recording-telemetry.js';
import { OutboxRelay, type OutboxConsumer, type OutboxEnvelope } from '../outbox/relay.js';
import { createApplication } from './app-factory.js';
import { observing } from '../../testing/response-diagnosis.js';
import { BACKGROUND, type Background } from './background.js';
import { addAnchorPoolMember } from '../../contexts/assessment/domain/anchor-pool.js';
import { PostgresAnchorPoolRepository } from '../../contexts/assessment/infrastructure/anchor-pool.repository.js';
import { PostgresAttemptRepository } from '../../contexts/assessment/infrastructure/attempt.repository.js';
import { PostgresFormRepository } from '../../contexts/assessment/infrastructure/form.repository.js';
import { PostgresResponseLog } from '../../contexts/assessment/infrastructure/response-log.repository.js';
import { ScoreSubmittedAttemptConsumer } from '../../contexts/assessment/application/consumers/scoring-consumer.js';
import { contentForAssessment } from '../../contexts/content/public/composition.js';
import { curriculumForAssessment } from '../../contexts/curriculum/public/composition.js';
import { scoringForAssessment } from '../../contexts/scoring/public/composition.js';
import { KEY_BEARING_FIELDS } from '../../fitness/content-rules.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { MISCONCEPTION_TEXT, SOLUTION_TEXT, itemContent, publishItem } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectValue } from '../../testing/expect-result.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { seedPublishedProfile, type PublishedProfile } from '../../testing/published-profile.js';
import { PostgresIdempotencyStore } from '../persistence/idempotency-store.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { learningForLearner } from '../../contexts/learning/public/composition.js';

/**
 * A submission becomes a score (M6-38 to M6-42): the real application, real Postgres, the real relay draining the real outbox to the
 * real scoring consumer, and a real published exam profile, items and keys. Time is the application's clock, held in the test's hand.
 */
const ISSUER = COMPOSED_CONFIG.authIssuer;
const SIGNING_KEY = COMPOSED_CONFIG.authSigningKey;
const OPENS = '2026-10-21T08:00:00.000Z';
const CLOSES = '2026-10-21T12:00:00.000Z';
const INSIDE = '2026-10-21T08:30:00.000Z';
const SESSION = '2026-01-27/shift-1';

let database: TestDatabase;
let app: INestApplication;
let background: Background;
let profile: PublishedProfile;
let formId: string;
let slotIds: string[];
let now = INSIDE;
let appClock = (): Date => new Date(now);

const STEMS = [
  'A block slides down a frictionless ramp. What is its acceleration?',
  'What is the SI unit of capacitance?',
  'State Kirchhoff\'s current law for a junction.',
  'A convex lens has focal length 20 cm. Where does an object at 30 cm form its image?',
  'Why does the resistance of a metal rise with temperature?',
  'Define the Bohr radius and give its approximate value.',
  'How does the de Broglie wavelength of an electron depend on its speed?',
];

function tokenFor(sub: string, ...roles: string[]): string {
  const issued = Math.floor(Date.now() / 1000);
  return issue({ sub, kind: 'human', roles, iat: issued, exp: issued + 3600, iss: ISSUER, jti: randomUUID() }, { signingKey: SIGNING_KEY, issuer: ISSUER });
}
const http = () => observing(request(app.getHttpServer()), () => database.pool, 'scoring');
const asOps = () => `Bearer ${tokenFor(randomUUID(), ROLES.contentOps)}`;
const student = () => {
  const id = randomUUID();
  return { id, auth: `Bearer ${tokenFor(id, ROLES.learner)}` };
};
type Student = ReturnType<typeof student>;

const create = (who: Student, key: string) => http().post('/v1/assessment/attempts').set('Authorization', who.auth).set('Idempotency-Key', key).send({ formId, sessionRef: SESSION });
const start = (who: Student, id: string) => http().post(`/v1/assessment/attempts/${id}/start`).set('Authorization', who.auth);
const send = (who: Student, id: string, events: unknown[]) => http().post(`/v1/assessment/attempts/${id}/events`).set('Authorization', who.auth).send({ deviceRef: 'd', events });
const submit = (who: Student, id: string, reason = 'manual') => http().post(`/v1/assessment/attempts/${id}/submission`).set('Authorization', who.auth).set('Idempotency-Key', `sub-${id}-${reason}`).send({ reason });
const result = (who: Student, id: string) => http().get(`/v1/assessment/attempts/${id}/result`).set('Authorization', who.auth);

let counter = 0;
const eventId = () => `${(0xd0000000 + (counter += 1)).toString(16)}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;

/** Answers each slot with the given option (or leaves it alone): `b` is the right one for every item here. */
function answers(attemptId: string, choices: readonly (string | null)[]): unknown[] {
  let sequence = 0;
  const events: unknown[] = [];
  choices.forEach((choice, index) => {
    if (choice === null) return;
    const slot = slotIds[index]!;
    for (const [kind, answer] of [['visit', undefined], ['select', choice], ['leave', undefined]] as const) {
      sequence += 1;
      events.push({ eventId: eventId(), attemptId, slot, sequence, monotonicMs: sequence * 3_000, kind, ...(answer === undefined ? {} : { answer }) });
    }
  });
  return events;
}

/** A started attempt with answers sent, for a fresh student: three right, two wrong, one left alone — +12, −2. */
async function sat(choices: readonly (string | null)[] = ['b', 'b', 'b', 'a', 'a', null]): Promise<{ who: Student; attemptId: string }> {
  now = INSIDE;
  const who = student();
  const created = await create(who, `k-${randomUUID()}`);
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const attemptId = created.body.attempt.attemptId as string;
  expect((await start(who, attemptId)).status).toBe(200);
  expect((await send(who, attemptId, answers(attemptId, choices))).status).toBe(200);
  return { who, attemptId };
}

const count = async (sql: string, params: unknown[]): Promise<number> => (await database.pool.query<{ n: number }>(sql, params)).rows[0]!.n;
const scoreRecords = (attemptId: string) => count('SELECT count(*)::int AS n FROM scoring.score_record WHERE attempt_id = $1', [attemptId]);
const drain = (at = now) => background.relay.drain(new Date(at));

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  profile = await seedPublishedProfile(database);
  const versions: string[] = [];
  for (const stem of STEMS) versions.push((await publishItem(database.pool, itemContent(stem))).versions[0]!.versionId);
  expectValue(
    await new PostgresAnchorPoolRepository(database.pool).add(expectValue(addAnchorPoolMember({ itemVersionId: versions[0]!, exposureCap: 1_000, addedAt: '2026-10-01T00:00:00.000Z' }))),
  );
  app = await createApplication(COMPOSED_CONFIG, {
    pool: database.pool,
    telemetry: createRecordingTelemetry(),
    clock: { now: () => appClock() },
    identifiers: uuidFactory,
  });
  await serveOnLoopback(app);
  background = app.get<Background>(BACKGROUND);

  const blueprint = {
    examProfileVersionId: profile.profileVersionId,
    formType: 'mock',
    totalMarks: 24,
    difficultyTolerance: 0,
    sections: [{ ordinal: 1, sectionSpecRef: 'physics', itemCount: 6, typeMix: { SINGLE_CORRECT_MCQ: 6 }, marksPerItem: 4, difficultyTarget: { moderate: 6 } }],
  };
  const assembled = await http().post('/v1/assessment/forms').set('Authorization', asOps()).send({ blueprint, sessionRefs: [SESSION] });
  expect(assembled.status, JSON.stringify(assembled.body)).toBe(201);
  formId = assembled.body.form.formId as string;
  slotIds = (assembled.body.form.sections as { slots: { slotId: string }[] }[]).flatMap((section) => section.slots.map((slot) => slot.slotId));
  expect((await http().post(`/v1/assessment/forms/${formId}/publication`).set({ Authorization: asOps(), 'X-Step-Up': 'satisfied' })).status).toBe(200);
  expect((await http().post(`/v1/assessment/forms/${formId}/schedule`).set('Authorization', asOps()).send({ opensAt: OPENS, closesAt: CLOSES })).status).toBe(200);
  await database.pool.query(`UPDATE assessment.form SET state = 'active' WHERE form_id = $1`, [formId]);
});

afterAll(async () => {
  await app.close();
  await database.revertMigrations();
  await database.close();
});

describe('a submission is scored, once (M6-39, M6-40; D60)', () => {
  it('is pending until the relay has delivered it, and then the score the rules say: +4 for each right answer, −1 for each wrong one', async () => {
    const { who, attemptId } = await sat();
    const submitted = await submit(who, attemptId);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(await count(`SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'AttemptSubmitted' AND aggregate_id = $1`, [attemptId])).toBe(1);

    const before = await result(who, attemptId);
    expect(before.body).toEqual({ attemptId, status: 'pending' });

    const report = await drain();
    expect(report.delivered).toBeGreaterThanOrEqual(1);
    const after = await result(who, attemptId);
    expect(after.status, JSON.stringify(after.body)).toBe(200);
    expect(after.body.status).toBe('scored');
    expect(after.body.score).toMatchObject({ attemptId, generation: 1, totalRaw: '10', totalMaxAvailable: '24' });
    expect(after.body.score.itemOutcomes.map((outcome: { correctness: string }) => outcome.correctness).sort()).toEqual(['correct', 'correct', 'correct', 'incorrect', 'incorrect', 'unattempted']);
    expect(await scoreRecords(attemptId)).toBe(1);
  });

  it('scores once under redelivery: the same message delivered again writes nothing', async () => {
    const { who, attemptId } = await sat(['b', 'b', 'b', 'b', 'b', 'b']);
    await submit(who, attemptId);
    await drain();
    expect((await result(who, attemptId)).body.score.totalRaw).toBe('24');
    const before = await count('SELECT count(*)::int AS n FROM scoring.score_record', []);

    // the acknowledgement is lost, as when a relay dies after the effect: the message comes back
    await database.pool.query(`UPDATE platform.outbox_message SET published_at = NULL, attempts = 0 WHERE event_type = 'AttemptSubmitted' AND aggregate_id = $1`, [attemptId]);
    const again = await drain();
    expect(again.delivered).toBe(1);
    expect(await scoreRecords(attemptId)).toBe(1);
    expect(await count('SELECT count(*)::int AS n FROM scoring.score_record', [])).toBe(before);
  });

  it('scores once when the same message is delivered to two consumers at once: one record, and neither is told it failed', async () => {
    const { who, attemptId } = await sat();
    await submit(who, attemptId);
    const envelope = {
      messageId: randomUUID(),
      correlationId: 'corr',
      payload: { attemptId },
    };
    const pool = database.pool;
    const consumerAt = () =>
      new ScoreSubmittedAttemptConsumer({
        attempts: new PostgresAttemptRepository(pool),
        forms: new PostgresFormRepository(pool),
        responses: new PostgresResponseLog(pool),
        keys: contentForAssessment(contentDeps()).answerKeys,
        spec: curriculumForAssessment(curriculumDeps()).scoringSpec,
        scorer: scoringForAssessment(scoringDeps()).scoreAttempt,
      });
    const outcomes = await Promise.allSettled([consumerAt().handle(envelope), consumerAt().handle(envelope), consumerAt().handle(envelope), consumerAt().handle(envelope)]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'fulfilled']);
    expect(await scoreRecords(attemptId)).toBe(1);
  });

  it('scores a submission nothing but the scheduler made: an expired attempt, submitted as expiry, then scored', async () => {
    const { who, attemptId } = await sat();
    const deadline = (await http().get(`/v1/assessment/attempts/${attemptId}`).set('Authorization', who.auth)).body.deadline as string;

    now = '2026-10-21T11:29:59.000Z';
    expect(deadline).toBe('2026-10-21T11:30:00.000Z');
    expect(await submittedBy(attemptId)).toBeNull();
    const early = await background.scheduler.tick(new Date(now));
    expect(early.jobs.filter((job) => job.outcome === 'failed')).toEqual([]);
    expect(await submittedBy(attemptId)).toBeNull(); // the deadline has not passed

    now = '2026-10-21T11:30:00.000Z';
    // the scheduler remembers when each job last ran, so the next tick is far enough on for both the sweep and the expiry to be due again
    const late = await background.scheduler.tick(new Date('2026-10-21T11:30:30.000Z'));
    expect(late.jobs.filter((job) => job.outcome === 'failed')).toEqual([]);
    expect(await submittedBy(attemptId)).toBe('expiry');
    expect(await count(`SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'AttemptSubmitted' AND aggregate_id = $1`, [attemptId])).toBe(1);

    // the same tick's relay (or the next) delivers it; a pass over the same attempt again changes nothing
    await drain();
    expect((await result(who, attemptId)).body.status).toBe('scored');
    await background.scheduler.tick(new Date('2026-10-21T11:31:30.000Z'));
    expect(await count(`SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'AttemptSubmitted' AND aggregate_id = $1`, [attemptId])).toBe(1);
    expect(await scoreRecords(attemptId)).toBe(1);
    now = INSIDE;
  });

  it('leaves a submission whose scoring fails where an operator can find it and retry it: pending, retried, dead-lettered, requeued, scored', async () => {
    const { who, attemptId } = await sat();
    await submit(who, attemptId);

    // The keys cannot be had: the consumer fails, as it would if content were down.
    const broken: OutboxConsumer = {
      name: 'broken',
      handle: async () => {
        throw new Error('content could not give a key');
      },
    };
    const policy = { batchSize: 25, leaseMs: 60_000, maxAttempts: 2, retryBaseMs: 1_000, retryMaxMs: 8_000, maxRounds: 5 };
    const failing = new OutboxRelay(database.pool, new Map([['AttemptSubmitted', [broken]]]), policy);
    const t0 = new Date('2026-10-23T09:00:00.000Z');
    expect((await failing.drain(t0)).retried).toBeGreaterThanOrEqual(1);
    expect((await failing.drain(new Date(t0.getTime() + 1_000))).deadLettered).toBeGreaterThanOrEqual(1);

    // Not silently scoreless: the result says pending, the dead letter names the attempt, and nothing was scored.
    expect((await result(who, attemptId)).body).toEqual({ attemptId, status: 'pending' });
    const dead = (await failing.listDead()).find((letter) => letter.aggregateId === attemptId);
    expect(dead).toMatchObject({ eventType: 'AttemptSubmitted', attempts: 2 });
    expect(dead?.lastError).toContain('content could not give a key');
    expect(await scoreRecords(attemptId)).toBe(0);

    // The cause is fixed (the real consumer is back); the operator puts the message back.
    expect(await failing.requeue(dead!.messageId)).toBe(true);
    await drain();
    expect((await result(who, attemptId)).body.status).toBe('scored');
    expect(await scoreRecords(attemptId)).toBe(1);
  });

  it('refuses to score against rules that no longer match the pin, loudly', async () => {
    const { who, attemptId } = await sat();
    await submit(who, attemptId);
    const spec = { handle: async () => ({ ok: true as const, value: { markingRuleSet: { schemaVersion: 1, rules: [] }, markingRuleSetHash: 'f'.repeat(64), aggregation: { sectionAggregation: 'SUM', totalAggregation: 'SUM_OF_SECTIONS', rounding: { mode: 'NONE', decimalPlaces: 0 }, floorAtZero: false } } }) };
    const pool = database.pool;
    const consumer = new ScoreSubmittedAttemptConsumer({
      attempts: new PostgresAttemptRepository(pool),
      forms: new PostgresFormRepository(pool),
      responses: new PostgresResponseLog(pool),
      keys: contentForAssessment(contentDeps()).answerKeys,
      spec: spec as never,
      scorer: scoringForAssessment(scoringDeps()).scoreAttempt,
    });
    await expect(consumer.handle({ messageId: randomUUID(), correlationId: 'c', payload: { attemptId } })).rejects.toThrow('MARKING_RULES_NO_LONGER_MATCH_THE_PIN');
    expect(await scoreRecords(attemptId)).toBe(0);
  });

  async function submittedBy(attemptId: string): Promise<string | null> {
    const { rows } = await database.pool.query<{ submission_reason: string | null }>('SELECT submission_reason FROM assessment.attempt WHERE attempt_id = $1', [attemptId]);
    return rows[0]!.submission_reason;
  }
});

// The seams a consumer is built from, as the composition root builds them, for the cases that need one by hand.
const contentDeps = () => ({
  pool: database.pool,
  mediaStore: { put: async () => undefined, get: async () => undefined } as never,
  idempotency: new PostgresIdempotencyStore(database.pool),
  clock: { now: appClock },
  identifiers: uuidFactory,
  audit: { record: async () => undefined },
  principals: { resolve: () => null },
  reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
});
const curriculumDeps = () => ({ pool: database.pool, clock: { now: appClock }, identifiers: uuidFactory, audit: { record: async () => undefined }, principals: { resolve: () => null } });
const scoringDeps = curriculumDeps;

describe('a diagnostic report is readable within sixty seconds of the submission (M7-42)', () => {
  it('goes from the submission to the top finding through the real relay and the scheduler on real timers, and prints the time it took', async () => {
    const { who, attemptId } = await sat();
    const learning = learningForLearner({ pool: database.pool, clock: { now: () => new Date() }, identifiers: uuidFactory, standings: { standings: async () => ({ ok: true as const, value: [] }) } });
    const context = { principal: { kind: 'human' as const, id: who.id, roleContext: ['learner'] }, correlationId: 'timing' };

    // the clock is the real one from here: the scheduler ticks as the process would, every second, and nothing in this test waits a fixed time
    const stop = background.scheduler.start({ every: (ms, run) => { const timer = setInterval(run, ms); return () => clearInterval(timer); } }, () => new Date(), 1_000);
    const begun = performance.now();
    try {
      const submitted = await submit(who, attemptId);
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      let top: { marksLost: string; slots: number; skipped: number } | undefined;
      while (top === undefined && performance.now() - begun < 60_000) {
        const read = await learning.getReport.handle({ attemptId }, context);
        if (read.ok) top = read.value.findings[0];
        else await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const elapsedMs = performance.now() - begun;
      // eslint-disable-next-line no-console
      console.log(`M7-42: submission to top finding readable in ${(elapsedMs / 1000).toFixed(2)} s (budget 60 s)`);
      expect(top).toMatchObject({ marksLost: '14', slots: 3, skipped: 1 });
      expect(elapsedMs).toBeLessThan(60_000);
    } finally {
      stop();
    }
  }, 90_000);
});

describe('the result is the student\'s own, and carries nothing a student must not have (M6-41)', () => {
  const material = (stem: string): string[] => [...KEY_BEARING_FIELDS.map((field) => `"${field}"`), SOLUTION_TEXT, MISCONCEPTION_TEXT, stem, '"solution"', '"stem"'];
  const scan = (body: unknown): string[] => {
    const serialized = JSON.stringify(body);
    return [...new Set(STEMS.flatMap((stem) => material(stem)))].filter((fragment) => serialized.includes(fragment));
  };

  it('serialises with no key, no correct option and no solution — and the same scan finds them where they are held', async () => {
    const { who, attemptId } = await sat();
    await submit(who, attemptId);
    await drain();
    const scored = await result(who, attemptId);
    expect(scored.body.status).toBe('scored');
    expect(scan(scored.body)).toEqual([]);
    // what the result is explained by: the rule, never the answer
    expect(scored.body.score.itemOutcomes[0]).toEqual(expect.objectContaining({ ruleAppliedId: expect.any(String), correctness: expect.any(String), marksAwarded: expect.any(String) }));

    // non-vacuity: the authoring view of the very items carries the key and the solution, and the scan finds them there
    const authoringIds = (await database.pool.query<{ item_id: string }>('SELECT DISTINCT item_id FROM content.item_version LIMIT 1')).rows;
    const authoring = await http().get(`/v1/authoring/items/${authoringIds[0]!.item_id}`).set('Authorization', asOps());
    expect(authoring.status).toBe(200);
    expect(scan(authoring.body).length).toBeGreaterThan(0);
    expect(scan({ planted: { correctOptionId: 'b', stem: STEMS[0] } }).sort()).toEqual(['"correctOptionId"', '"stem"', STEMS[0]].sort());
  });

  it('shows a student only their own result: another student\'s is not found, and so is an attempt that does not exist', async () => {
    const { who, attemptId } = await sat();
    await submit(who, attemptId);
    await drain();
    expect((await result(who, attemptId)).status).toBe(200);
    expect((await result(student(), attemptId)).status).toBe(404);
    expect((await result(who, randomUUID())).status).toBe(404);
    expect((await http().get(`/v1/assessment/attempts/${attemptId}/result`)).status).toBe(401);
    const operator = await http().get(`/v1/assessment/attempts/${attemptId}/result`).set('Authorization', asOps());
    expect(operator.status).toBe(403);
  });

  it('has no result for an attempt not yet submitted', async () => {
    const { who, attemptId } = await sat();
    const early = await result(who, attemptId);
    expect([early.status, early.body.reason]).toEqual([412, 'ATTEMPT_NOT_SUBMITTED']);
  });
});

const relayMaterialIn = (serialized: string): string[] =>
  [...KEY_BEARING_FIELDS.map((field) => `"${field}"`), SOLUTION_TEXT, MISCONCEPTION_TEXT, ...STEMS, '"answer"', '"selected"'].filter((fragment) => serialized.includes(fragment));

describe('what the relay emits for a real submission carries identifiers and nothing else (M6-38)', () => {
  it('the scan over its envelopes is not vacuous: it fires on an envelope that carries a stem, a key, a solution or an answer', () => {
    const planted = JSON.stringify([{ eventType: 'AttemptSubmitted', payload: { correctOptionId: 'b', stem: STEMS[0], note: SOLUTION_TEXT, answer: 'a' } }]);
    expect(relayMaterialIn(planted).sort()).toEqual([...new Set(['"correctOptionId"', STEMS[0]!, SOLUTION_TEXT, '"answer"'])].sort());
  });

  it('delivers AttemptSubmitted and AttemptScored to a consumer that scans every envelope for stem, key, solution and justification material', async () => {
    const { who, attemptId } = await sat();
    await submit(who, attemptId);
    const seen: OutboxEnvelope[] = [];
    const sink: OutboxConsumer = { name: 'sink', handle: async (envelope) => void seen.push(envelope) };
    const policy = { batchSize: 50, leaseMs: 60_000, maxAttempts: 3, retryBaseMs: 1_000, retryMaxMs: 8_000, maxRounds: 20 };
    // delivered to the application's own consumers first (scoring for the submission, learning for the score), then both events to the sink: each is put back
    await drain();
    await database.pool.query(`UPDATE platform.outbox_message SET published_at = NULL WHERE aggregate_id = $1 OR event_type = 'AttemptScored'`, [attemptId]);
    const scored = await database.pool.query<{ aggregate_id: string }>(`SELECT aggregate_id FROM platform.outbox_message WHERE event_type = 'AttemptScored' ORDER BY occurred_at DESC LIMIT 1`);
    expect(scored.rows.length).toBe(1);
    const report = await new OutboxRelay(
      database.pool,
      new Map([
        ['AttemptSubmitted', [sink]],
        ['AttemptScored', [sink]],
      ]),
      policy,
    ).drain(new Date('2026-10-23T09:30:00.000Z'));
    expect(report.refused).toBe(0);
    expect(seen.map((envelope) => envelope.eventType)).toEqual(expect.arrayContaining(['AttemptSubmitted', 'AttemptScored']));
    const serialized = JSON.stringify(seen);
    expect(relayMaterialIn(serialized)).toEqual([]);
    // and what it did carry is the identifiers it was meant to
    const submittedEvent = seen.find((envelope) => envelope.eventType === 'AttemptSubmitted' && envelope.payload['attemptId'] === attemptId);
    expect(Object.keys(submittedEvent!.payload).sort()).toEqual(['attemptId', 'examProfileVersionId', 'formId', 'markingRuleSetHash', 'reason', 'studentId', 'submittedAt', 'taxonomyVersionId']);
  });
});

describe('the scheduler in the composed application (M6-42, D36)', () => {
  it('is built, not started: creating the application scheduled nothing, and a tick with the moment supplied runs every job', async () => {
    expect(background.scheduler.names).toEqual(['outbox.drain', 'assessment.sweep-windows', 'assessment.submit-expired', 'content.review-ageing']);
    const report = await background.scheduler.tick(new Date('2027-01-01T00:00:00.000Z'));
    expect(report.jobs.map((job) => job.outcome)).toEqual(['ran', 'ran', 'ran', 'ran']);
  });

  it('abandons a created attempt whose window closed, and closes the window, by the sweep', async () => {
    now = INSIDE;
    const who = student();
    const created = await create(who, `k-${randomUUID()}`);
    const attemptId = created.body.attempt.attemptId as string;
    now = '2026-10-21T12:30:00.000Z';
    appClock = () => new Date(now);
    const report = await background.scheduler.tick(new Date('2027-02-01T00:00:00.000Z'));
    expect(report.jobs.filter((job) => job.outcome === 'failed')).toEqual([]);
    const { rows } = await database.pool.query<{ state: string }>('SELECT state FROM assessment.attempt WHERE attempt_id = $1', [attemptId]);
    expect(rows[0]!.state).toBe('abandoned');
    expect((await database.pool.query<{ state: string }>('SELECT state FROM assessment.form WHERE form_id = $1', [formId])).rows[0]!.state).toBe('closed');
    now = INSIDE;
  });
});
