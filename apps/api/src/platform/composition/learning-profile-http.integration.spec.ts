import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issue } from '../auth/token.js';
import { parseRouteLimitsOrThrow } from '../config/config.js';
import { createRecordingTelemetry } from '../observability/recording-telemetry.js';
import { createApplication } from './app-factory.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { itemContent, publishItem } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { seedPublishedSyllabus, type PublishedSyllabus } from '../../testing/published-syllabus.js';
import { tokenPrincipals } from '../../testing/service-tokens.js';

/**
 * Onboarding through the composed application (M8-20): real bearer tokens, the real principal resolver, real Postgres, and a published syllabus behind Curriculum's seam.
 * What is held here is what the brief asks of it. The profile is read and advanced over HTTP; where a learner was is what the profile holds; skipping is an answer and
 * never a gate, and a learner who skipped everything reads the review plan, the remediation and the practice route as before; every step is limited, and the limit is
 * the configured one.
 */
let database: TestDatabase;
let app: INestApplication;
let syllabus: PublishedSyllabus;

const config = { ...COMPOSED_CONFIG, rateLimitProfile: parseRouteLimitsOrThrow('source=1000/1m;subject=4/1m', true) };

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  syllabus = await seedPublishedSyllabus(database, { examCode: `JEE_${randomUUID().slice(0, 8).toUpperCase().replaceAll('-', '')}`, academicYear: '2026' });
  app = await createApplication(config, {
    pool: database.pool,
    principals: tokenPrincipals(config),
    telemetry: createRecordingTelemetry(),
    clock: { now: () => new Date('2026-11-04T09:00:00.000Z') },
    identifiers: uuidFactory,
  });
  await serveOnLoopback(app);
});
afterAll(async () => {
  await app.close();
  // a practice run leaves an attempt and its ledger rows, which a revert refuses to drop over
  await database.pool.query('TRUNCATE assessment.attempt, assessment.exposure_ledger_entry CASCADE');
  await database.revertMigrations();
  await database.close();
});

function learner(): string {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${issue({ sub: randomUUID(), kind: 'human', roles: ['learner'], iat: now, exp: now + 3600, iss: config.authIssuer, jti: randomUUID() }, { signingKey: config.authSigningKey, issuer: config.authIssuer })}`;
}
const http = () => request(app.getHttpServer());
const data = (body: { data?: unknown }) => (body.data ?? body) as Record<string, any>;

describe('a learner advances a profile over HTTP', () => {
  it('starts with nothing, is told what comes next, and is told it again after each step from what the profile holds', async () => {
    const auth = learner();
    const first = await http().get('/v1/learning/profile').set('Authorization', auth).expect(200);
    expect(data(first.body).onboarding).toMatchObject({ next: 'exam', skipped: false });

    const exam = await http().patch('/v1/learning/profile').set('Authorization', auth).send({ examCode: syllabus.examCode, targetYear: '2026' }).expect(200);
    expect(data(exam.body)).toMatchObject({ exam: { examCode: syllabus.examCode, targetYear: '2026', taxonomyVersionId: syllabus.taxonomyVersionId }, onboarding: { next: 'class' } });

    // a later session sees where the learner was without having been told: it is read, not remembered
    const again = await http().get('/v1/learning/profile').set('Authorization', auth).expect(200);
    expect(data(again.body).onboarding.next).toBe('class');

    const done = await http().patch('/v1/learning/profile').set('Authorization', auth).send({ currentClass: 'class_12', scopeNodeIds: [syllabus.nodes.mechanics] }).expect(200);
    expect(data(done.body)).toMatchObject({ currentClass: 'class_12', scope: { status: 'in_force', taxonomyVersionId: syllabus.taxonomyVersionId }, onboarding: { next: null } });
  });

  it('offers the exams and the chapters a learner can choose, to a learner', async () => {
    const auth = learner();
    const choices = await http().get('/v1/learning/profile/exam-choices').set('Authorization', auth).expect(200);
    expect(JSON.stringify(choices.body)).toContain(syllabus.examCode);
    await http().patch('/v1/learning/profile').set('Authorization', auth).send({ examCode: syllabus.examCode, targetYear: '2026' }).expect(200);
    const options = await http().get('/v1/learning/profile/scope-options').set('Authorization', auth).expect(200);
    expect(JSON.stringify(options.body)).toContain(syllabus.nodes.optics);
  });

  it('refuses a body with a field the route does not know, and an exam that is not offered, in the problem shape', async () => {
    const auth = learner();
    const unknown = await http().patch('/v1/learning/profile').set('Authorization', auth).send({ examCode: 'X', surprise: true }).expect(400);
    expect(unknown.body).toMatchObject({ status: 400 });
    const absent = await http().patch('/v1/learning/profile').set('Authorization', auth).send({ examCode: 'NO_SUCH_EXAM', targetYear: '2026' });
    expect(absent.status).toBe(400);
    expect(JSON.stringify(absent.body)).toContain('EXAM_NOT_AVAILABLE');
  });

  it('is for a learner: no token is 401, and a role that is not a learner is 403', async () => {
    await http().get('/v1/learning/profile').expect(401);
    const now = Math.floor(Date.now() / 1000);
    const ops = `Bearer ${issue({ sub: randomUUID(), kind: 'human', roles: ['content_ops'], iat: now, exp: now + 3600, iss: config.authIssuer, jti: randomUUID() }, { signingKey: config.authSigningKey, issuer: config.authIssuer })}`;
    await http().get('/v1/learning/profile').set('Authorization', ops).expect(403);
  });
});

describe('skipping is an answer, never a gate (FR-STU-01)', () => {
  it('a learner who skips everything is told so, and reads every learner route as before', async () => {
    const auth = learner();
    const skipped = await http().post('/v1/learning/profile/skip').set('Authorization', auth).expect(200);
    expect(data(skipped.body).onboarding).toMatchObject({ skipped: true });

    // nothing the learner can do afterwards asks for an exam, a class or a scope
    const profile = await http().get('/v1/learning/profile').set('Authorization', auth).expect(200);
    expect(data(profile.body)).toMatchObject({ exam: null, scope: null, onboarding: { skipped: true } });
    await http().get('/v1/learning/review-plan').set('Authorization', auth).expect(200);
    await http().get(`/v1/learning/remediation-concepts?taxonomyVersionId=${syllabus.taxonomyVersionId}`).set('Authorization', auth).expect(200);
    await http().get('/v1/learning/bookmarks').set('Authorization', auth).expect(200);
    await http().get('/v1/learning/error-entries').set('Authorization', auth).expect(200);

    // and practice is begun: the run is made of published items with no profile behind the learner
    await publishItem(database.pool, itemContent('A block slides down a frictionless ramp. What is its acceleration?'));
    const run = await http().post('/v1/assessment/practice-attempts').set('Authorization', auth).set('Idempotency-Key', randomUUID()).send({ examProfileVersionId: syllabus.profileVersionId, selectionStrategy: 'filtered', scopeFilter: {}, difficultyBand: 'moderate', count: 1 });
    expect(run.status, JSON.stringify(run.body)).toBe(201);
    expect(run.body.attempt).toMatchObject({ mode: 'practice', slotCount: 1 });
  });

  it('choosing something afterwards undoes the skip: the profile is what the learner has said, not a wall', async () => {
    const auth = learner();
    await http().post('/v1/learning/profile/skip').set('Authorization', auth).expect(200);
    const chosen = await http().patch('/v1/learning/profile').set('Authorization', auth).send({ currentClass: 'repeater' }).expect(200);
    expect(data(chosen.body).onboarding.skipped).toBe(false);
  });
});

describe('every step is limited, by the configured limit', () => {
  it('answers 429 with Retry-After once a subject has used the four a minute the configuration gives it, and another learner is not affected', async () => {
    const heavy = learner();
    for (let i = 0; i < 4; i += 1) await http().get('/v1/learning/profile').set('Authorization', heavy).expect(200);
    const refused = await http().get('/v1/learning/profile').set('Authorization', heavy).expect(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    await http().get('/v1/learning/profile').set('Authorization', learner()).expect(200);
  });

  it('limits the other four profile routes by the same limit', async () => {
    const auth = learner();
    for (let i = 0; i < 4; i += 1) await http().post('/v1/learning/profile/skip').set('Authorization', auth).expect(200);
    await http().post('/v1/learning/profile/skip').set('Authorization', auth).expect(429);
    await http().patch('/v1/learning/profile').set('Authorization', auth).send({ currentClass: 'class_11' }).expect(429);
    await http().get('/v1/learning/profile/exam-choices').set('Authorization', auth).expect(429);
    await http().get('/v1/learning/profile/scope-options').set('Authorization', auth).expect(429);
  });
});
