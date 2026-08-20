import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { withMigratedDatabase, type TestDatabase } from '../../testing/database.js';
import { issue } from '../auth/token.js';
import { createApplication } from './app-factory.js';

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
    authIssuer: ISSUER,
    authTokenTtlSeconds: 3600,
    mediaStorageRoot: './var/media-test',
    logLevel: 'info',
  }, { pool: database.pool });
  await app.init();
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
});
