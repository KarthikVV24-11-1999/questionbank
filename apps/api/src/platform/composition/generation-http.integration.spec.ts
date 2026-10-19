import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import request from 'supertest';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '../auth/roles.js';
import { issue } from '../auth/token.js';
import { PostgresGenerationCandidateRepository } from '../../contexts/generation/infrastructure/generation-candidate.repository.js';
import { recordVerdict } from '../../contexts/generation/domain/generation-candidate.js';
import { BLOCKING_PRECHECKS } from '../../contexts/generation/domain/precheck-vocabulary.js';
import type { GenerationRunRepository } from '../../contexts/generation/domain/repository-ports.js';
import { composeGeneration, type ComposedGeneration } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectValue } from '../../testing/expect-result.js';
import { MODEL_VERSION, PROMPT_VERSION, aCandidate, aRun, ensureVersions, registering } from '../../testing/generation-fixtures.js';

/**
 * The generation HTTP surface through the composed application: real bearer tokens,
 * the real principal resolver, the real registry, real Postgres (M5-38).
 *
 * It proves what the contract spec cannot: that the routes the document lists are the
 * routes that answer, that a response has the shape the document declares, and that
 * everything the document does not list is not there to be reached.
 */
const SIGNING_KEY = 'a'.repeat(32);
const ISSUER = 'questionbank';
const SPEC = parse(readFileSync(fileURLToPath(new URL('../../../../../packages/contracts/openapi/generation.yaml', import.meta.url)), 'utf8')) as {
  components: { schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }> };
};

let database: TestDatabase;
let composed: ComposedGeneration;
let runs: GenerationRunRepository;
let candidates: PostgresGenerationCandidateRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  await ensureVersions(database.pool, { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION });
  composed = await composeGeneration(database);
  await composed.app.init();
  runs = registering(database.pool);
  candidates = new PostgresGenerationCandidateRepository(database.pool);
});

afterAll(async () => {
  await composed.close();
  await database.revertMigrations();
  await database.close();
});

function tokenFor(...roles: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  return issue({ sub: randomUUID(), kind: 'human', roles, iat: now, exp: now + 3600, iss: ISSUER, jti: randomUUID() }, { signingKey: SIGNING_KEY, issuer: ISSUER });
}

const http = () => request(composed.app.getHttpServer());
const asOps = () => `Bearer ${tokenFor(ROLES.contentOps)}`;

async function stored() {
  const run = aRun();
  expectValue(await runs.save(run));
  const candidate = aCandidate(run);
  expectValue(await candidates.save(candidate));
  return { run, candidate };
}

function expectShape(body: Record<string, unknown>, schema: string): void {
  const declared = SPEC.components.schemas[schema]!;
  expect(Object.keys(body).sort(), schema).toEqual(expect.arrayContaining([...(declared.required ?? [])].sort()));
  for (const key of Object.keys(body)) expect(Object.keys(declared.properties), `${schema}.${key}`).toContain(key);
}

describe('POST /v1/authoring/generation-runs', () => {
  const body = () => ({ modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: { itemType: 'single_choice' }, budgetTokens: 10_000 });

  it('starts a run for Content Ops, with the pin the system supplied and the shape the document declares', async () => {
    const response = await http().post('/v1/authoring/generation-runs').set('Authorization', asOps()).set('X-Correlation-Id', 'corr-http-1').send(body());

    expect(response.status).toBe(201);
    expect(response.headers['x-correlation-id']).toBe('corr-http-1');
    expectShape(response.body, 'GenerationRun');
    expectShape(response.body.pin, 'ModelPin');
    expect(response.body.pin.modelVersionId).toBe(MODEL_VERSION);
    expect(response.body.pin.promptVersionId).toBe(PROMPT_VERSION);
    expect(response.body.pin.runId).toMatch(/^[0-9a-f-]{36}$/u);
    expect(response.body.request).toEqual({ itemType: 'single_choice' });
    const audit = await database.pool.query(`SELECT action FROM platform.audit_record WHERE target_context = 'generation' AND correlation_id = 'corr-http-1'`);
    expect(audit.rows).toEqual([{ action: 'StartGenerationRun' }]);
  });

  it('refuses a run that would exceed its month’s budget with a precondition problem, and writes nothing (M5-41)', async () => {
    const before = (await database.pool.query(`SELECT count(*)::int AS n FROM ai.generation_run`)).rows[0].n as number;
    // The composed application declares 1,000,000,000 tokens for the month; this asks for more than that.
    const response = await http().post('/v1/authoring/generation-runs').set('Authorization', asOps()).set('X-Correlation-Id', 'corr-http-budget').send({ ...body(), budgetTokens: 2_000_000_000 });

    expect(response.status).toBe(412);
    expect(response.body).toMatchObject({ code: 'PreconditionFailed', retryable: false, correlationId: 'corr-http-budget' });
    expect(response.body.detail).toContain('2000000000');
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM ai.generation_run`)).rows[0].n).toBe(before);
  });

  it('requires a reservation: a body without budgetTokens is a validation problem naming it', async () => {
    const { budgetTokens: _omitted, ...withoutReservation } = body();
    const response = await http().post('/v1/authoring/generation-runs').set('Authorization', asOps()).send(withoutReservation);
    expect(response.status).toBe(400);
    expect(response.body.detail).toContain('budgetTokens');
  });

  it('refuses a caller-chosen run id or timestamp, so a request cannot claim a pin it was not given', async () => {
    for (const extra of [{ runId: randomUUID() }, { requestedAt: '2020-01-01T00:00:00.000Z' }, { pin: { runId: randomUUID() } }]) {
      const response = await http().post('/v1/authoring/generation-runs').set('Authorization', asOps()).send({ ...body(), ...extra });
      expect(response.status, JSON.stringify(extra)).toBe(400);
      expect(response.type).toBe('application/problem+json');
    }
  });

  it('answers a malformed body with Problem Details naming the field, retryable false and the correlation id', async () => {
    const response = await http().post('/v1/authoring/generation-runs').set('Authorization', asOps()).set('X-Correlation-Id', 'corr-http-2').send({ ...body(), promptVersionId: 'nope' });
    expect(response.status).toBe(400);
    expect(response.body).toMatchObject({ code: 'Validation', retryable: false, correlationId: 'corr-http-2' });
    expect(response.body.detail).toContain('promptVersionId');
  });
});

describe('GET /v1/authoring/generation-candidates/:candidateId and /v1/authoring/generation-runs/:runId/candidates', () => {
  it('returns a stored candidate with every field the document declares', async () => {
    const { candidate } = await stored();
    const response = await http().get(`/v1/authoring/generation-candidates/${candidate.candidateId}`).set('Authorization', asOps());

    expect(response.status).toBe(200);
    expectShape(response.body, 'GenerationCandidate');
    expectShape(response.body.content, 'ProposedContent');
    expect(response.body).toMatchObject({ candidateId: candidate.candidateId, state: 'proposed', confidence: 0.85, pin: candidate.pin });
  });

  it('lists a run’s candidates, and an empty run as an empty array', async () => {
    const { run, candidate } = await stored();
    const listed = await http().get(`/v1/authoring/generation-runs/${run.pin.runId}/candidates`).set('Authorization', asOps());
    expect(listed.status).toBe(200);
    expect(listed.body.map((entry: { candidateId: string }) => entry.candidateId)).toEqual([candidate.candidateId]);

    const empty = await http().get(`/v1/authoring/generation-runs/${randomUUID()}/candidates`).set('Authorization', asOps());
    expect(empty.status).toBe(200);
    expect(empty.body).toEqual([]);
  });

  it('leaves a candidate that failed a blocking check out of the list, and still serves it by id (M5-39)', async () => {
    const { run, candidate } = await stored();
    const failed = expectValue(recordVerdict(candidate, { check: 'answer_verification', outcome: 'fail', detail: 'solve 1 answered "c"' }));
    expectValue(await candidates.save(failed));

    const listed = await http().get(`/v1/authoring/generation-runs/${run.pin.runId}/candidates`).set('Authorization', asOps());
    expect(listed.status).toBe(200);
    expect(listed.body).toEqual([]);

    const read = await http().get(`/v1/authoring/generation-candidates/${candidate.candidateId}`).set('Authorization', asOps());
    expect(read.status).toBe(200);
    expect(read.body.verdicts).toEqual([{ check: 'answer_verification', outcome: 'fail', detail: 'solve 1 answered "c"' }]);
  });

  it('answers a candidate that does not exist as NotFound, and a non-UUID as a validation problem', async () => {
    const missing = await http().get(`/v1/authoring/generation-candidates/${randomUUID()}`).set('Authorization', asOps());
    expect(missing.status).toBe(404);
    expect(missing.body.code).toBe('NotFound');
    const malformed = await http().get('/v1/authoring/generation-candidates/not-a-uuid').set('Authorization', asOps());
    expect(malformed.status).toBe(400);
    expect(malformed.body.code).toBe('Validation');
  });
});

describe('who may reach it — nothing here is student-facing (INV-01)', () => {
  const surface = async () => {
    const { run, candidate } = await stored();
    return [
      ['post', '/v1/authoring/generation-runs'],
      ['get', `/v1/authoring/generation-runs/${run.pin.runId}/candidates`],
      ['get', `/v1/authoring/generation-candidates/${candidate.candidateId}`],
    ] as const;
  };
  const call = (method: 'get' | 'post', path: string, authorization?: string) => {
    const pending = http()[method](path);
    return (authorization === undefined ? pending : pending.set('Authorization', authorization)).send(
      method === 'post' ? { modelVersionId: MODEL_VERSION, promptVersionId: PROMPT_VERSION, request: {}, budgetTokens: 10_000 } : undefined,
    );
  };

  it('refuses an unauthenticated request on every route with 401', async () => {
    for (const [method, path] of await surface()) {
      const response = await call(method, path);
      expect(response.status, path).toBe(401);
      expect(response.body.code, path).toBe('Authentication');
    }
  });

  it('refuses a learner and a guest on every route with 403', async () => {
    for (const role of [ROLES.learner, ROLES.guest]) {
      for (const [method, path] of await surface()) {
        expect((await call(method, path, `Bearer ${tokenFor(role)}`)).status, `${role} ${path}`).toBe(403);
      }
    }
  });

  it('lets the machine start a run but not read a candidate, which carries the answer key', async () => {
    const [start, list, get] = await surface();
    const pipeline = `Bearer ${tokenFor(ROLES.generationPipeline)}`;
    expect((await call(start[0], start[1], pipeline)).status).toBe(201);
    expect((await call(list[0], list[1], pipeline)).status).toBe(403);
    expect((await call(get[0], get[1], pipeline)).status).toBe(403);
  });
});

describe('F33 — what is not on the surface is not there', () => {
  it('has no route that proposes, runs the battery, writes a verdict or disposes', async () => {
    const { run, candidate } = await stored();
    const attempts: [string, string][] = [
      ['post', `/v1/authoring/generation-runs/${run.pin.runId}/candidates`],
      ['post', `/v1/authoring/generation-runs/${run.pin.runId}/proposals`],
      ['post', `/v1/authoring/generation-candidates/${candidate.candidateId}/prechecks`],
      ['post', `/v1/authoring/generation-candidates/${candidate.candidateId}/verdicts`],
      ['post', `/v1/authoring/generation-candidates/${candidate.candidateId}/disposition`],
      ['post', `/v1/authoring/generation-candidates/${candidate.candidateId}/dispose`],
      ['put', `/v1/authoring/generation-candidates/${candidate.candidateId}`],
      ['delete', `/v1/authoring/generation-candidates/${candidate.candidateId}`],
    ];
    for (const [method, path] of attempts) {
      const response = await (http() as unknown as Record<string, (path: string) => request.Test>)[method]!(path).set('Authorization', asOps()).send({});
      expect(response.status, `${method} ${path}`).toBe(404);
    }
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });
});

describe('the operator’s override — accept and reject by hand (M5-40, ADR-0029)', () => {
  /** A proposal content's own handlers take: the recorded ramp question, so acceptance really creates a draft. */
  async function checked() {
    const run = aRun();
    expectValue(await runs.save(run));
    const body = (JSON.parse(readFileSync(fileURLToPath(new URL('../../contexts/generation/infrastructure/provider/recordings/kinematics-ramp.json', import.meta.url)), 'utf8')) as { response: { body: Record<string, unknown> } }).response.body;
    let current = aCandidate(run, { body });
    for (const check of BLOCKING_PRECHECKS) current = expectValue(recordVerdict(current, { check, outcome: 'pass' }));
    expectValue(await candidates.save(current));
    return { run, candidate: current };
  }
  const withBody = (route: string) => (candidateId: string) => `/v1/authoring/generation-candidates/${candidateId}/${route}`;
  const acceptance = withBody('acceptance');
  const rejection = withBody('rejection');

  it('accepts a candidate whose blocking checks passed, for Content Ops, naming the draft', async () => {
    const { candidate } = await checked();
    const response = await http().post(acceptance(candidate.candidateId)).set('Authorization', asOps()).set('X-Correlation-Id', 'corr-http-accept').send();

    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(response.headers['x-correlation-id']).toBe('corr-http-accept');
    expectShape(response.body, 'AcceptedCandidate');
    const queued = await database.pool.query(`SELECT lifecycle_state FROM content.item WHERE item_id = $1`, [response.body.contentItemId]);
    expect(queued.rows).toEqual([{ lifecycle_state: 'in_review' }]);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('accepted');
  });

  it('refuses a candidate that failed a blocking check with a precondition problem, and creates nothing', async () => {
    const { candidate } = await stored();
    const failed = expectValue(recordVerdict(candidate, { check: 'answer_verification', outcome: 'fail' }));
    expectValue(await candidates.save(failed));
    const before = (await database.pool.query(`SELECT count(*)::int AS n FROM content.item`)).rows[0].n as number;

    const response = await http().post(acceptance(candidate.candidateId)).set('Authorization', asOps()).send();

    expect(response.status).toBe(412);
    expect(response.body.code).toBe('PreconditionFailed');
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM content.item`)).rows[0].n).toBe(before);
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });

  it('rejects a candidate for Content Ops, terminally, with the shape the document declares', async () => {
    const { candidate } = await stored();
    const response = await http().post(rejection(candidate.candidateId)).set('Authorization', asOps()).send();

    expect(response.status).toBe(200);
    expectShape(response.body, 'GenerationCandidate');
    expect(response.body.state).toBe('rejected');
    const again = await http().post(rejection(candidate.candidateId)).set('Authorization', asOps()).send();
    expect(again.status).toBe(422);
  });

  it('is Content Ops’ alone: the machine, a learner, a guest and a stranger are refused, and the candidate is untouched', async () => {
    const { candidate } = await checked();
    for (const route of [acceptance, rejection]) {
      const unauthenticated = await http().post(route(candidate.candidateId)).send();
      expect(unauthenticated.status).toBe(401);
      for (const role of [ROLES.generationPipeline, ROLES.learner, ROLES.guest]) {
        const response = await http().post(route(candidate.candidateId)).set('Authorization', `Bearer ${tokenFor(role)}`).send();
        expect(response.status, `${role} ${route(candidate.candidateId)}`).toBe(403);
      }
    }
    expect(expectValue(await candidates.findById(candidate.candidateId)).state).toBe('proposed');
  });

  it('answers a candidate that does not exist as NotFound and a non-UUID as a validation problem', async () => {
    expect((await http().post(acceptance(randomUUID())).set('Authorization', asOps()).send()).status).toBe(404);
    expect((await http().post(rejection('not-a-uuid')).set('Authorization', asOps()).send()).status).toBe(400);
  });
});
