import { DEFAULT_ABUSE_LIMITS, DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../config/config.js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { withMigratedDatabase, type TestDatabase } from '../../testing/database.js';
import { issue } from '../auth/token.js';
import { createApplication } from './app-factory.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { tokenPrincipals } from '../../testing/service-tokens.js';

/**
 * The composed application, against real Postgres. Not the walking skeleton
 * itself (M0-14 owns that, with its own span-tree and auth assertions) — this
 * proves the narrower claim `createApplication`'s own acceptance names: the
 * app it builds resolves a real handler in each of the three composed
 * contexts and actually executes against the database, not that any one
 * route's full behaviour is correct.
 */

const SIGNING_KEY = 'a'.repeat(32);
const ISSUER = 'questionbank';

let database: TestDatabase;
let app: INestApplication;

function tokenFor(roles: readonly string[]): string {
  const now = Math.floor(Date.now() / 1000);
  return issue(
    { sub: 'user-1', kind: 'human', roles: [...roles], iat: now, exp: now + 3600, iss: ISSUER, jti: 'jti-1' },
    { signingKey: SIGNING_KEY, issuer: ISSUER },
  );
}

beforeAll(async () => {
  database = await withMigratedDatabase();
  app = await createApplication({
    databaseUrl: 'unused-because-pool-is-overridden',
    port: 3000,
    nodeEnv: 'test',
    authSigningKey: SIGNING_KEY,
    auditAnchorKey: `anchor-${SIGNING_KEY}`,
    reviewWarnAfterHours: 48,
    reviewEscalateAfterHours: 72,
    reviewLeaseHours: 4,
    reviewSampleRate: 0.05,
    timeOnItemIntervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    maxSessionsPerUser: 5,
    ...DEFAULT_ABUSE_LIMITS,
    backgroundJobsEnabled: false,
    authIssuer: ISSUER,
    authTokenTtlSeconds: 3600,
    mediaStorageRoot: './var/media-test',
    logLevel: 'info',
  }, { pool: database.pool, principals: tokenPrincipals({ authSigningKey: SIGNING_KEY, authIssuer: ISSUER }) });
  await serveOnLoopback(app);
});

afterAll(async () => {
  await app.close();
  await database.close();
});

describe('createApplication — the composed application resolves every context, against real Postgres', () => {
  it('curriculum: an authenticated ListExams request executes a real query and returns 200', async () => {
    const response = await request(app.getHttpServer())
      .get('/v1/exams')
      .set('Authorization', `Bearer ${tokenFor(['learner'])}`);

    expect(response.status).toBe(200);
    expect(Array.isArray(response.body)).toBe(true);
  });

  it('content: an authenticated request reaches the real handler registry (item absent, but resolved and executed)', async () => {
    const response = await request(app.getHttpServer())
      .get(`/v1/items/${'00000000-0000-4000-8000-000000000000'}`)
      .set('Authorization', `Bearer ${tokenFor(['learner'])}`);

    // Not found, not unavailable and not unauthenticated — the composed
    // registry resolved GetPublishedItem and ran it against real Postgres.
    expect(response.status).toBe(404);
  });

  it('scoring: an authenticated GetScoreRecord request reaches the real handler registry', async () => {
    // 'ops' rather than 'learner' — GetScoreRecord's ownership check compares
    // the principal against an `ownerUserId` the controller never supplies,
    // so a non-operator role is refused before the query runs at all; an
    // operator role reaches the real repository call this test exists to prove.
    const response = await request(app.getHttpServer())
      .get(`/v1/attempts/${'00000000-0000-4000-8000-000000000000'}/score-records/current`)
      .set('Authorization', `Bearer ${tokenFor(['ops'])}`);

    expect(response.status).toBe(404);
  });

  it('refuses an unauthenticated request identically across contexts', async () => {
    const response = await request(app.getHttpServer()).get('/v1/exams');
    expect(response.status).toBe(401);
  });

  it('publishes what it measures at GET /metrics: counted by route template and status class, the outbox and the pool read now, and the page itself not counted', async () => {
    await request(app.getHttpServer()).get('/healthz');
    await request(app.getHttpServer()).get('/v1/exams');
    await request(app.getHttpServer()).get('/no/such/route/3f2a9c10-1b2c-4d3e-8f4a-5b6c7d8e9f00');
    const first = await request(app.getHttpServer()).get('/metrics');
    expect(first.status).toBe(200);
    expect(first.headers['content-type']).toMatch(/^text\/plain;/u);
    expect(first.headers['content-type']).toContain('version=0.0.4');
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.text).toMatch(/^qb_http_requests_total\{route="GET \/healthz",status_class="2xx"\} [1-9]/mu);
    expect(first.text).toMatch(/^qb_http_requests_total\{route="GET \/v1\/exams",status_class="4xx"\} [1-9]/mu);
    expect(first.text).toMatch(/^qb_http_requests_total\{route="unmatched",status_class="4xx"\} [1-9]/mu);
    expect(first.text).not.toContain('3f2a9c10');
    expect(first.text).toMatch(/^qb_outbox_depth \d+$/mu);
    expect(first.text).toMatch(/^qb_outbox_oldest_unrelayed_age_seconds \d/mu);
    expect(first.text).toMatch(/^qb_db_pool_connections\{state="total"\} \d+$/mu);
    expect(first.text).toMatch(/^qb_process_resident_memory_bytes \d+$/mu);
    expect(first.text).not.toContain('qb_collector_failed{');
    const second = await request(app.getHttpServer()).get('/metrics');
    expect(second.text).not.toContain('route="GET /metrics"');
  });
});

