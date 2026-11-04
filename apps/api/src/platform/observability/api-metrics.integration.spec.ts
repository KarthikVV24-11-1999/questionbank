import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { parseRouteLimitsOrThrow } from '../config/config.js';
import { createApplication } from '../composition/app-factory.js';
import { BACKGROUND, type Background } from '../composition/background.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { createRecordingTelemetry } from './recording-telemetry.js';
import { createApiMetrics } from './api-metrics.js';

/**
 * The metrics against a real database and the composed application (M8-53): the outbox gauges read the real table, and the relay's lag and the admission refusals are wired to the places that
 * produce them.
 */
const T0 = new Date('2026-11-05T10:00:00.000Z');
let database: TestDatabase;
let app: INestApplication;
let now = T0;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  app = await createApplication(
    { ...COMPOSED_CONFIG, rateLimitLogin: parseRouteLimitsOrThrow('source=100/10s;subject=1/1m', true), rateLimitProfile: parseRouteLimitsOrThrow('source=2/1m;subject=100/1m', true) },
    { pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => now }, identifiers: uuidFactory },
  );
  await serveOnLoopback(app);
});
afterAll(async () => {
  await app.close();
  await database.revertMigrations();
  await database.close();
});

async function message(occurredAt: Date, state: 'live' | 'published' | 'dead', type = 'Nothing'): Promise<void> {
  await database.pool.query(
    `INSERT INTO platform.outbox_message (event_type, schema_version, aggregate_type, aggregate_id, payload, principal_kind, principal_id, correlation_id, occurred_at, published_at, dead_at)
     VALUES ($5, 1, 'Thing', $1, '{}', 'system', $1, 'c', $2, $3, $4)`,
    [randomUUID(), occurredAt, state === 'published' ? occurredAt : null, state === 'dead' ? occurredAt : null, type],
  );
}

describe('the outbox gauges, read from the real table', () => {
  it('count what is waiting, how old the oldest is, and what was given up on, and not what was delivered', async () => {
    await database.pool.query('DELETE FROM platform.outbox_message');
    await message(new Date(T0.getTime() - 90_000), 'live');
    await message(new Date(T0.getTime() - 30_000), 'live');
    await message(new Date(T0.getTime() - 500_000), 'published');
    await message(new Date(T0.getTime() - 800_000), 'dead');
    await message(new Date(T0.getTime() - 4_000_000), 'live', 'NothingConsumesThis');
    const metrics = createApiMetrics({ pool: database.pool, now: () => T0, rss: () => 1 });
    metrics.consumes(['Nothing']);
    const page = await metrics.registry.render();
    expect(page).toContain('qb_outbox_depth 2\n');
    expect(page).toContain('qb_outbox_oldest_unrelayed_age_seconds 90\n');
    expect(page).toContain('qb_outbox_dead 1\n');
    expect(page).toContain('qb_outbox_unconsumed 1\n');
    await database.pool.query('DELETE FROM platform.outbox_message');
    const empty = await metrics.registry.render();
    expect(empty).toContain('qb_outbox_depth 0\n');
    expect(empty).toContain('qb_outbox_oldest_unrelayed_age_seconds 0\n');
  });

  it('read the pool of the process they run in', async () => {
    const page = await createApiMetrics({ pool: database.pool, now: () => T0, rss: () => 1 }).registry.render();
    expect(page).toMatch(/qb_db_pool_connections\{state="total"\} [1-9]/u);
  });
});

describe('the composed application', () => {
  it('measures the relay\'s lag from the drain the scheduler runs', async () => {
    now = new Date(T0.getTime() + 30_000);
    expect((await request(app.getHttpServer()).get('/metrics')).text).toMatch(/^qb_outbox_relay_seconds_since_drain 30$/mu);
    await app.get<Background>(BACKGROUND).scheduler.tick(now);
    expect((await request(app.getHttpServer()).get('/metrics')).text).toMatch(/^qb_outbox_relay_seconds_since_drain 0$/mu);
    now = new Date(T0.getTime() + 37_000);
    expect((await request(app.getHttpServer()).get('/metrics')).text).toMatch(/^qb_outbox_relay_seconds_since_drain 7$/mu);
  });

  it('counts the logins admission control refused, by the tier that refused them', async () => {
    const login = () => request(app.getHttpServer()).post('/v1/identity/login').send({ email: 'someone@example.com', password: 'correct horse battery staple' });
    expect((await login()).status).toBe(401);
    expect((await login()).status).toBe(429);
    const page = (await request(app.getHttpServer()).get('/metrics')).text;
    expect(page).toMatch(/^qb_refusals_total\{code="RATE_LIMITED",reason="subject_[a-z]+"\} 1$/mu);
    expect(page).not.toContain('someone@example.com');
  });

  it('counts the learner\'s profile reads it refused too, because that limit is a different place that writes the same log', async () => {
    const address = `person-${randomUUID().slice(0, 8)}@example.com`;
    const password = 'correct horse battery staple';
    expect((await request(app.getHttpServer()).post('/v1/identity/register').send({ email: address, password })).status).toBe(202);
    const session = (await request(app.getHttpServer()).post('/v1/identity/login').send({ email: address, password })).body.sessionToken as string;
    const read = () => request(app.getHttpServer()).get('/v1/learning/profile').set('Authorization', `Bearer ${session}`);
    const statuses = [(await read()).status, (await read()).status, (await read()).status];
    expect(statuses).toContain(429);
    expect((await request(app.getHttpServer()).get('/metrics')).text).toMatch(/^qb_refusals_total\{code="RATE_LIMITED",reason="source_[a-z]+"\} [1-9]/mu);
  });
});
