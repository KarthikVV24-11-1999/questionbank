import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '../auth/roles.js';
import { issue } from '../auth/token.js';
import { createRecordingTelemetry } from '../observability/recording-telemetry.js';
import { createApplication } from './app-factory.js';
import { BACKGROUND, type Background } from './background.js';
import { verifyPackage } from '../../contexts/assessment/infrastructure/package-signer.js';
import { TEST_SIGNING_SEED } from '../../testing/assessment-fakes.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { CONCEPT, MISCONCEPTION_TEXT, SOLUTION_TEXT, TAXONOMY, itemContent, publishItem } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { seedPublishedProfile, type PublishedProfile } from '../../testing/published-profile.js';
import { seedPublishedSyllabus, type PublishedSyllabus } from '../../testing/published-syllabus.js';
import { tokenPrincipals } from '../../testing/service-tokens.js';

/**
 * The loop, closed (M8-26): a learner with a profile starts a practice run, is served its questions as a signed package, answers them, submits, and what the product knows about them is
 * different afterwards, with the state naming the responses that produced it. The real application, real Postgres, the real relay draining the real outbox through the real scoring and
 * Learning consumers, and real published items and keys. Nothing here is a double.
 */
const CONFIG = { ...COMPOSED_CONFIG, formPackageSigningKey: TEST_SIGNING_SEED };
const NOW = '2026-11-04T09:00:00.000Z';

let database: TestDatabase;
let app: INestApplication;
let background: Background;
let profile: PublishedProfile;
let syllabus: PublishedSyllabus;
const itemIds: string[] = [];

const STEMS = [
  'A block slides down a frictionless ramp. What is its acceleration?',
  'What is the SI unit of capacitance?',
  "State Kirchhoff's current law for a junction.",
  'A convex lens has focal length 20 cm. Where does an object at 30 cm form its image?',
  'Why does the resistance of a metal rise with temperature?',
  'Define the Bohr radius and give its approximate value.',
  'How does the de Broglie wavelength of an electron depend on its speed?',
  'What is the unit of magnetic flux?',
];

function learner() {
  const id = randomUUID();
  const issued = Math.floor(Date.now() / 1000);
  const token = issue({ sub: id, kind: 'human', roles: [ROLES.learner], iat: issued, exp: issued + 3600, iss: CONFIG.authIssuer, jti: randomUUID() }, { signingKey: CONFIG.authSigningKey, issuer: CONFIG.authIssuer });
  return { id, auth: `Bearer ${token}` };
}
type Learner = ReturnType<typeof learner>;
const http = () => request(app.getHttpServer());

let counter = 0;
const eventId = () => `${(0xe0000000 + (counter += 1)).toString(16)}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;

const count = async (sql: string, params: unknown[] = []): Promise<number> => (await database.pool.query<{ n: number }>(sql, params)).rows[0]!.n;

/** Brings a learner to a profile with an exam and a class: onboarding, as far as the product asks for it. */
async function withProfile(who: Learner): Promise<void> {
  const set = await http().patch('/v1/learning/profile').set('Authorization', who.auth).send({ examCode: syllabus.examCode, targetYear: syllabus.academicYear, currentClass: 'class_12' });
  expect(set.status, JSON.stringify(set.body)).toBe(200);
}

const startRun = (who: Learner, count_: number, key = randomUUID()) =>
  http().post('/v1/assessment/practice-attempts').set('Authorization', who.auth).set('Idempotency-Key', key).send({ examProfileVersionId: profile.profileVersionId, selectionStrategy: 'filtered', scopeFilter: {}, difficultyBand: 'moderate', count: count_ });
const packageOf = (who: Learner, attemptId: string) => http().get(`/v1/assessment/practice-attempts/${attemptId}/package`).set('Authorization', who.auth).buffer(true).parse((res, done) => {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => done(null, Buffer.concat(chunks)));
});
const begin = (who: Learner, attemptId: string) => http().post(`/v1/assessment/attempts/${attemptId}/start`).set('Authorization', who.auth);
const send = (who: Learner, attemptId: string, events: unknown[]) => http().post(`/v1/assessment/attempts/${attemptId}/events`).set('Authorization', who.auth).send({ deviceRef: 'phone', events });
const submit = (who: Learner, attemptId: string) => http().post(`/v1/assessment/attempts/${attemptId}/submission`).set('Authorization', who.auth).set('Idempotency-Key', `sub-${attemptId}`).send({ reason: 'manual' });

interface RunPackage { format: string; run: { attemptId: string }; slots: Array<{ slotId: string; ordinal: number; itemVersionId: string; item: unknown }> }
const parsed = (body: Buffer): RunPackage => JSON.parse(body.toString('utf8')) as RunPackage;

/** The events a device writes for each slot: a visit, the choice, a leave. `b` is the right answer to every item here. */
function answersFor(slotIds: readonly string[], choices: readonly (string | null)[], attemptId: string): unknown[] {
  let sequence = 0;
  const events: unknown[] = [];
  choices.forEach((choice, index) => {
    if (choice === null) return;
    for (const [kind, answer] of [['visit', undefined], ['select', choice], ['leave', undefined]] as const) {
      sequence += 1;
      events.push({ eventId: eventId(), attemptId, slot: slotIds[index], sequence, monotonicMs: sequence * 3_000, kind, ...(answer === undefined ? {} : { answer }) });
    }
  });
  return events;
}

/** Delivers everything that is waiting, and what that delivery wrote: a submission becomes a score and a score becomes evidence. */
async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    const report = await background.relay.drain(new Date(NOW));
    if (report.delivered === 0) return;
  }
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  profile = await seedPublishedProfile(database);
  syllabus = await seedPublishedSyllabus(database, { examCode: `PRACTICE_${randomUUID().slice(0, 8).toUpperCase().replaceAll('-', '')}`, academicYear: '2026' });
  for (const stem of STEMS) itemIds.push((await publishItem(database.pool, itemContent(stem))).itemId);
  app = await createApplication(CONFIG, { pool: database.pool, principals: tokenPrincipals(CONFIG), telemetry: createRecordingTelemetry(), clock: { now: () => new Date(NOW) }, identifiers: uuidFactory });
  await serveOnLoopback(app);
  background = app.get<Background>(BACKGROUND);
});

afterAll(async () => {
  await app.close();
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.response_event, assessment.attempt_slot, assessment.attempt CASCADE');
  await database.revertMigrations();
  await database.close();
});

describe('what a learner does changes what the product knows about them (M8-26; D87, D77)', () => {
  it('starts a run, is served its questions, answers them, submits, and a concept\'s state is different afterwards, naming the responses that made it', async () => {
    const who = learner();
    await withProfile(who);
    const stateOf = () => count('SELECT count(*)::int AS n FROM learning.concept_state WHERE learner_ref = $1', [who.id]);
    expect(await stateOf()).toBe(0);
    expect((await http().get(`/v1/learning/remediation-concepts?taxonomyVersionId=${TAXONOMY}`).set('Authorization', who.auth)).body.conceptIdentityIds).toEqual([]);

    const created = await startRun(who, 6);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const attemptId = created.body.attempt.attemptId as string;

    // served its questions, signed, and the same key a paper is signed with
    const served = await packageOf(who, attemptId);
    expect(served.status).toBe(200);
    expect(served.headers['content-type']).toContain('application/vnd.questionbank.practice-package+json');
    const key = (await http().get('/v1/assessment/package-signing-key').set('Authorization', who.auth)).body as { keyId: string; publicKey: string };
    expect(served.headers['x-package-key-id']).toBe(key.keyId);
    expect(verifyPackage(new Uint8Array(served.body as Buffer), served.headers['x-package-signature'] as string, key.publicKey)).toBe(true);
    const run = parsed(served.body as Buffer);
    expect(run).toMatchObject({ format: 'questionbank.practice-package', run: { attemptId } });
    expect(run.slots).toHaveLength(6);

    expect((await begin(who, attemptId)).status).toBe(200);
    const slotIds = run.slots.map((slot) => slot.slotId);
    // four right, two wrong
    const choices = ['b', 'b', 'b', 'b', 'a', 'a'];
    expect((await send(who, attemptId, answersFor(slotIds, choices, attemptId))).status).toBe(200);

    // feedback on an answered slot works, and says only the verdict
    const right = await http().get(`/v1/assessment/attempts/${attemptId}/slots/${slotIds[0]}/feedback`).set('Authorization', who.auth);
    const wrong = await http().get(`/v1/assessment/attempts/${attemptId}/slots/${slotIds[5]}/feedback`).set('Authorization', who.auth);
    expect([right.status, right.body.outcome, wrong.status, wrong.body.outcome]).toEqual([200, 'correct', 200, 'incorrect']);
    expect(Object.keys(right.body).sort()).toEqual(['attemptId', 'outcome', 'slotId']);

    const submitted = await submit(who, attemptId);
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    expect(await count(`SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'PracticeAttemptSubmitted' AND aggregate_id = $1`, [attemptId])).toBe(1);
    expect(await count(`SELECT count(*)::int AS n FROM platform.outbox_message WHERE event_type = 'AttemptSubmitted' AND aggregate_id = $1`, [attemptId])).toBe(0);

    await settle();

    // scored: +4 for each right answer, −1 for each wrong one, in a run with no form
    const score = await database.pool.query<{ total_raw: string; total_max_available: string }>(`SELECT total_raw::text, total_max_available::text FROM scoring.score_record WHERE attempt_id = $1 AND is_current`, [attemptId]);
    expect(score.rows).toEqual([{ total_raw: '14.0000', total_max_available: '24.0000' }]);

    // and Learning has the six responses, one per slot, each with what happened to it
    const evidence = await database.pool.query<{ slot_ref: string; outcome: string; concept_identity_id: string }>(
      `SELECT slot_ref, outcome, concept_identity_id FROM learning.mastery_evidence WHERE attempt_ref = $1 AND learner_ref = $2 ORDER BY slot_ref`, [attemptId, who.id]);
    expect(evidence.rows.map((row) => row.slot_ref).sort()).toEqual([...slotIds].sort());
    expect(evidence.rows.filter((row) => row.outcome === 'correct')).toHaveLength(4);
    expect(evidence.rows.filter((row) => row.outcome === 'incorrect')).toHaveLength(2);
    expect(new Set(evidence.rows.map((row) => row.concept_identity_id))).toEqual(new Set([CONCEPT]));

    // the state is different: there was none, and now there is, made of exactly those responses
    expect(await stateOf()).toBe(1);
    const state = await database.pool.query<{ state: string; evidence_count: number; distinct_item_count: number; last_evidence_at: Date }>(
      `SELECT state, evidence_count, distinct_item_count, last_evidence_at FROM learning.concept_state WHERE learner_ref = $1 AND concept_identity_id = $2`, [who.id, CONCEPT]);
    expect(state.rows[0]).toMatchObject({ evidence_count: 6, distinct_item_count: 6 });
    expect(state.rows[0]!.state).not.toBe('unassessed');
  });

  it('serves a run to its owner alone: another learner is told no such run, and gets no bytes', async () => {
    const owner = learner();
    const other = learner();
    const attemptId = (await startRun(owner, 3)).body.attempt.attemptId as string;
    const refused = await packageOf(other, attemptId);
    expect(refused.status).toBe(404);
    expect((refused.body as Buffer).toString('utf8')).not.toContain('questionbank.practice-package');
    expect(refused.headers['x-package-signature']).toBeUndefined();
    expect((await http().get(`/v1/assessment/practice-attempts/${attemptId}/package`)).status).toBe(401);
  });

  it('counts a delivery when a slot is added and never when the package is read: asking again, or from a second device, counts nothing', async () => {
    const who = learner();
    const attemptId = (await startRun(who, 3)).body.attempt.attemptId as string;
    const ledger = () => count('SELECT count(*)::int AS n FROM assessment.exposure_ledger_entry WHERE attempt_id = $1', [attemptId]);
    const placed = await ledger();
    expect(placed).toBe(3);
    await packageOf(who, attemptId);
    await packageOf(who, attemptId);
    expect(await ledger()).toBe(placed);
  });

  it('is a different package when the run grows, and the device that holds the old one is given the new', async () => {
    const who = learner();
    const attemptId = (await startRun(who, 2)).body.attempt.attemptId as string;
    const before = await packageOf(who, attemptId);
    const grown = await http().post(`/v1/assessment/attempts/${attemptId}/practice-items`).set('Authorization', who.auth).send({ count: 2 });
    expect(grown.status, JSON.stringify(grown.body)).toBe(200);
    const after = await http().get(`/v1/assessment/practice-attempts/${attemptId}/package`).set('Authorization', who.auth).set('If-None-Match', before.headers['etag'] as string).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    expect(after.status).toBe(200);
    expect(after.headers['etag']).not.toBe(before.headers['etag']);
    expect(parsed(after.body as Buffer).slots).toHaveLength(4);
    expect(parsed(after.body as Buffer).slots.slice(0, 2).map((slot) => slot.slotId)).toEqual(parsed(before.body as Buffer).slots.map((slot) => slot.slotId));
  });
});

/** Key material, by name and by the text the solution carries: the method the form's package is held to, over a run's. */
const KEY_FIELDS = ['correctOptionId', 'correctOptionIds', 'isCorrect', 'is_correct', 'answerKey', 'expectedValue', 'finalAnswer', 'finalAnswerAssertion', 'responseSpec', 'pairs'];
const keyMaterialIn = (text: string): string[] => [...KEY_FIELDS.filter((field) => text.includes(`"${field}"`)), ...[SOLUTION_TEXT, MISCONCEPTION_TEXT].filter((fragment) => text.includes(fragment))];

describe('a practice run\'s package is key-free, and the scan that shows it is not blind (M8-23)', () => {
  it('carries no answer key and no solution, though it carries the items of the run, and the same scan finds the key in their authoring views', async () => {
    const who = learner();
    const attemptId = (await startRun(who, 6)).body.attempt.attemptId as string;
    const served = ((await packageOf(who, attemptId)).body as Buffer).toString('utf8');
    expect(keyMaterialIn(served)).toEqual([]);
    // the package really holds the items it is made of, so an empty scan is about the right bytes
    expect(STEMS.filter((stem) => served.includes(stem)).length).toBeGreaterThanOrEqual(6);

    const issued = Math.floor(Date.now() / 1000);
    const ops = `Bearer ${issue({ sub: randomUUID(), kind: 'human', roles: [ROLES.contentOps], iat: issued, exp: issued + 3600, iss: CONFIG.authIssuer, jti: randomUUID() }, { signingKey: CONFIG.authSigningKey, issuer: CONFIG.authIssuer })}`;
    const pinned = itemIds.filter((_, index) => served.includes(STEMS[index]!));
    const authoring = await http().get(`/v1/authoring/items/${pinned[0]}`).set('Authorization', ops);
    expect(authoring.status, JSON.stringify(authoring.body)).toBe(200);
    expect(keyMaterialIn(JSON.stringify(authoring.body)).length).toBeGreaterThan(0);
  });

  it('is never unsigned: with no signing key configured the route is 503 and carries no package', async () => {
    const unkeyed = await createApplication(COMPOSED_CONFIG, { pool: database.pool, principals: tokenPrincipals(COMPOSED_CONFIG), telemetry: createRecordingTelemetry(), clock: { now: () => new Date(NOW) }, identifiers: uuidFactory });
    await serveOnLoopback(unkeyed);
    try {
      const who = learner();
      const attemptId = (await startRun(who, 2)).body.attempt.attemptId as string;
      const refused = await request(unkeyed.getHttpServer()).get(`/v1/assessment/practice-attempts/${attemptId}/package`).set('Authorization', who.auth);
      expect(refused.status).toBe(503);
      expect(refused.headers['x-package-signature']).toBeUndefined();
      expect(refused.headers['content-type']).not.toContain('practice-package');
    } finally {
      await unkeyed.close();
    }
  });
});

describe('the same run, answered with the backend unreachable (M8-26)', () => {
  it('sent in one batch after the outage, in the order the device captured it, it ends in the same place as one sent as it was given', async () => {
    const live = learner();
    const late = learner();
    const outcome = async (who: Learner, deliver: (attemptId: string, slotIds: string[]) => Promise<void>) => {
      const attemptId = (await startRun(who, 6)).body.attempt.attemptId as string;
      const run = parsed((await packageOf(who, attemptId)).body as Buffer);
      await begin(who, attemptId);
      const slotIds = run.slots.map((slot) => slot.slotId);
      await deliver(attemptId, slotIds);
      expect((await submit(who, attemptId)).status).toBe(200);
      await settle();
      const evidence = await database.pool.query<{ outcome: string }>(`SELECT outcome FROM learning.mastery_evidence WHERE attempt_ref = $1 ORDER BY slot_ref`, [attemptId]);
      const state = await database.pool.query(`SELECT state, evidence_count, distinct_item_count FROM learning.concept_state WHERE learner_ref = $1`, [who.id]);
      const score = await database.pool.query(`SELECT total_raw::text AS total_raw FROM scoring.score_record WHERE attempt_id = $1 AND is_current`, [attemptId]);
      return { outcomes: evidence.rows.map((row) => row.outcome).sort(), state: state.rows, score: score.rows };
    };
    const choices = ['b', 'a', 'b', 'a', 'b', 'b'];
    const asGiven = await outcome(live, async (attemptId, slotIds) => {
      for (const [index, choice] of choices.entries()) expect((await send(live, attemptId, answersFor([slotIds[index]!], [choice], attemptId).map((event, i) => ({ ...(event as object), sequence: index * 3 + i + 1 })))).status).toBe(200);
    });
    const afterOutage = await outcome(late, async (attemptId, slotIds) => {
      // nothing reached the server while the device was offline; the whole log arrives at once
      expect((await send(late, attemptId, answersFor(slotIds, choices, attemptId))).status).toBe(200);
    });
    expect(afterOutage).toEqual(asGiven);
    expect(afterOutage.score).toEqual([{ total_raw: '14.0000' }]);
  });
});
