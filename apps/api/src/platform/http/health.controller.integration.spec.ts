import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { withMigratedDatabase, type TestDatabase } from '../../testing/database.js';
import { HealthModule } from './health.module.js';

/**
 * `/healthz` and `/readyz` answer different questions (M0-13) — this spec
 * proves the difference is real, not just documented: liveness never touches
 * the pool at all, and readiness reports 503 with a machine-readable reason
 * the moment the pool it was built against stops being usable, independent of
 * whether the process itself is still up.
 */
let database: TestDatabase;
let app: INestApplication;

beforeAll(async () => {
  database = await withMigratedDatabase();
  const moduleRef = await Test.createTestingModule({ imports: [HealthModule.register(database.pool)] }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
});

afterAll(async () => {
  await app.close();
  await database.close().catch(() => undefined);
});

describe('GET /healthz', () => {
  it('is 200 without touching the database', async () => {
    const response = await request(app.getHttpServer()).get('/healthz');
    expect(response.status).toBe(200);
  });

  it('requires no authentication', async () => {
    const response = await request(app.getHttpServer()).get('/healthz');
    expect(response.status).not.toBe(401);
  });
});

describe('GET /readyz', () => {
  it('is 200 against real Postgres', async () => {
    const response = await request(app.getHttpServer()).get('/readyz');
    expect(response.status).toBe(200);
  });
});

describe('GET /readyz — against a closed pool', () => {
  let closedApp: INestApplication;
  let closedDatabase: TestDatabase;

  beforeAll(async () => {
    closedDatabase = await withMigratedDatabase();
    const moduleRef = await Test.createTestingModule({
      imports: [HealthModule.register(closedDatabase.pool)],
    }).compile();
    closedApp = moduleRef.createNestApplication();
    await closedApp.init();
    await closedDatabase.pool.end();
  });

  afterAll(async () => {
    await closedApp.close();
  });

  it('is 503 with a machine-readable reason, a query after close failing predictably', async () => {
    const response = await request(closedApp.getHttpServer()).get('/readyz');
    expect(response.status).toBe(503);
    expect(response.body).toMatchObject({ status: 'unavailable' });
    expect(typeof response.body.reason).toBe('string');
    expect(response.body.reason.length).toBeGreaterThan(0);
  });
});
