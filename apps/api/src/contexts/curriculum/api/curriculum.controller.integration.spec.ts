import 'reflect-metadata';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../domain/concept-identity.js';
import { TaxonomyVersion } from '../domain/taxonomy-version.js';
import { DrizzleConceptIdentityRepository } from '../infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../infrastructure/taxonomy-version.repository.js';
import { DrizzleExamRepository } from '../infrastructure/exam.repository.js';
import { DrizzleExamProfileVersionRepository } from '../infrastructure/exam-profile-version.repository.js';
import { DrizzleTaxonomyMigrationRepository } from '../infrastructure/taxonomy-migration.repository.js';
import { InMemoryAuditRecorder } from '../application/ports.js';
import { taxonomyHandlers } from '../application/handlers/taxonomy-handlers.js';
import { examProfileHandlers } from '../application/handlers/exam-profile-handlers.js';
import { migrationHandlers } from '../application/handlers/migration-handlers.js';
import { curriculumQueries } from '../application/queries/curriculum-queries.js';
import { CurriculumModule } from './curriculum.module.js';
import type { PrincipalResolver } from './curriculum.controller.js';
import { FixedClock } from '../../../testing/in-memory-repositories.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectValue } from '../../../testing/expect-result.js';

let database: TestDatabase;
let app: INestApplication;
let audit: InMemoryAuditRecorder;

const OPS_ID = randomUUID();
const LEARNER_ID = randomUUID();

/** Stands in for the Identity context: a header names the principal. */
const principals: PrincipalResolver = {
  resolve(headers) {
    const role = headers['x-principal-role'];
    if (typeof role !== 'string') return null;

    const identifiers: Record<string, string> = { content_ops: OPS_ID, learner: LEARNER_ID };
    const id = identifiers[role];
    if (id === undefined) return null;

    return {
      kind: 'human',
      id,
      roleContext: role === 'content_ops' ? ['content_ops', 'curriculum_curator'] : ['learner'],
    } satisfies PrincipalRef;
  },
};

type Agent = ReturnType<ReturnType<typeof request>['post']>;

function asOps(agent: Agent): Agent {
  return agent.set('x-principal-role', 'content_ops').set('x-step-up', 'satisfied');
}

async function seedConcept(taxonomyVersionId: string, name: string): Promise<string> {
  const identities = new DrizzleConceptIdentityRepository(database.db);
  const identity = expectValue(
    ConceptIdentity.create({
      conceptIdentityId: randomUUID(),
      canonicalName: name,
      subjectDomain: 'physics',
      createdInVersion: taxonomyVersionId,
    }),
  );
  expectValue(await identities.insert(identity));
  return identity.conceptIdentityId;
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();

  audit = new InMemoryAuditRecorder();
  const shared = {
    versions: new DrizzleTaxonomyVersionRepository(database.db),
    identities: new DrizzleConceptIdentityRepository(database.db),
    exams: new DrizzleExamRepository(database.db),
    profiles: new DrizzleExamProfileVersionRepository(database.db),
    migrations: new DrizzleTaxonomyMigrationRepository(database.db),
    audit,
    clock: new FixedClock(),
    identifiers: { next: (): string => randomUUID() },
    executor: {
      migratedConcepts: async (): Promise<readonly string[]> => [],
      migrateChunk: async (): Promise<void> => undefined,
    },
  };

  const moduleRef = await Test.createTestingModule({
    imports: [
      CurriculumModule.register({
        handlers: [
          ...taxonomyHandlers(shared),
          ...examProfileHandlers(shared),
          ...migrationHandlers(shared),
          ...curriculumQueries(shared),
        ],
        principals,
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

beforeEach(async () => {
  await database.truncateAll();
});

afterAll(async () => {
  await app.close();
  await database.close();
});

function server(): ReturnType<typeof request> {
  return request(app.getHttpServer() as Parameters<typeof request>[0]);
}

/** Creates a draft and returns its id and current aggregate version. */
async function createDraft(): Promise<{ id: string; version: number }> {
  const response = await asOps(server().post('/v1/taxonomy-versions')).send({
    examFamily: 'JEE',
    academicYear: '2026',
  });

  return { id: response.body.taxonomyVersionId, version: response.body.aggregateVersion };
}

describe('happy paths', () => {
  it('creates a taxonomy draft and returns 201 with an ETag', async () => {
    const response = await asOps(server().post('/v1/taxonomy-versions')).send({
      examFamily: 'JEE',
      academicYear: '2026',
    });

    expect(response.status).toBe(201);
    expect(response.body.aggregateVersion).toBe(1);
    expect(response.headers['etag']).toBe('"1"');
    expect(response.headers['x-correlation-id']).toBeTruthy();
  });

  it('reads a taxonomy version back', async () => {
    const draft = await createDraft();

    const response = await asOps(server().get(`/v1/taxonomy-versions/${draft.id}`));

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      taxonomyVersionId: draft.id,
      examFamily: 'JEE',
      state: 'draft',
      nodeCount: 0,
    });
  });

  it('adds a concept node through If-Match', async () => {
    const draft = await createDraft();
    const conceptIdentityId = await seedConcept(draft.id, 'Physics');

    const response = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/concept-nodes`))
      .set('If-Match', `"${draft.version}"`)
      .send({
        conceptIdentityId,
        displayName: 'Physics',
        examWeight: 1,
        estimatedTeachingHours: 300,
      });

    expect(response.status).toBe(201);
    expect(response.headers['etag']).toBe('"2"');
  });

  it('lists taxonomy versions', async () => {
    await createDraft();

    const response = await asOps(server().get('/v1/taxonomy-versions').query({ examFamily: 'JEE' }));

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
    expect(response.body).toHaveLength(1);
  });

  it('creates an exam', async () => {
    const response = await asOps(server().post('/v1/exams')).send({
      code: 'JEE_MAIN',
      displayName: 'JEE Main',
      jurisdiction: 'IN',
      conductingBody: 'NTA',
    });

    expect(response.status).toBe(201);
    expect(response.body.examId).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('publishes a taxonomy version with an idempotency key', async () => {
    const draft = await createDraft();
    const conceptIdentityId = await seedConcept(draft.id, 'Physics');
    const added = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/concept-nodes`))
      .set('If-Match', `"${draft.version}"`)
      .send({ conceptIdentityId, displayName: 'Physics', examWeight: 1, estimatedTeachingHours: 300 });

    const response = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/publication`))
      .set('If-Match', `"${added.body.aggregateVersion}"`)
      .set('Idempotency-Key', 'idem-key-1234');

    expect(response.status).toBe(200);
    expect(audit.entries.at(-1)?.action).toBe('PublishTaxonomyVersion');
  });
});

describe('error mapping', () => {
  it('returns 401 with a problem document when no principal is present', async () => {
    const response = await server().post('/v1/taxonomy-versions').send({ examFamily: 'JEE', academicYear: '2026' });

    expect(response.status).toBe(401);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body).toMatchObject({ code: 'Authentication', retryable: false });
    expect(response.body.correlationId).toBeTruthy();
  });

  it('returns 403 for a principal without the role', async () => {
    const response = await server()
      .post('/v1/taxonomy-versions')
      .set('x-principal-role', 'learner')
      .send({ examFamily: 'JEE', academicYear: '2026' });

    expect(response.status).toBe(403);
    expect(response.body.code).toBe('Authorization');
    expect(response.headers['content-type']).toContain('application/problem+json');
  });

  it('returns 404 for an unknown aggregate', async () => {
    const response = await asOps(server().get(`/v1/taxonomy-versions/${randomUUID()}`));

    expect(response.status).toBe(404);
    expect(response.body.code).toBe('NotFound');
  });

  it('returns 409 on a stale If-Match', async () => {
    const draft = await createDraft();
    const conceptIdentityId = await seedConcept(draft.id, 'Physics');

    const response = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/concept-nodes`))
      .set('If-Match', '"99"')
      .send({ conceptIdentityId, displayName: 'Physics', examWeight: 1, estimatedTeachingHours: 300 });

    expect(response.status).toBe(409);
    expect(response.body.code).toBe('Conflict');
    expect(response.body.retryable).toBe(false);
  });

  it('returns 422 when a domain rule refuses the change', async () => {
    const draft = await createDraft();
    const first = await seedConcept(draft.id, 'Physics');
    const second = await seedConcept(draft.id, 'Chemistry');
    const added = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/concept-nodes`))
      .set('If-Match', `"${draft.version}"`)
      .send({ conceptIdentityId: first, displayName: 'Physics', examWeight: 1, estimatedTeachingHours: 300 });

    const response = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/concept-nodes`))
      .set('If-Match', `"${added.body.aggregateVersion}"`)
      .send({ conceptIdentityId: second, displayName: 'Chemistry', examWeight: 1, estimatedTeachingHours: 300 });

    expect(response.status).toBe(422);
    expect(response.body.code).toBe('RuleViolation');
    expect(response.body.detail).toContain('subject domain');
  });

  it('returns 400 with field detail for a malformed body', async () => {
    const response = await asOps(server().post('/v1/taxonomy-versions')).send({
      examFamily: '',
      academicYear: 'next year',
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('Validation');
    expect(response.body.errors.map((issue: { field: string }) => issue.field).sort()).toEqual([
      'academicYear',
      'examFamily',
    ]);
    expect(response.body.errors[0].message).toBeTruthy();
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await asOps(server().post('/v1/taxonomy-versions')).send({
      examFamily: 'JEE',
      academicYear: '2026',
      sneaky: true,
    });

    expect(response.status).toBe(400);
    expect(response.body.code).toBe('Validation');
  });

  it('returns 428 when If-Match is missing on a mutating endpoint', async () => {
    const draft = await createDraft();

    const response = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/concept-nodes`)).send({
      conceptIdentityId: randomUUID(),
      displayName: 'Physics',
      examWeight: 1,
      estimatedTeachingHours: 300,
    });

    expect(response.status).toBe(428);
    expect(response.body.code).toBe('PreconditionFailed');
  });

  it('returns 400 when the Idempotency-Key is missing on publication', async () => {
    const draft = await createDraft();

    const response = await asOps(server().post(`/v1/taxonomy-versions/${draft.id}/publication`)).set(
      'If-Match',
      `"${draft.version}"`,
    );

    expect(response.status).toBe(400);
    expect(response.body.errors[0].field).toBe('Idempotency-Key');
  });

  it('never leaks SQL, stack traces or internal identifiers', async () => {
    const response = await asOps(server().get(`/v1/taxonomy-versions/${randomUUID()}`));
    const body = JSON.stringify(response.body);

    expect(body).not.toMatch(/select |insert |curriculum\./iu);
    expect(body).not.toContain('at ');
    expect(Object.keys(response.body).sort()).toEqual(
      ['code', 'correlationId', 'detail', 'retryable', 'status', 'title', 'type'].sort(),
    );
  });

  it('echoes the caller’s correlation id on success and on failure', async () => {
    const success = await asOps(server().post('/v1/taxonomy-versions'))
      .set('x-correlation-id', 'corr-success')
      .send({ examFamily: 'JEE', academicYear: '2026' });
    const failure = await asOps(server().get(`/v1/taxonomy-versions/${randomUUID()}`)).set(
      'x-correlation-id',
      'corr-failure',
    );

    expect(success.headers['x-correlation-id']).toBe('corr-success');
    expect(failure.headers['x-correlation-id']).toBe('corr-failure');
    expect(failure.body.correlationId).toBe('corr-failure');
  });
});

describe('controllers hold no business logic', () => {
  it('constructs no domain object and touches no repository', () => {
    const text = readController(new URL('./curriculum.controller.ts', import.meta.url));
    const valueImportsFromDomain = text
      .split('\n')
      .filter((line) => /^import (?!type )/u.test(line) && line.includes('../domain/'));

    // Knowing the shape of a Result is translation; constructing an aggregate
    // or reaching for a repository would be business logic.
    expect(valueImportsFromDomain).toEqual([]);
    expect(text).not.toMatch(/repository/iu);
    expect(text).not.toMatch(/\bnew (TaxonomyVersion|ExamProfileVersion|ConceptNode|Exam)\b/u);
  });

  it('runs the profile and migration surfaces through the same translation', async () => {
    const exam = await asOps(server().post('/v1/exams')).send({
      code: 'NEET_UG',
      displayName: 'NEET UG',
      jurisdiction: 'IN',
      conductingBody: 'NTA',
    });
    const draft = await createDraft();

    const profile = await asOps(server().post('/v1/exam-profile-versions')).send({
      examId: exam.body.examId,
      academicYear: '2026',
      taxonomyVersionId: draft.id,
      sections: [
        {
          ordinal: 1,
          name: 'Physics',
          subject: 'physics',
          itemCount: 25,
          itemTypeMix: { SINGLE_CORRECT_MCQ: 25 },
          maxMarks: 100,
        },
      ],
      totalMarks: 100,
      timingPolicy: {
        totalDurationMinutes: 180,
        sectionLocking: false,
        warningThresholdsMinutes: [30],
        autoSubmitOnExpiry: true,
      },
      navigationPolicy: {
        crossSectionNavigation: true,
        allowMarkForReview: true,
        allowAnswerChange: true,
        allowClearResponse: true,
      },
      markingRuleSet: {
        schemaVersion: 1,
        rules: [
          {
            id: 'default',
            appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] },
            condition: { kind: 'ALWAYS' },
            award: { kind: 'FIXED', marks: 0 },
          },
        ],
      },
      itemTypeAllowances: [{ itemType: 'SINGLE_CORRECT_MCQ', sectionOrdinals: [1] }],
    });

    expect(profile.status).toBe(201);

    const read = await asOps(server().get(`/v1/exam-profile-versions/${profile.body.profileVersionId}`));
    expect(read.status).toBe(200);
    expect(read.body.sections).toHaveLength(1);

    const migration = await asOps(server().post('/v1/taxonomy-migrations')).send({
      fromVersionId: draft.id,
      toVersionId: randomUUID(),
    });
    expect(migration.status).toBe(404);
    expect(migration.body.code).toBe('NotFound');
  });
});

function readController(url: URL): string {
  return readFileSync(url, 'utf8');
}
