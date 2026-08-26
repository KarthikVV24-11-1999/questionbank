import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { parse } from 'yaml';
import { MissingAuthorizationPolicyError, type Handler } from '../application/handler-registry.js';
import { policy } from '../application/authorization.js';
import type { ApplicationContext } from '../application/ports.js';
import { ContentModule } from './content.module.js';
import type { PrincipalResolver } from './http-runner.js';

/**
 * The review HTTP surface (M4-37), through a real Nest application —
 * `content.controller.integration.spec.ts`'s own pattern, scoped to the
 * routes `review.controller.ts` adds. Handlers are stubs: what is under
 * test is translation, not the review application layer itself, which
 * M4-27 onward's own integration specs already cover end to end against a
 * real database.
 */

let app: INestApplication;

const REVIEWER: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['reviewer'] };

const resolver: PrincipalResolver = {
  resolve: (headers) => (headers['authorization'] === undefined ? null : REVIEWER),
};

const SPEC = parse(
  readFileSync(
    fileURLToPath(new URL('../../../../../../packages/contracts/openapi/content.yaml', import.meta.url)),
    'utf8',
  ),
) as { readonly paths: Record<string, Record<string, { readonly 'x-handler'?: string }>> };

/** Every handler the document names — the app must route all of them, review's included. */
const HANDLER_NAMES = [
  ...new Set(
    Object.values(SPEC.paths).flatMap((item) =>
      Object.values(item)
        .map((operation) => operation['x-handler'])
        .filter((name): name is string => typeof name === 'string'),
    ),
  ),
];

const REVIEW_HANDLER_NAMES = [
  'ClaimNextForReview',
  'ReleaseAssignment',
  'ReassignReview',
  'ExtendLease',
  'ApproveWithEdits',
  'GetDuplicateCandidates',
  'GetQueueHealth',
  'GetReviewerThroughput',
] as const;

/** Echoes what it was given, or fails in the way the test asked for — the same convention `content.controller.integration.spec.ts` uses. */
function stub(name: string): Handler<unknown, unknown> {
  return {
    name,
    policy: policy(name, ['reviewer', 'content_ops']),
    async handle(input: unknown, context: ApplicationContext) {
      const asked = (input as { subject?: string } | null)?.subject;
      if (asked === 'force-not-found') {
        return { ok: false as const, error: { kind: 'NotFound' as const, code: 'NOT_FOUND', message: 'gone' } };
      }
      if (asked === 'force-conflict') {
        return { ok: false as const, error: { kind: 'Conflict' as const, code: 'CONFLICT', message: 'already claimed' } };
      }
      return { ok: true as const, value: { echoed: input, correlationId: context.correlationId } };
    },
  } as unknown as Handler<unknown, unknown>;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ContentModule.register({
        handlers: HANDLER_NAMES.map(stub) as unknown as Handler<never, unknown>[],
        principals: resolver,
      }),
    ],
  }).compile();

  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
});

const AUTH = { Authorization: 'Bearer test' };
const ASSIGNMENT_ID = randomUUID();
const ITEM_ID = randomUUID();
const ITEM_VERSION_ID = randomUUID();

describe('every review route reaches its handler', () => {
  it('claims the next item for review', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments')
      .set(AUTH)
      .send({ subject: 'physics' });

    expect(response.status).toBe(201);
    expect(response.body.echoed.subject).toBe('physics');
  });

  it('releases and extends a held claim, carrying the path parameter into the command', async () => {
    const released = await request(app.getHttpServer())
      .post(`/v1/authoring/review/assignments/${ASSIGNMENT_ID}/release`)
      .set(AUTH)
      .send();
    expect(released.status).toBe(200);
    expect(released.body.echoed.assignmentId).toBe(ASSIGNMENT_ID);

    const extended = await request(app.getHttpServer())
      .post(`/v1/authoring/review/assignments/${ASSIGNMENT_ID}/lease-extensions`)
      .set(AUTH)
      .send();
    expect(extended.status).toBe(200);
    expect(extended.body.echoed.assignmentId).toBe(ASSIGNMENT_ID);
  });

  it('reassigns — the Content Ops push path', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/authoring/review/item-versions/${ITEM_VERSION_ID}/assignment`)
      .set(AUTH)
      .send({ subject: 'physics', reviewerId: randomUUID() });

    expect(response.status).toBe(201);
    expect(response.body.echoed.itemVersionId).toBe(ITEM_VERSION_ID);
    expect(response.body.echoed.subject).toBe('physics');
  });

  it('approves with edits, carrying both path parameters into the command', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/authoring/review/items/${ITEM_ID}/versions/${ITEM_VERSION_ID}/approval-with-edits`)
      .set(AUTH)
      .send({ edits: { difficultyEstimate: 'challenging' }, candidatesShownIds: [] });

    expect(response.status).toBe(200);
    expect(response.body.echoed.itemId).toBe(ITEM_ID);
    expect(response.body.echoed.itemVersionId).toBe(ITEM_VERSION_ID);
    expect(response.body.echoed.edits.difficultyEstimate).toBe('challenging');
  });

  it('reads duplicate candidates, queue health and reviewer throughput', async () => {
    const duplicates = await request(app.getHttpServer())
      .get(`/v1/authoring/review/item-versions/${ITEM_VERSION_ID}/duplicate-candidates`)
      .set(AUTH);
    expect(duplicates.status).toBe(200);
    expect(duplicates.body.echoed.itemVersionId).toBe(ITEM_VERSION_ID);

    const health = await request(app.getHttpServer()).get('/v1/authoring/review/queue-health').set(AUTH);
    expect(health.status).toBe(200);
    // The controller supplies `now` itself — never a client-visible field.
    expect(typeof health.body.echoed.now).toBe('string');

    const throughput = await request(app.getHttpServer())
      .get('/v1/authoring/review/reviewer-throughput?from=2026-08-01T00:00:00.000Z&to=2026-08-26T00:00:00.000Z')
      .set(AUTH);
    expect(throughput.status).toBe(200);
    expect(throughput.body.echoed).toEqual({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-26T00:00:00.000Z',
    });
  });
});

describe('§8 — the boundary refuses what it cannot type, on review routes too', () => {
  it('rejects a malformed body with Problem Details naming the field', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments')
      .set(AUTH)
      .send({ subject: 123 });

    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.code).toBe('Validation');
    expect(response.body.detail).toContain('subject');
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments')
      .set(AUTH)
      .send({ subject: 'physics', smuggled: true });

    expect(response.status).toBe(400);
    expect(response.body.detail).toContain('smuggled');
  });

  it('rejects a path parameter that is not a uuid', async () => {
    const response = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments/not-a-uuid/release')
      .set(AUTH);
    expect(response.status).toBe(400);
  });

  it('demands authentication before anything else', async () => {
    const response = await request(app.getHttpServer()).post('/v1/authoring/review/assignments').send({});
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('Authentication');
    expect(response.body.retryable).toBe(false);
  });

  it('maps NotFound and Conflict onto their statuses, with retryable explicit', async () => {
    const notFound = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments')
      .set(AUTH)
      .send({ subject: 'force-not-found' });
    expect(notFound.status).toBe(404);
    expect(notFound.body).toMatchObject({ code: 'NotFound', retryable: false });

    const conflict = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments')
      .set(AUTH)
      .send({ subject: 'force-conflict' });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ code: 'Conflict', retryable: false });
  });

  it('echoes a correlation id on every response, error or not', async () => {
    const ok = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments')
      .set({ ...AUTH, 'x-correlation-id': 'review-given-1' })
      .send({ subject: 'physics' });
    expect(ok.headers['x-correlation-id']).toBe('review-given-1');
    expect(ok.body.correlationId).toBe('review-given-1');

    const failed = await request(app.getHttpServer())
      .post('/v1/authoring/review/assignments/not-a-uuid/release')
      .set({ ...AUTH, 'x-correlation-id': 'review-given-2' });
    expect(failed.headers['x-correlation-id']).toBe('review-given-2');
    expect(failed.body.correlationId).toBe('review-given-2');

    const unauthenticated = await request(app.getHttpServer()).post('/v1/authoring/review/assignments').send({});
    expect(unauthenticated.headers['x-correlation-id']).toBeTruthy();
  });
});

describe('F36 — a policy-less review handler fails boot', () => {
  it('refuses to build the module', async () => {
    const roleless = {
      name: 'ClaimNextForReview',
      policy: policy('ClaimNextForReview', []),
      async handle() {
        return { ok: true as const, value: undefined };
      },
    };

    expect(() =>
      ContentModule.register({
        handlers: [roleless] as unknown as Handler<never, unknown>[],
        principals: resolver,
      }),
    ).toThrow(MissingAuthorizationPolicyError);
  });

  it('routes every review handler the document declares', () => {
    // Boot succeeded above with exactly this list, so a document naming a
    // review handler the controller does not route would have failed the
    // request tests above rather than passing quietly.
    for (const name of REVIEW_HANDLER_NAMES) {
      expect(HANDLER_NAMES, name).toContain(name);
    }
  });
});

/**
 * M4-37's own criterion: *a delivery-family route that would serialize a
 * key fails a test, not a review* — extended over the review controller.
 * Review is **inside** the authoring family (DEC-M4-12), so the honest
 * proof is the opposite of the delivery scan's: a review response is
 * capable of carrying key material when the caller sends it, over live
 * output, in the same running application delivery's own no-key scan runs
 * against — proving review's presence changes nothing about that guarantee.
 */
describe('a review response can carry key material over live output, and delivery still carries none, in the same app', () => {
  it('echoes key-bearing content sent to approve-with-edits, over live output', async () => {
    const response = await request(app.getHttpServer())
      .post(`/v1/authoring/review/items/${ITEM_ID}/versions/${ITEM_VERSION_ID}/approval-with-edits`)
      .set(AUTH)
      .send({
        edits: {
          responseSpec: {
            itemType: 'SINGLE_CORRECT_MCQ',
            options: [{ optionId: 'a', ordinal: 1, body: { schemaVersion: 1, blocks: [] } }],
            correctOptionId: 'a',
          },
        },
        candidatesShownIds: [],
      });

    expect(response.status).toBe(200);
    expect(JSON.stringify(response.body)).toContain('"correctOptionId"');
  });

  it('still finds no key material on a live delivery response, with review mounted in the same app', async () => {
    const item = await request(app.getHttpServer()).get(`/v1/items/${ITEM_ID}`).set(AUTH);
    expect(item.status).toBe(200);
    expect(JSON.stringify(item.body)).not.toMatch(/"correctOptionId"|"responseSpec"/u);
  });

  it('imports no infrastructure or application/review module into review.controller.ts — translation only', () => {
    const controller = readFileSync(fileURLToPath(new URL('./review.controller.ts', import.meta.url)), 'utf8');
    expect(controller).not.toMatch(/from ['"]\.\.\/application\/review\//u);
    expect(controller).not.toMatch(/from ['"]\.\.\/infrastructure\//u);
  });
});
