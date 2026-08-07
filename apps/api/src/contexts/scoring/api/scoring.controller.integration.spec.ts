import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { PrincipalRef } from '@questionbank/domain-types';
import type { Handler } from '../application/handler-registry.js';
import type { ApplicationContext } from '../application/ports.js';
import { MissingAuthorizationPolicyError } from '../application/handler-registry.js';
import { policy } from '../application/authorization.js';
import { ScoringModule } from './scoring.module.js';
import type { PrincipalResolver } from './scoring.controller.js';

/**
 * The HTTP surface, exercised through a real Nest application. Handlers are
 * stubs here: what is under test is translation — parsing, authenticating,
 * status mapping and Problem Details — not the scoring itself, which the
 * application and domain specs already cover end to end.
 */
let app: INestApplication;

const ADMIN: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['admin'] };

const resolver: PrincipalResolver = {
  resolve: (headers) => (headers['authorization'] === undefined ? null : ADMIN),
};

const handlerNames = [
  'ScoreAttempt',
  'GetScoreRecord',
  'ListScoreRecordGenerations',
  'DraftRescoring',
  'RunRescoringDryRun',
  'GetRescoringDryRun',
  'ApproveRescoring',
  'ExecuteRescoring',
] as const;

/** Echoes what it was given, or fails in the way the test asked for. */
function stub(name: string): Handler<unknown, unknown> {
  return {
    name,
    policy: policy(name, ['admin'], name === 'ApproveRescoring' || name === 'ExecuteRescoring'),
    async handle(input: unknown, context: ApplicationContext) {
      const asked = (input as { scopeRef?: string } | null)?.scopeRef;
      if (asked === 'force-not-found') {
        return { ok: false as const, error: { kind: 'NotFound' as const, code: 'NOT_FOUND', message: 'nope' } };
      }
      if (asked === 'force-conflict') {
        return { ok: false as const, error: { kind: 'Conflict' as const, code: 'CONFLICT', message: 'taken' } };
      }
      return { ok: true as const, value: { echoed: input, stepUp: context.stepUpSatisfied ?? false } };
    },
  } as unknown as Handler<unknown, unknown>;
}

beforeAll(async () => {
  const moduleRef = await Test.createTestingModule({
    imports: [
      ScoringModule.register({
        handlers: handlerNames.map(stub) as unknown as Handler<never, unknown>[],
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

const authed = (agent: request.Test): request.Test => agent.set('authorization', 'Bearer token');

describe('routes', () => {
  it('scores an attempt', async () => {
    const response = await authed(request(app.getHttpServer()).post('/v1/score-records')).send({
      attemptId: randomUUID(),
      examProfileVersionId: randomUUID(),
      idempotencyKey: 'k-1',
    });
    expect(response.status).toBe(201);
  });

  it('reads the current score record', async () => {
    const response = await authed(
      request(app.getHttpServer()).get(`/v1/attempts/${randomUUID()}/score-records/current`),
    );
    expect(response.status).toBe(200);
  });

  it('lists every generation', async () => {
    const response = await authed(request(app.getHttpServer()).get(`/v1/attempts/${randomUUID()}/score-records`));
    expect(response.status).toBe(200);
  });

  it('drafts a re-score', async () => {
    const response = await authed(request(app.getHttpServer()).post('/v1/rescoring-operations')).send({
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'iv-1',
      reason: 'upheld',
    });
    expect(response.status).toBe(201);
  });

  it('previews, approves and executes', async () => {
    const id = randomUUID();
    const server = app.getHttpServer();
    expect((await authed(request(server).post(`/v1/rescoring-operations/${id}/dry-run`))).status).toBe(200);
    expect((await authed(request(server).get(`/v1/rescoring-operations/${id}/dry-run`))).status).toBe(200);
    expect((await authed(request(server).post(`/v1/rescoring-operations/${id}/approval`))).status).toBe(200);
    expect((await authed(request(server).post(`/v1/rescoring-operations/${id}/execution`))).status).toBe(200);
  });
});

describe('authentication and step-up', () => {
  it('refuses an unauthenticated request', async () => {
    const response = await request(app.getHttpServer()).get(
      `/v1/attempts/${randomUUID()}/score-records/current`,
    );
    expect(response.status).toBe(401);
    expect(response.body.code).toBe('Authentication');
  });

  it('passes the step-up header through to the handler', async () => {
    const response = await authed(
      request(app.getHttpServer()).post(`/v1/rescoring-operations/${randomUUID()}/approval`),
    ).set('x-step-up', 'satisfied');
    expect(response.body.stepUp).toBe(true);
  });

  it('reports step-up as unsatisfied when the header is absent', async () => {
    const response = await authed(
      request(app.getHttpServer()).post(`/v1/rescoring-operations/${randomUUID()}/approval`),
    );
    expect(response.body.stepUp).toBe(false);
  });
});

describe('input is validated at the boundary', () => {
  it('rejects a malformed body with Problem Details', async () => {
    const response = await authed(request(app.getHttpServer()).post('/v1/score-records')).send({
      attemptId: 'not-a-uuid',
    });
    expect(response.status).toBe(400);
    expect(response.headers['content-type']).toContain('application/problem+json');
    expect(response.body.code).toBe('Validation');
  });

  it('rejects an unknown field rather than ignoring it', async () => {
    const response = await authed(request(app.getHttpServer()).post('/v1/rescoring-operations')).send({
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'iv-1',
      reason: 'upheld',
      smuggled: true,
    });
    expect(response.status).toBe(400);
  });

  it('rejects a re-score with no reason', async () => {
    const response = await authed(request(app.getHttpServer()).post('/v1/rescoring-operations')).send({
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'iv-1',
      reason: '',
    });
    expect(response.status).toBe(400);
  });

  it('rejects a malformed path parameter', async () => {
    const response = await authed(request(app.getHttpServer()).get('/v1/attempts/not-a-uuid/score-records'));
    expect(response.status).toBe(400);
  });
});

describe('errors are RFC 9457 with a correlation id (§8)', () => {
  it('maps NotFound to 404', async () => {
    const response = await authed(request(app.getHttpServer()).post('/v1/rescoring-operations')).send({
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'force-not-found',
      reason: 'r',
    });
    expect(response.status).toBe(404);
    expect(response.body.retryable).toBe(false);
  });

  it('maps Conflict to 409', async () => {
    const response = await authed(request(app.getHttpServer()).post('/v1/rescoring-operations')).send({
      trigger: 'CHALLENGE_UPHELD',
      scope: 'ITEM_VERSION',
      scopeRef: 'force-conflict',
      reason: 'r',
    });
    expect(response.status).toBe(409);
  });

  it('echoes the correlation id it was given', async () => {
    const response = await authed(
      request(app.getHttpServer()).get(`/v1/attempts/${randomUUID()}/score-records/current`),
    ).set('x-correlation-id', 'given-id');
    expect(response.headers['x-correlation-id']).toBe('given-id');
  });

  it('mints one when none is given, on an error as well as a success', async () => {
    const response = await request(app.getHttpServer()).get(`/v1/attempts/${randomUUID()}/score-records/current`);
    expect(response.headers['x-correlation-id']).toBeDefined();
    expect(response.body.correlationId).toBeDefined();
  });

  it('carries an explicit retryable flag on every error', async () => {
    const response = await request(app.getHttpServer()).get(`/v1/attempts/${randomUUID()}/score-records/current`);
    expect(typeof response.body.retryable).toBe('boolean');
  });
});

describe('F36 — the module fails to boot without a policy', () => {
  it('refuses to register a policy-less handler', () => {
    const policyLess = { name: 'PlantedPolicyLess', policy: undefined, async handle() {} };
    expect(() =>
      ScoringModule.register({
        handlers: [policyLess as unknown as Handler<never, unknown>],
        principals: resolver,
      }),
    ).toThrow(MissingAuthorizationPolicyError);
  });
});
