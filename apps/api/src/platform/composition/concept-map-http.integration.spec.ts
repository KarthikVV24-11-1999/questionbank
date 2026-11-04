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
 * The concept map and the names behind it, through the composed application (M8-28, M8-29): real bearer tokens, the real principal resolver, real Postgres, and a published syllabus behind
 * Curriculum's seam. A learner with answers on a topic is told what the topic is called and where it sits, never a bare identifier; decay is applied when the map is read; the declared scope
 * marks the map and does not filter it; the answers behind a state are a page at a time; and every route is the caller's own.
 */
let database: TestDatabase;
let app: INestApplication;
let syllabus: PublishedSyllabus;
let clockAt = '2026-11-04T09:00:00.000Z';

const config = { ...COMPOSED_CONFIG, rateLimitProfile: parseRouteLimitsOrThrow('source=1000/1m;subject=1000/1m', true) };

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  syllabus = await seedPublishedSyllabus(database, { examCode: `JEE_${randomUUID().slice(0, 8).toUpperCase().replaceAll('-', '')}`, academicYear: '2026' });
  app = await createApplication(config, {
    pool: database.pool,
    principals: tokenPrincipals(config),
    telemetry: createRecordingTelemetry(),
    clock: { now: () => new Date(clockAt) },
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

function learner(): { auth: string; id: string } {
  const now = Math.floor(Date.now() / 1000);
  const id = randomUUID();
  return { id, auth: `Bearer ${issue({ sub: id, kind: 'human', roles: ['learner'], iat: now, exp: now + 3600, iss: config.authIssuer, jti: randomUUID() }, { signingKey: config.authSigningKey, issuer: config.authIssuer })}` };
}
const http = () => request(app.getHttpServer());
const data = (body: { data?: unknown }) => (body.data ?? body) as Record<string, any>;

async function chooseExam(who: { auth: string }, scopeNodeIds?: string[]): Promise<void> {
  await http().patch('/v1/learning/profile').set('Authorization', who.auth).send({ examCode: syllabus.examCode, targetYear: '2026', ...(scopeNodeIds === undefined ? {} : { currentClass: 'class_12', scopeNodeIds }) }).expect(200);
}

/** Answers a learner has given on a topic, and the state they made: written as the relay's recorder writes them, which the recorder's own specs hold to the evidence. */
async function answers(who: { id: string }, conceptIdentityId: string, outcomes: Array<'correct' | 'incorrect'>, state: string, lowConfidence = false): Promise<string[]> {
  const ids: string[] = [];
  for (const [minute, outcome] of outcomes.entries()) {
    const id = randomUUID();
    ids.push(id);
    await database.pool.query(
      `INSERT INTO learning.mastery_evidence (evidence_id, learner_ref, attempt_ref, slot_ref, item_version_ref, concept_identity_id, taxonomy_version_id, outcome, difficulty_estimate, occurred_at, scored_at, recorded_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'moderate', $9, $9, $9)`,
      [id, who.id, randomUUID(), `slot-${id}`, randomUUID(), conceptIdentityId, syllabus.taxonomyVersionId, outcome, new Date(Date.UTC(2026, 10, 1, 9, minute))],
    );
  }
  const { rows } = await database.pool.query<{ rule_set_id: string }>('SELECT rule_set_id FROM learning.mastery_rule_set LIMIT 1');
  await database.pool.query(
    `INSERT INTO learning.concept_state (learner_ref, taxonomy_version_id, concept_identity_id, state, raw_state, confidence, base_confidence, low_confidence, evidence_count, distinct_item_count, distinct_session_count, last_evidence_at, decay_applied_at, rule_set_id)
     VALUES ($1, $2, $3, $4, $4, 0.8, 0.8, $5, $6, $6, 2, '2026-11-01T09:30:00Z', '2026-11-01T09:30:00Z', $7)`,
    [who.id, syllabus.taxonomyVersionId, conceptIdentityId, state, lowConfidence, outcomes.length, rows[0]?.rule_set_id],
  );
  return ids;
}

describe('the concept map over HTTP (M8-28)', () => {
  it('names each topic with the chapter and subject it sits under, and never shows a bare identifier as its name', async () => {
    const who = learner();
    await chooseExam(who);
    await answers(who, syllabus.concepts.kinematics, ['incorrect', 'incorrect', 'correct', 'incorrect', 'incorrect', 'incorrect', 'incorrect', 'incorrect'], 'weak');
    await answers(who, syllabus.concepts.optics, ['correct'], 'developing', true);
    const map = await http().get('/v1/learning/concept-map').set('Authorization', who.auth).expect(200);
    expect(map.headers['cache-control']).toBe('no-store');
    const view = data(map.body);
    expect(view.concepts.map((c: any) => [c.name, c.path])).toEqual([['Kinematics', ['Physics', 'Mechanics']], ['Optics', ['Physics']]]);
    expect(view).toMatchObject({ assessedCount: 2, unassessedCount: 2 });
    const kinematics = view.concepts.find((c: any) => c.name === 'Kinematics');
    expect(kinematics).toMatchObject({ conceptIdentityId: syllabus.concepts.kinematics, standing: { kind: 'asserted', state: 'weak' }, evidenceCount: 8, inDeclaredScope: null });
    // a state with too few answers behind it is not asserted: it has no state field to read
    const optics = view.concepts.find((c: any) => c.name === 'Optics');
    expect(optics.standing).toEqual({ kind: 'tentative', leaning: 'developing' });
    expect(Object.keys(view.concepts[0]).sort()).toEqual(['conceptIdentityId', 'evidenceCount', 'inDeclaredScope', 'lastEvidenceAt', 'name', 'path', 'standing']);
  });

  it('reads at the instant of the call: the same stored states, a year on, say the strong one has slipped', async () => {
    const who = learner();
    await chooseExam(who);
    const outcomes = Array.from({ length: 12 }, () => 'correct' as const);
    await answers(who, syllabus.concepts.mechanics, outcomes, 'strong');
    clockAt = '2026-11-04T09:00:00.000Z';
    const soon = data((await http().get('/v1/learning/concept-map').set('Authorization', who.auth).expect(200)).body).concepts[0];
    clockAt = '2028-01-04T09:00:00.000Z';
    const later = data((await http().get('/v1/learning/concept-map').set('Authorization', who.auth).expect(200)).body);
    clockAt = '2026-11-04T09:00:00.000Z';
    expect(soon.standing).toMatchObject({ kind: 'asserted', state: 'strong' });
    expect(later.concepts[0].standing).toMatchObject({ kind: 'asserted', state: 'developing' });
    expect(later.asOf).toBe('2028-01-04T09:00:00.000Z');
  });

  it('marks what is inside the declared syllabus and does not hide what is outside it', async () => {
    const who = learner();
    await chooseExam(who, [syllabus.nodes.mechanics]);
    await answers(who, syllabus.concepts.kinematics, ['correct', 'correct'], 'developing', true);
    await answers(who, syllabus.concepts.optics, ['correct', 'incorrect'], 'developing', true);
    const view = data((await http().get('/v1/learning/concept-map').set('Authorization', who.auth).expect(200)).body);
    expect(view.concepts.map((c: any) => [c.name, c.inDeclaredScope])).toEqual([['Kinematics', true], ['Optics', false]]);
  });

  it('is empty for a learner with no answers, and asks a learner with no exam to choose one', async () => {
    const who = learner();
    const bare = await http().get('/v1/learning/concept-map').set('Authorization', who.auth);
    expect(bare.status).toBe(412);
    expect(JSON.stringify(bare.body)).toContain('NO_EXAM_CHOSEN');
    await chooseExam(who);
    expect(data((await http().get('/v1/learning/concept-map').set('Authorization', who.auth).expect(200)).body)).toMatchObject({ concepts: [], assessedCount: 0, unassessedCount: 4 });
  });

  it('is the caller\'s own: another learner\'s answers are not on it', async () => {
    const mine = learner();
    const theirs = learner();
    await chooseExam(mine);
    await chooseExam(theirs);
    await answers(theirs, syllabus.concepts.kinematics, ['incorrect'], 'weak', true);
    expect(data((await http().get('/v1/learning/concept-map').set('Authorization', mine.auth).expect(200)).body).concepts).toEqual([]);
  });

  it('is for a learner: no token is 401, and a role that is not a learner is 403', async () => {
    await http().get('/v1/learning/concept-map').expect(401);
    const now = Math.floor(Date.now() / 1000);
    const admin = `Bearer ${issue({ sub: randomUUID(), kind: 'human', roles: ['admin'], iat: now, exp: now + 3600, iss: config.authIssuer, jti: randomUUID() }, { signingKey: config.authSigningKey, issuer: config.authIssuer })}`;
    await http().get('/v1/learning/concept-map').set('Authorization', admin).expect(403);
    await http().get(`/v1/learning/concept-map/${syllabus.concepts.optics}/evidence`).set('Authorization', admin).expect(403);
    await http().get(`/v1/learning/concept-names?taxonomyVersionId=${syllabus.taxonomyVersionId}&conceptIdentityIds=`).set('Authorization', admin).expect(403);
  });
});

describe('the answers behind a state over HTTP (M8-28, FR-STU-04 rule 1)', () => {
  it('gives the topic\'s name and standing, and its answers newest first, a page at a time', async () => {
    const who = learner();
    await chooseExam(who);
    const ids = await answers(who, syllabus.concepts.kinematics, ['correct', 'incorrect', 'correct', 'incorrect', 'correct'], 'developing', true);
    const first = data((await http().get(`/v1/learning/concept-map/${syllabus.concepts.kinematics}/evidence?limit=2`).set('Authorization', who.auth).expect(200)).body);
    expect(first).toMatchObject({ concept: { name: 'Kinematics', path: ['Physics', 'Mechanics'] }, standing: { kind: 'tentative', leaning: 'developing' }, evidenceCount: 5, total: 5, limit: 2, offset: 0 });
    expect(first.responses.map((r: any) => r.evidenceId)).toEqual([ids[4], ids[3]]);
    const rest = data((await http().get(`/v1/learning/concept-map/${syllabus.concepts.kinematics}/evidence?limit=2&offset=4`).set('Authorization', who.auth).expect(200)).body);
    expect(rest.responses.map((r: any) => r.evidenceId)).toEqual([ids[0]]);
  });

  it('answers a topic the caller has no answers on as nothing to show, even when another learner has', async () => {
    const mine = learner();
    const theirs = learner();
    await chooseExam(mine);
    await chooseExam(theirs);
    await answers(theirs, syllabus.concepts.kinematics, ['correct'], 'developing', true);
    const none = await http().get(`/v1/learning/concept-map/${syllabus.concepts.kinematics}/evidence`).set('Authorization', mine.auth);
    expect(none.status).toBe(404);
    expect(JSON.stringify(none.body)).toContain('CONCEPT_NOT_ASSESSED');
  });

  it('refuses a page that is not a page, in the problem shape', async () => {
    const who = learner();
    await chooseExam(who);
    for (const query of ['limit=0', 'limit=101', 'limit=abc', 'offset=-1', 'surprise=1']) {
      const refused = await http().get(`/v1/learning/concept-map/${syllabus.concepts.optics}/evidence?${query}`).set('Authorization', who.auth);
      expect([query, refused.status]).toEqual([query, 400]);
    }
    expect((await http().get('/v1/learning/concept-map/not-an-id/evidence').set('Authorization', who.auth)).status).toBe(400);
  });
});

describe('what topics are called, over HTTP (M8-29)', () => {
  it('names the topics asked for, in the order asked, with the chapter and subject above them', async () => {
    const who = learner();
    const named = await http().get(`/v1/learning/concept-names?taxonomyVersionId=${syllabus.taxonomyVersionId}&conceptIdentityIds=${syllabus.concepts.kinematics},${syllabus.concepts.optics}`).set('Authorization', who.auth).expect(200);
    expect(data(named.body).concepts).toEqual([
      { conceptIdentityId: syllabus.concepts.kinematics, name: 'Kinematics', path: ['Physics', 'Mechanics'] },
      { conceptIdentityId: syllabus.concepts.optics, name: 'Optics', path: ['Physics'] },
    ]);
    expect(data((await http().get(`/v1/learning/concept-names?taxonomyVersionId=${syllabus.taxonomyVersionId}&conceptIdentityIds=`).set('Authorization', who.auth).expect(200)).body).concepts).toEqual([]);
  });

  it('refuses what it cannot name, and a request that is not one', async () => {
    const who = learner();
    const stranger = await http().get(`/v1/learning/concept-names?taxonomyVersionId=${syllabus.taxonomyVersionId}&conceptIdentityIds=${randomUUID()}`).set('Authorization', who.auth);
    expect(stranger.status).toBe(404);
    expect((await http().get('/v1/learning/concept-names?conceptIdentityIds=').set('Authorization', who.auth)).status).toBe(400);
    expect((await http().get(`/v1/learning/concept-names?taxonomyVersionId=${syllabus.taxonomyVersionId}&conceptIdentityIds=nope`).set('Authorization', who.auth)).status).toBe(400);
  });
});
