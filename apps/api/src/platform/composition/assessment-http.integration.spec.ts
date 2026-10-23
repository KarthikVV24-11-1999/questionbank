import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { parse } from 'yaml';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '../auth/roles.js';
import { issue } from '../auth/token.js';
import { createRecordingTelemetry } from '../observability/recording-telemetry.js';
import { createApplication } from './app-factory.js';
import { addAnchorPoolMember } from '../../contexts/assessment/domain/anchor-pool.js';
import { PostgresAnchorPoolRepository } from '../../contexts/assessment/infrastructure/anchor-pool.repository.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { MISCONCEPTION_TEXT, SOLUTION_TEXT, itemContent, publishItem } from '../../testing/content-publishing.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectValue } from '../../testing/expect-result.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { TEST_SIGNING_SEED } from '../../testing/assessment-fakes.js';
import { verifyPackage } from '../../contexts/assessment/infrastructure/package-signer.js';
import { PACKAGE_MEDIA_TYPE } from '../../contexts/assessment/api/assessment.controller.js';

/**
 * The assessment HTTP surface through the composed application: real bearer
 * tokens, the real principal resolver, the real registry, real Postgres, and
 * content's real published items behind the catalogue (M6-23).
 */
const SIGNING_KEY = COMPOSED_CONFIG.authSigningKey;
const ISSUER = COMPOSED_CONFIG.authIssuer;
const SPEC = parse(readFileSync(fileURLToPath(new URL('../../../../../packages/contracts/openapi/assessment.yaml', import.meta.url)), 'utf8')) as {
  components: { schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }> };
};

let database: TestDatabase;
let app: INestApplication;
const STEMS = [
  'A block slides down a frictionless ramp. What is its acceleration?',
  'What is the SI unit of capacitance?',
  'State Kirchhoff\'s current law for a junction.',
  'A convex lens has focal length 20 cm. Where does an object at 30 cm form its image?',
  'Why does the resistance of a metal rise with temperature?',
  'Define the Bohr radius and give its approximate value.',
  'How does the de Broglie wavelength of an electron depend on its speed?',
];
const itemVersions: string[] = [];
const itemIds: string[] = [];

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  for (const stem of STEMS) {
    const published = await publishItem(database.pool, itemContent(stem));
    itemVersions.push(published.versions[0]!.versionId);
    itemIds.push(published.itemId);
  }
  expectValue(
    await new PostgresAnchorPoolRepository(database.pool).add(
      expectValue(addAnchorPoolMember({ itemVersionId: itemVersions[0]!, exposureCap: 10, addedAt: '2026-10-01T00:00:00.000Z' })),
    ),
  );
  app = await composed(COMPOSED_WITH_KEY, '2026-10-21T07:30:00.000Z');
});

const COMPOSED_WITH_KEY = { ...COMPOSED_CONFIG, formPackageSigningKey: TEST_SIGNING_SEED };

/** The same application over the same database at another moment, with or without a signing key. */
async function composed(config: typeof COMPOSED_CONFIG, at: string): Promise<INestApplication> {
  const instance = await createApplication(config, {
    pool: database.pool,
    telemetry: createRecordingTelemetry(),
    clock: { now: () => new Date(at) },
    identifiers: uuidFactory,
  });
  await instance.init();
  return instance;
}

afterAll(async () => {
  await app.close();
  await database.revertMigrations();
  await database.close();
});

function tokenFor(...roles: string[]): string {
  const now = Math.floor(Date.now() / 1000);
  return issue({ sub: randomUUID(), kind: 'human', roles, iat: now, exp: now + 3600, iss: ISSUER, jti: randomUUID() }, { signingKey: SIGNING_KEY, issuer: ISSUER });
}

const http = () => request(app.getHttpServer());
const bearer = (...roles: string[]) => `Bearer ${tokenFor(...roles)}`;
const asOps = () => bearer(ROLES.contentOps);
const asOpsStepUp = () => ({ Authorization: asOps(), 'X-Step-Up': 'satisfied' });

const sixSingles = (overrides: Record<string, unknown> = {}) => ({
  blueprint: {
    examProfileVersionId: randomUUID(),
    formType: 'mock',
    totalMarks: 24,
    difficultyTolerance: 0,
    sections: [{ ordinal: 1, sectionSpecRef: 'physics', itemCount: 6, typeMix: { SINGLE_CORRECT_MCQ: 6 }, marksPerItem: 4, difficultyTarget: { moderate: 6 } }],
  },
  sessionRefs: ['2026-01-27/shift-1', '2026-01-27/shift-2'],
  ...overrides,
});

function expectShape(body: Record<string, unknown>, schema: string): void {
  const declared = SPEC.components.schemas[schema]!;
  expect(Object.keys(body).sort(), schema).toEqual(expect.arrayContaining([...(declared.required ?? [])].sort()));
  for (const key of Object.keys(body)) expect(Object.keys(declared.properties), `${schema}.${key}`).toContain(key);
}

/** Key material, by name and by the text the solution carries — the M2-24 method, over a real response. */
const KEY_FIELDS = ['correctOptionId', 'correctOptionIds', 'isCorrect', 'is_correct', 'answerKey', 'expectedValue', 'finalAnswer', 'finalAnswerAssertion', 'responseSpec', 'pairs'];
function keyMaterialIn(body: unknown): string[] {
  const serialized = JSON.stringify(body);
  return [
    ...KEY_FIELDS.filter((field) => serialized.includes(`"${field}"`)),
    ...[SOLUTION_TEXT, MISCONCEPTION_TEXT, ...STEMS].filter((text) => serialized.includes(text)),
  ];
}

describe('assembling, reading, publishing and scheduling a form', () => {
  it('walks a form from draft to embargoed, and no response carries key material', async () => {
    const assembled = await http().post('/v1/assessment/forms').set('Authorization', asOps()).set('X-Correlation-Id', 'corr-asm-1').send(sixSingles());
    expect(assembled.status, JSON.stringify(assembled.body)).toBe(201);
    expect(assembled.headers['x-correlation-id']).toBe('corr-asm-1');
    expectShape(assembled.body, 'AssembledDraft');
    expectShape(assembled.body.form, 'Form');
    expect(assembled.body.form.state).toBe('draft');
    expect(assembled.body.form.sessionRefs).toEqual(['2026-01-27/shift-1', '2026-01-27/shift-2']);
    expect(assembled.body.form.sections[0].slots).toHaveLength(6);
    for (const slot of assembled.body.form.sections[0].slots) expectShape(slot, 'FormSlot');
    const pinned = assembled.body.form.sections[0].slots.map((slot: { itemVersionId: string }) => slot.itemVersionId).sort();
    expect(pinned).toHaveLength(6);
    expect(pinned.every((version: string) => itemVersions.includes(version))).toBe(true);
    expect(new Set(pinned).size).toBe(6);
    expect(keyMaterialIn(assembled.body)).toEqual([]);
    const formId = assembled.body.form.formId as string;

    const read = await http().get(`/v1/assessment/forms/${formId}`).set('Authorization', asOps());
    expect(read.status).toBe(200);
    expectShape(read.body, 'Form');
    expect(keyMaterialIn(read.body)).toEqual([]);

    const withoutStepUp = await http().post(`/v1/assessment/forms/${formId}/publication`).set('Authorization', asOps());
    expect(withoutStepUp.status).toBe(403);
    expect(withoutStepUp.body.reason).toBe('STEP_UP_REQUIRED');

    const published = await http().post(`/v1/assessment/forms/${formId}/publication`).set(asOpsStepUp()).set('X-Correlation-Id', 'corr-pub-1');
    expect(published.status, JSON.stringify(published.body)).toBe(200);
    expect(published.body.state).toBe('published');
    expect(published.body.publishedAt).toBe('2026-10-21T07:30:00.000Z');
    expect(keyMaterialIn(published.body)).toEqual([]);
    const ledger = await database.pool.query('SELECT count(*)::int AS n FROM assessment.exposure_ledger_entry WHERE form_id = $1', [formId]);
    expect(ledger.rows[0].n).toBe(12);

    const again = await http().post(`/v1/assessment/forms/${formId}/publication`).set(asOpsStepUp());
    expect(again.status).toBe(200);
    expect((await database.pool.query('SELECT count(*)::int AS n FROM assessment.exposure_ledger_entry WHERE form_id = $1', [formId])).rows[0].n).toBe(12);

    const scheduled = await http()
      .post(`/v1/assessment/forms/${formId}/schedule`)
      .set('Authorization', asOps())
      .send({ opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' });
    expect(scheduled.status, JSON.stringify(scheduled.body)).toBe(200);
    expect(scheduled.body.state).toBe('embargoed');
    expect(scheduled.body.scheduleWindow).toEqual({ opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' });
    expect(keyMaterialIn(scheduled.body)).toEqual([]);

    const rescheduled = await http()
      .post(`/v1/assessment/forms/${formId}/schedule`)
      .set('Authorization', asOps())
      .send({ opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T13:00:00.000Z' });
    expect(rescheduled.status).toBe(422);
    expect(rescheduled.body.reason).toBe('FORM_TRANSITION_PROHIBITED');

    const audit = await database.pool.query(`SELECT action FROM platform.audit_record WHERE target_context = 'assessment' AND correlation_id IN ('corr-asm-1', 'corr-pub-1') ORDER BY action`);
    expect(audit.rows.map((r) => r.action)).toEqual(['AssembleDraftForm', 'PublishForm']);
  });

  it('the key-free scan is not vacuous: the same items\' catalogue-side texts really are in the database and the scan finds them', async () => {
    const stored = await database.pool.query('SELECT count(*)::int AS n FROM content.item_option WHERE is_correct');
    expect(stored.rows[0].n).toBeGreaterThan(0);
    expect(keyMaterialIn({ leak: { correctOptionId: 'b', note: STEMS[0] } }).sort()).toEqual(['correctOptionId', STEMS[0]].sort());
  });
});

describe('an impossible blueprint and an exhausted search are different responses', () => {
  const impossible = () => sixSingles({ blueprint: { ...sixSingles().blueprint, totalMarks: 100 } });

  it('reports an infeasible blueprint as 422, not retryable, naming the constraint', async () => {
    const response = await http().post('/v1/assessment/forms').set('Authorization', asOps()).set('X-Correlation-Id', 'corr-infeasible').send(impossible());
    expect(response.status).toBe(422);
    expect(response.type).toBe('application/problem+json');
    expect(response.headers['x-correlation-id']).toBe('corr-infeasible');
    expect(response.body).toMatchObject({ code: 'RuleViolation', reason: 'ASSEMBLY_INFEASIBLE', constraint: 'TOTAL_MARKS', retryable: false, correlationId: 'corr-infeasible' });
  });

  it('reports an exhausted search as 503, retryable, naming the constraint', async () => {
    const response = await http().post('/v1/assessment/forms').set('Authorization', asOps()).send(sixSingles({ maxSteps: 1 }));
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ code: 'Unavailable', reason: 'ASSEMBLY_SEARCH_EXHAUSTED', retryable: true });
    expect(typeof response.body.constraint).toBe('string');
  });

  it('tells the two apart on every axis an operator or a client reads', async () => {
    const a = await http().post('/v1/assessment/forms').set('Authorization', asOps()).send(impossible());
    const b = await http().post('/v1/assessment/forms').set('Authorization', asOps()).send(sixSingles({ maxSteps: 1 }));
    expect(a.status).not.toBe(b.status);
    expect(a.body.reason).not.toBe(b.body.reason);
    expect(a.body.title).not.toBe(b.body.title);
    expect(a.body.detail).not.toBe(b.body.detail);
    expect(a.body.retryable).not.toBe(b.body.retryable);
  });
});

describe('boundary validation', () => {
  it('refuses a malformed body, an unknown field and a bad id as validation problems with a correlation id', async () => {
    const cases: [string, () => request.Test][] = [
      ['unknown field', () => http().post('/v1/assessment/forms').set('Authorization', asOps()).send({ ...sixSingles(), formId: randomUUID() })],
      ['no sessions', () => http().post('/v1/assessment/forms').set('Authorization', asOps()).send(sixSingles({ sessionRefs: [] }))],
      ['unknown item type', () => http().post('/v1/assessment/forms').set('Authorization', asOps()).send({ ...sixSingles(), blueprint: { ...sixSingles().blueprint, sections: [{ ...sixSingles().blueprint.sections[0], typeMix: { ESSAY: 6 } }] } })],
      ['bad form id', () => http().get('/v1/assessment/forms/not-a-uuid').set('Authorization', asOps())],
      ['unknown field on schedule', () => http().post(`/v1/assessment/forms/${randomUUID()}/schedule`).set('Authorization', asOps()).send({ opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z', state: 'active' })],
      ['non-UTC window', () => http().post(`/v1/assessment/forms/${randomUUID()}/schedule`).set('Authorization', asOps()).send({ opensAt: 'tomorrow', closesAt: '2026-10-21T12:00:00.000Z' })],
      ['no body at all', () => http().post(`/v1/assessment/forms/${randomUUID()}/schedule`).set('Authorization', asOps())],
    ];
    for (const [label, call] of cases) {
      const response = await call();
      expect(response.status, label).toBe(400);
      expect(response.body.code, label).toBe('Validation');
      expect(response.headers['x-correlation-id'], label).toBeTruthy();
    }
  });

  it('answers a form that does not exist as NotFound', async () => {
    const response = await http().get(`/v1/assessment/forms/${randomUUID()}`).set('Authorization', asOps());
    expect(response.status).toBe(404);
    expect(response.body.reason).toBe('NOT_FOUND');
  });
});

describe('who may reach it', () => {
  const surface = [
    ['post', '/v1/assessment/forms'],
    ['get', `/v1/assessment/forms/${randomUUID()}`],
    ['post', `/v1/assessment/forms/${randomUUID()}/publication`],
    ['post', `/v1/assessment/forms/${randomUUID()}/schedule`],
  ] as const;
  const call = (method: 'get' | 'post', path: string, authorization?: string) => {
    const pending = http()[method](path);
    const body = path.endsWith('/schedule') ? { opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' } : path.endsWith('/publication') ? undefined : sixSingles();
    return (authorization === undefined ? pending : pending.set('Authorization', authorization)).send(method === 'post' ? body : undefined);
  };

  it('refuses an unauthenticated request on every route with 401', async () => {
    for (const [method, path] of surface) {
      const response = await call(method, path);
      expect(response.status, path).toBe(401);
      expect(response.body.code, path).toBe('Authentication');
    }
  });

  it('refuses a learner and a guest on every route with 403', async () => {
    for (const role of [ROLES.learner, ROLES.guest]) {
      for (const [method, path] of surface) expect((await call(method, path, bearer(role))).status, `${role} ${path}`).toBe(403);
    }
  });

  it('lets the system assemble and read, and nothing that changes what students are offered', async () => {
    const system = bearer(ROLES.system);
    const assembled = await call('post', '/v1/assessment/forms', system);
    expect(assembled.status).toBe(201);
    expect((await call('get', `/v1/assessment/forms/${assembled.body.form.formId}`, system)).status).toBe(200);
    expect((await call('post', `/v1/assessment/forms/${assembled.body.form.formId}/publication`, system)).status).toBe(403);
    expect((await call('post', `/v1/assessment/forms/${assembled.body.form.formId}/schedule`, system)).status).toBe(403);
  });
});

describe('what is not on the surface is not there', () => {
  it('has no route for the sweep, for opening or closing a form, or for editing one', async () => {
    const formId = randomUUID();
    const attempts: [string, string][] = [
      ['post', '/v1/assessment/sweep'],
      ['post', '/v1/assessment/windows/sweep'],
      ['post', `/v1/assessment/forms/${formId}/open`],
      ['post', `/v1/assessment/forms/${formId}/close`],
      ['put', `/v1/assessment/forms/${formId}`],
      ['patch', `/v1/assessment/forms/${formId}`],
      ['delete', `/v1/assessment/forms/${formId}`],
    ];
    for (const [method, path] of attempts) {
      const response = await (http() as unknown as Record<string, (path: string) => request.Test>)[method]!(path).set('Authorization', bearer(ROLES.system)).send({});
      expect(response.status, `${method} ${path}`).toBe(404);
    }
  });
});

describe('the signed package (M6-26)', () => {
  const OPENS = '2026-10-21T08:00:00.000Z';
  const CLOSES = '2026-10-21T12:00:00.000Z';
  let formId: string;
  let open: INestApplication;
  let unkeyed: INestApplication;
  const learner = () => bearer(ROLES.learner);

  beforeAll(async () => {
    const assembled = await http().post('/v1/assessment/forms').set('Authorization', asOps()).send(sixSingles());
    formId = assembled.body.form.formId as string;
    expect((await http().post(`/v1/assessment/forms/${formId}/publication`).set(asOpsStepUp())).status).toBe(200);
    expect((await http().post(`/v1/assessment/forms/${formId}/schedule`).set('Authorization', asOps()).send({ opensAt: OPENS, closesAt: CLOSES })).status).toBe(200);
    open = await composed(COMPOSED_WITH_KEY, '2026-10-21T09:00:00.000Z');
    unkeyed = await composed(COMPOSED_CONFIG, '2026-10-21T09:00:00.000Z');
  });

  afterAll(async () => {
    await open.close();
    await unkeyed.close();
  });

  const fetchPackage = (instance: INestApplication, authorization?: string) => {
    const pending = request(instance.getHttpServer()).get(`/v1/assessment/forms/${formId}/package`).buffer(true).parse((res, done) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => done(null, Buffer.concat(chunks)));
    });
    return authorization === undefined ? pending : pending.set('Authorization', authorization);
  };

  it('is not served for a form that is not active, however the caller asks', async () => {
    const response = await http().get(`/v1/assessment/forms/${formId}/package`).set('Authorization', learner());
    expect(response.status).toBe(412);
    expect(response.body.reason).toBe('PACKAGE_FORM_NOT_ACTIVE');
  });

  it('serves the exact signed bytes of an active form whose window is open, and the signature verifies', async () => {
    await database.pool.query(`UPDATE assessment.form SET state = 'active' WHERE form_id = $1`, [formId]);
    const response = await fetchPackage(open, learner());
    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toBe(PACKAGE_MEDIA_TYPE);
    const bytes = response.body as Buffer;

    const keyResponse = await request(open.getHttpServer()).get('/v1/assessment/package-signing-key').set('Authorization', learner());
    expect(keyResponse.status).toBe(200);
    expect(keyResponse.body.algorithm).toBe('Ed25519');
    expect(JSON.stringify(keyResponse.body)).not.toContain(TEST_SIGNING_SEED);

    expect(verifyPackage(bytes, response.headers['x-package-signature'] as string, keyResponse.body.publicKey)).toBe(true);
    expect(response.headers['x-package-key-id']).toBe(keyResponse.body.keyId);
    const digest = createHash('sha256').update(bytes).digest('hex');
    expect(response.headers['x-package-digest']).toBe(`sha256=${digest}`);
    expect(response.headers['cache-control']).toBe('private, no-cache');
    expect(response.headers['etag']).toBe(`"${digest}"`);

    const tampered = Buffer.from(bytes);
    tampered[tampered.length >> 1] = tampered[tampered.length >> 1]! ^ 0x01;
    expect(verifyPackage(tampered, response.headers['x-package-signature'] as string, keyResponse.body.publicKey)).toBe(false);

    const document = JSON.parse(bytes.toString('utf8')) as { form: { formId: string }; sections: { slots: unknown[] }[] };
    expect(document.form.formId).toBe(formId);
    expect(document.sections[0]!.slots).toHaveLength(6);
  });

  it('is byte-identical on a second request, so a digest and a signature mean something', async () => {
    const first = (await fetchPackage(open, learner())).body as Buffer;
    const second = (await fetchPackage(open, learner())).body as Buffer;
    expect(first.equals(second)).toBe(true);
  });

  it('carries no answer key and no solution — and the same scan finds the key in those items\' authoring views', async () => {
    const served = ((await fetchPackage(open, learner())).body as Buffer).toString('utf8');
    const forKey = (text: string) => [...KEY_FIELDS.filter((field) => text.includes(`"${field}"`)), ...[SOLUTION_TEXT, MISCONCEPTION_TEXT].filter((fragment) => text.includes(fragment))];
    expect(forKey(served)).toEqual([]);
    // the package really holds the items it is made of, so an empty scan is about the right bytes
    expect(STEMS.filter((stem) => served.includes(stem)).length).toBeGreaterThanOrEqual(6);

    const pinned = itemIds.filter((_, index) => served.includes(STEMS[index]!));
    expect(pinned.length).toBeGreaterThanOrEqual(6);
    const authoring = await http().get(`/v1/authoring/items/${pinned[0]}`).set('Authorization', asOps());
    expect(authoring.status, JSON.stringify(authoring.body)).toBe(200);
    expect(forKey(JSON.stringify(authoring.body)).length).toBeGreaterThan(0);
  });

  it('refuses an unauthenticated caller and a guest, and answers 503 — never an unsigned body — with no key configured', async () => {
    expect((await fetchPackage(open)).status).toBe(401);
    expect((await fetchPackage(open, bearer(ROLES.guest))).status).toBe(403);
    const unsigned = await fetchPackage(unkeyed, learner());
    expect(unsigned.status).toBe(503);
    expect(unsigned.headers['x-package-signature']).toBeUndefined();
    expect(unsigned.headers['content-type']).not.toBe(PACKAGE_MEDIA_TYPE);
    const key = await request(unkeyed.getHttpServer()).get('/v1/assessment/package-signing-key').set('Authorization', learner());
    expect(key.status).toBe(503);
  });

  it('is not served before the window opens, though the state says active', async () => {
    const early = await http().get(`/v1/assessment/forms/${formId}/package`).set('Authorization', learner());
    expect(early.status).toBe(412);
    expect(early.body.reason).toBe('FORM_WINDOW_NOT_OPEN');
  });
});
