import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROLES } from '../auth/roles.js';
import { issue } from '../auth/token.js';
import { createRecordingTelemetry } from '../observability/recording-telemetry.js';
import { createApplication } from '../composition/app-factory.js';
import { anEnvelope, PLANTED_PII } from '../../testing/analytics-fixtures.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { MemorySink } from './sink.js';

/** The ingestion edge through the composed application: the bearer token, the route, and what becomes of each event in a batch (M7-61). */
let database: TestDatabase;
let app: INestApplication;
class SwitchedSink extends MemorySink {
  down = false;
  override async write(event: Parameters<MemorySink['write']>[0]): Promise<void> {
    if (this.down) throw new Error('disk full');
    await super.write(event);
  }
}
const sink = new SwitchedSink();

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  app = await createApplication(COMPOSED_CONFIG, { pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => new Date('2026-10-29T09:30:00.000Z') }, identifiers: uuidFactory, analyticsSink: sink });
  await serveOnLoopback(app);
});
afterAll(async () => {
  await app.close();
  await database.revertMigrations();
  await database.close();
});

const bearer = (): string => {
  const now = Math.floor(Date.now() / 1000);
  return `Bearer ${issue({ sub: randomUUID(), kind: 'human', roles: [ROLES.learner], iat: now, exp: now + 3600, iss: COMPOSED_CONFIG.authIssuer, jti: randomUUID() }, { signingKey: COMPOSED_CONFIG.authSigningKey, issuer: COMPOSED_CONFIG.authIssuer })}`;
};
const post = (body: unknown, auth: string | null = bearer()) => {
  const call = request(app.getHttpServer()).post('/v1/analytics/events');
  return (auth === null ? call : call.set('Authorization', auth)).send(body as object);
};

describe('POST /v1/analytics/events', () => {
  it('admits a batch event by event, answers for each, and quarantines what is refused without failing the request', async () => {
    const good = anEnvelope();
    const response = await post({ events: [good, { ...anEnvelope(), event_name: 'ad_hoc.thing_clicked' }, anEnvelope({ payload: { note: PLANTED_PII.email } }), good] });
    expect(response.status).toBe(202);
    expect(response.body.results).toEqual([
      { index: 0, outcome: 'accepted' },
      { index: 1, outcome: 'quarantined', reason: 'UNKNOWN_EVENT_NAME' },
      { index: 2, outcome: 'quarantined', reason: 'PII' },
      { index: 3, outcome: 'duplicate' },
    ]);
    expect(sink.events.map((event) => event.event_id)).toContain(good.event_id);
    expect(JSON.stringify(sink.events)).not.toContain(PLANTED_PII.email);
  });

  it('answers 503 when the edge could not write, so the sender keeps the event and sends it again', async () => {
    const event = anEnvelope();
    sink.down = true;
    const refused = await post({ events: [event] });
    sink.down = false;
    expect(refused.status).toBe(503);
    expect(refused.body.results).toEqual([{ index: 0, outcome: 'sink-unavailable' }]);
    const retried = await post({ events: [event] });
    expect(retried.status).toBe(202);
    expect(retried.body.results).toEqual([{ index: 0, outcome: 'accepted' }]);
  });

  it('is not for the open internet: no token is a 401, and nothing is admitted', async () => {
    const before = sink.events.length;
    expect((await post({ events: [anEnvelope()] }, null)).status).toBe(401);
    expect(sink.events).toHaveLength(before);
  });

  it('refuses a body that is not a list of events, and a list too long to take in one request', async () => {
    expect((await post({})).status).toBe(400);
    expect((await post({ events: 'many' })).status).toBe(400);
    expect((await post({ events: Array.from({ length: 101 }, () => anEnvelope()) })).status).toBe(400);
  });
});
