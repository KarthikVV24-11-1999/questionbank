import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecordingTelemetry } from '../observability/recording-telemetry.js';
import { createApplication } from './app-factory.js';
import { BACKGROUND, type Background } from './background.js';
import { MemorySink } from '../analytics/sink.js';
import { MemoryMail } from '../../contexts/identity/infrastructure/mail-adapters.js';
import { TEST_SIGNING_SEED } from '../../testing/assessment-fakes.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { itemContent, publishItem } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { unlimited } from '../../testing/rate-limits.js';
import { seedPublishedSyllabus, type PublishedSyllabus } from '../../testing/published-syllabus.js';

/**
 * Signup to the first named weakness (M8-35; M8's first criterion, ≤ 10 minutes for ≥ 70% of beta users). The whole path through the composed application, against real Postgres, the real session
 * resolver, the real relay draining the real outbox, real published items and a real syllabus: register, verify the address, sign in, choose an exam, say which chapters are studied, be offered the
 * diagnostic, sit it, submit it, open the map, and read what a topic is called. Nothing is a double but the mailbox, which is a list.
 *
 * **What the time measured here is worth, said before the guarantee that rests on it.** It is the server's own time for each step of one path on one machine, with a person reading and thinking nowhere in it.
 * It is a floor on the machine's share of the ten minutes and not the criterion, which is a share of real people over a real network; the steps are timed one by one so that a slow one is seen
 * and is not hidden in a total. `docs/M8-ACCEPTANCE.md` says the same where the criterion is judged.
 *
 * Also held here, because it is the same path: FR-STU-03's fourth rule (an abandoned diagnostic gives a partial map) is shown for the case where it is true — a run finished with some questions
 * unanswered — and the case where it is not is shown as it is (D116 in docs/DEBT.md).
 */
const CONFIG = { ...COMPOSED_CONFIG, formPackageSigningKey: TEST_SIGNING_SEED };
const PASSWORD = 'a long and ordinary passphrase';
const NOW = '2026-11-04T09:00:00.000Z';
/** Three items for each of the syllabus's four topics, so a run of ten has something to take from every one. */
const ITEMS_PER_CONCEPT = 3;

let database: TestDatabase;
let app: INestApplication;
let background: Background;
let syllabus: PublishedSyllabus;
const mail = new MemoryMail();
const sink = new MemorySink();
let clockAt = NOW;
const http = () => request(app.getHttpServer());

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  syllabus = await seedPublishedSyllabus(database, { examCode: `JOURNEY_${randomUUID().slice(0, 8).toUpperCase().replaceAll('-', '')}`, academicYear: '2026' });
  for (const concept of Object.values(syllabus.concepts)) {
    for (let n = 0; n < ITEMS_PER_CONCEPT; n += 1) {
      const content = itemContent(`Question ${concept.slice(0, 4)}-${n}: what is the quantity here?`);
      await publishItem(database.pool, { ...content, taxonomyTags: [{ conceptIdentityId: concept, taxonomyVersionId: syllabus.taxonomyVersionId, weight: 1, isPrimary: true }] });
    }
  }
  app = await createApplication(CONFIG, { pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => new Date(clockAt) }, identifiers: uuidFactory, mail, limiter: unlimited, analyticsSink: sink });
  await serveOnLoopback(app);
  background = app.get<Background>(BACKGROUND);
}, 120_000);

afterAll(async () => {
  await app.close();
  await database.pool.query('TRUNCATE assessment.exposure_ledger_entry, assessment.response_event, assessment.attempt_slot, assessment.attempt CASCADE');
  await database.revertMigrations();
  await database.close();
});

let counter = 0;
const eventId = () => `${(0xf0000000 + (counter += 1)).toString(16)}-0000-4000-8000-${counter.toString(16).padStart(12, '0')}`;
const codeIn = (): string => /code is (\S+)\./u.exec(mail.sent.filter((message) => message.purpose === 'email_verification').at(-1)!.body)![1]!;

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

async function settle(): Promise<void> {
  for (let round = 0; round < 4; round += 1) {
    if ((await background.relay.drain(new Date(clockAt))).delivered === 0) return;
  }
}

interface Person {
  readonly auth: string;
}

/** Register, verify, sign in. Returns the person and how long each took. */
async function signUp(timed: <T>(step: string, run: () => Promise<T>) => Promise<T>): Promise<Person> {
  const address = `learner-${randomUUID().slice(0, 8)}@example.com`;
  await timed('register', async () => expect((await http().post('/v1/identity/register').send({ email: address, password: PASSWORD })).status).toBe(202));
  await timed('verify the address', async () => expect((await http().post('/v1/identity/email/verify').send({ token: codeIn() })).status).toBe(200));
  const session = await timed('sign in', async () => {
    const response = await http().post('/v1/identity/login').send({ email: address, password: PASSWORD });
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return response.body.sessionToken as string;
  });
  return { auth: `Bearer ${session}` };
}

/** Choose an exam and say which chapters are studied: the whole syllabus, so every topic is in scope. */
async function onboard(who: Person, timed: <T>(step: string, run: () => Promise<T>) => Promise<T>): Promise<void> {
  await timed('choose an exam', async () => {
    const set = await http().patch('/v1/learning/profile').set('Authorization', who.auth).send({ examCode: syllabus.examCode, targetYear: syllabus.academicYear, currentClass: 'class_12' });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  });
  await timed('say which chapters are studied', async () => {
    const set = await http().patch('/v1/learning/profile').set('Authorization', who.auth).send({ scopeNodeIds: [syllabus.nodes.physics] });
    expect(set.status, JSON.stringify(set.body)).toBe(200);
  });
}

/** What the home screen asks, in the order it asks it, to decide what to offer. */
async function askHome(who: Person): Promise<{ plan: unknown; weakest: string[]; assessed: number }> {
  const profile = (await http().get('/v1/learning/profile').set('Authorization', who.auth)).body as { exam: { taxonomyVersionId: string }; scope: unknown };
  expect(profile.scope).not.toBeNull();
  const plan = (await http().get('/v1/learning/review-plan').set('Authorization', who.auth)).body;
  const weakest = (await http().get(`/v1/learning/remediation-concepts?taxonomyVersionId=${profile.exam.taxonomyVersionId}`).set('Authorization', who.auth)).body.conceptIdentityIds as string[];
  const map = (await http().get('/v1/learning/concept-map').set('Authorization', who.auth)).body as { assessedCount: number };
  return { plan, weakest, assessed: map.assessedCount };
}

async function startDiagnostic(who: Person): Promise<{ attemptId: string; slotIds: string[] }> {
  const created = await http().post('/v1/assessment/practice-attempts').set('Authorization', who.auth).set('Idempotency-Key', randomUUID()).send({ examProfileVersionId: (await profileOf(who)).examProfileVersionId, selectionStrategy: 'breadth', count: 10 });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const attemptId = created.body.attempt.attemptId as string;
  expect((await http().post(`/v1/assessment/attempts/${attemptId}/start`).set('Authorization', who.auth)).status).toBe(200);
  const served = await http().get(`/v1/assessment/practice-attempts/${attemptId}/package`).set('Authorization', who.auth).buffer(true).parse((res, done) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => done(null, Buffer.concat(chunks)));
  });
  expect(served.status).toBe(200);
  const run = JSON.parse((served.body as Buffer).toString('utf8')) as { slots: Array<{ slotId: string; ordinal: number }> };
  return { attemptId, slotIds: [...run.slots].sort((a, b) => a.ordinal - b.ordinal).map((slot) => slot.slotId) };
}

async function profileOf(who: Person): Promise<{ examProfileVersionId: string }> {
  return (await http().get('/v1/learning/profile').set('Authorization', who.auth)).body.exam as { examProfileVersionId: string };
}

const send = (who: Person, attemptId: string, events: unknown[]) => http().post(`/v1/assessment/attempts/${attemptId}/events`).set('Authorization', who.auth).send({ deviceRef: 'phone', events });
const submit = (who: Person, attemptId: string) => http().post(`/v1/assessment/attempts/${attemptId}/submission`).set('Authorization', who.auth).set('Idempotency-Key', `sub-${attemptId}`).send({ reason: 'manual' });
const mapOf = async (who: Person) => (await http().get('/v1/learning/concept-map').set('Authorization', who.auth)).body as { concepts: Array<{ name: string; path: string[]; standing: { kind: string }; evidenceCount: number }>; assessedCount: number; unassessedCount: number };

describe('from sign-up to the first named weakness (M8-35)', () => {
  it('goes the whole way, in order, and says what each step took on the server', async () => {
    const steps: Array<{ step: string; ms: number }> = [];
    const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
      const began = performance.now();
      const value = await run();
      steps.push({ step, ms: Math.round((performance.now() - began) * 10) / 10 });
      return value;
    };

    const who = await signUp(timed);
    await onboard(who, timed);

    // what home asks decides what to offer: nothing is due, nothing weak, nothing answered, and a scope is declared
    const before = await timed('home decides what to offer', () => askHome(who));
    expect(before.weakest).toEqual([]);
    expect(before.assessed).toBe(0);

    const run = await timed('make and start the diagnostic, and serve its questions', () => startDiagnostic(who));
    expect(run.slotIds).toHaveLength(10);

    // breadth: every topic of the syllabus is in the run, before any has a second question
    // five right and five wrong, so that some topics are weak and some are not
    const choices = run.slotIds.map((_, index) => (index % 2 === 0 ? 'b' : 'a'));
    await timed('send the answers', async () => expect((await send(who, run.attemptId, answersFor(run.slotIds, choices, run.attemptId))).status).toBe(200));
    await timed('submit', async () => expect((await submit(who, run.attemptId)).status).toBe(200));
    await timed('score it and record what it showed (the relay)', settle);

    // and the product said the run was completed, once it was scored, with what the score showed
    const completed = sink.events.filter((event) => event.event_name === 'practice.session_completed' && event.context['attempt_id'] === run.attemptId);
    expect(completed).toHaveLength(1);
    expect(completed[0]).toMatchObject({ surface: 'server', payload: { items_attempted: 10, accuracy: 0.5 } });

    const map = await timed('open where the learner stands', () => mapOf(who));
    expect(map.concepts.map((topic) => topic.name).sort()).toEqual(['Kinematics', 'Mechanics', 'Optics', 'Physics']);
    expect(map.assessedCount).toBe(4);
    // ten answers over four topics, and none has enough behind it to be stated: every standing is the lean of too few
    expect(map.concepts.every((topic) => topic.standing.kind === 'tentative')).toBe(true);
    expect(map.concepts.map((topic) => topic.evidenceCount).sort()).toEqual([2, 2, 3, 3]);

    const weak = await timed('home names the first weakness', async () => {
      const profile = (await http().get('/v1/learning/profile').set('Authorization', who.auth)).body as { exam: { taxonomyVersionId: string } };
      const ids = (await http().get(`/v1/learning/remediation-concepts?taxonomyVersionId=${profile.exam.taxonomyVersionId}`).set('Authorization', who.auth)).body.conceptIdentityIds as string[];
      expect(ids.length).toBeGreaterThan(0);
      const named = await http().get(`/v1/learning/concept-names?taxonomyVersionId=${profile.exam.taxonomyVersionId}&conceptIdentityIds=${ids[0]}`).set('Authorization', who.auth);
      expect(named.status).toBe(200);
      return named.body.concepts[0] as { name: string; path: string[] };
    });
    expect(['Kinematics', 'Mechanics', 'Optics', 'Physics']).toContain(weak.name);
    expect(weak.name).not.toMatch(/^[0-9a-f-]{8,}$/u);

    const total = Math.round(steps.reduce((sum, entry) => sum + entry.ms, 0));
    // the measurement, printed so that a slow step is read and a total does not hide it
    // eslint-disable-next-line no-console
    console.log(`FIRST WEAKNESS JOURNEY (server time, one path, one machine) total ${total} ms\n${steps.map((entry) => `  ${entry.step.padEnd(58)} ${String(entry.ms).padStart(8)} ms`).join('\n')}`);
    expect(steps).toHaveLength(12);
    for (const entry of steps) expect(entry.ms, entry.step).toBeLessThan(10_000);
    expect(total).toBeLessThan(30_000);
  }, 120_000);

  it('spreads the diagnostic across the syllabus: the run reaches every topic before it takes a second from any', async () => {
    const who = await signUp(async (_step, run) => run());
    await onboard(who, async (_step, run) => run());
    const run = await startDiagnostic(who);
    const concepts = await database.pool.query<{ concept_identity_id: string }>(
      `SELECT t.concept_identity_id FROM assessment.attempt_slot s JOIN content.item_taxonomy_tag t ON t.item_version_id = s.item_version_id AND t.is_primary WHERE s.attempt_id = $1 ORDER BY s.ordinal`,
      [run.attemptId],
    );
    const order = concepts.rows.map((row) => row.concept_identity_id);
    expect(order).toHaveLength(10);
    // the first four slots are four different topics, and the last two have only two to choose among
    expect(new Set(order.slice(0, 4)).size).toBe(4);
    const counts = new Map<string, number>();
    for (const concept of order) counts.set(concept, (counts.get(concept) ?? 0) + 1);
    expect([...counts.values()].sort()).toEqual([2, 2, 3, 3]);
  });
});

describe('an abandoned diagnostic (FR-STU-03 rule 4)', () => {
  it('gives a partial map when it is finished with questions left: the topics answered, and not the rest', async () => {
    const who = await signUp(async (_step, run) => run());
    await onboard(who, async (_step, run) => run());
    const run = await startDiagnostic(who);
    // two answered, eight left alone, and the learner finishes
    const choices: (string | null)[] = run.slotIds.map((_, index) => (index < 2 ? 'b' : null));
    expect((await send(who, run.attemptId, answersFor(run.slotIds, choices, run.attemptId))).status).toBe(200);
    expect((await submit(who, run.attemptId)).status).toBe(200);
    await settle();
    const map = await mapOf(who);
    expect(map.concepts).toHaveLength(2);
    expect(map.concepts.every((topic) => topic.evidenceCount === 1)).toBe(true);
    expect(map.assessedCount).toBe(2);
    expect(map.unassessedCount).toBe(2);
  });

  it('gives no map while it is left unfinished: answers given and not yet submitted are not evidence, until the sweep finishes the run for the learner (D116)', async () => {
    const who = await signUp(async (_step, run) => run());
    await onboard(who, async (_step, run) => run());
    const run = await startDiagnostic(who);
    const choices = run.slotIds.map((_, index) => (index < 5 ? 'b' : null));
    expect((await send(who, run.attemptId, answersFor(run.slotIds, choices, run.attemptId))).status).toBe(200);
    await settle();
    expect((await mapOf(who)).concepts).toEqual([]);

    // a day later nothing has happened to the run: within the time it is left alone
    clockAt = '2026-11-05T09:00:00.000Z';
    await background.scheduler.tick(new Date(clockAt));
    await settle();
    expect((await mapOf(who)).concepts).toEqual([]);

    // three days on, the sweep finishes it for the learner, by the same path their own finishing takes, and their answers are in the map
    clockAt = '2026-11-08T09:00:00.000Z';
    await background.scheduler.tick(new Date(clockAt));
    await settle();
    const map = await mapOf(who);
    expect(map.concepts.length).toBeGreaterThanOrEqual(4);
    expect(map.assessedCount).toBe(4);
    const said = sink.events.filter((event) => event.context['attempt_id'] === run.attemptId).map((event) => event.event_name);
    expect(said).toEqual(['practice.session_abandoned']);
    const abandoned = sink.events.find((event) => event.event_name === 'practice.session_abandoned' && event.context['attempt_id'] === run.attemptId)!;
    // five attempted, all right; the event is the sweep's reading of how the run ended, and the run is not also said to be completed
    expect(abandoned.payload).toMatchObject({ items_attempted: 5, accuracy: 1 });
    clockAt = NOW;
  });
});
