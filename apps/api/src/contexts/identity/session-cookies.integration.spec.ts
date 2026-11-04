import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createRecordingTelemetry } from '../../platform/observability/recording-telemetry.js';
import { createApplication } from '../../platform/composition/app-factory.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { unlimited } from '../../testing/rate-limits.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { MemoryMail } from './infrastructure/mail-adapters.js';

/**
 * A browser's session through the composed application (M8-42, ADR-0065): the cookie a login sets, what it authenticates, and what a request from another site is refused.
 * Real Postgres and the real middleware; nothing is faked between the request and the session table.
 */
const APP = 'https://learn.example.org';
const EVIL = 'https://evil.example';
const PASSWORD = 'correct horse battery staple';
const READ = '/v1/learning/review-plan';
const WRITE = '/v1/identity/email/verification';

let database: TestDatabase;
let app: INestApplication;
const mail = new MemoryMail();

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  app = await createApplication({ ...COMPOSED_CONFIG, publicUrl: APP }, { pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => new Date() }, identifiers: uuidFactory, mail, limiter: unlimited });
  await serveOnLoopback(app);
});
afterAll(async () => {
  await app.close();
  await database.revertMigrations();
  await database.close();
});

const http = () => request(app.getHttpServer());

interface Browser {
  readonly session: string;
  readonly csrf: string;
  readonly jar: string;
  readonly raw: string[];
  readonly token: string;
  readonly expiresAt: string;
}
async function signedIn(): Promise<Browser> {
  const address = `person-${randomUUID().slice(0, 8)}@example.com`;
  expect((await http().post('/v1/identity/register').send({ email: address, password: PASSWORD })).status).toBe(202);
  const login = await http().post('/v1/identity/login').set('Origin', APP).send({ email: address, password: PASSWORD });
  expect(login.status).toBe(200);
  const raw = login.headers['set-cookie'] as unknown as string[];
  const value = (name: string) => raw.find((line) => line.startsWith(`${name}=`))!.split(';')[0]!.slice(name.length + 1);
  const session = value('qb_session');
  const csrf = value('qb_csrf');
  return { session, csrf, jar: `qb_session=${session}; qb_csrf=${csrf}`, raw, token: login.body.sessionToken, expiresAt: login.body.expiresAt };
}

describe('the cookies a login sets', () => {
  it('are two: the session, which script cannot read, and the echo, which it can; both Secure, Lax, for the whole app, and ending when the session does', async () => {
    const { raw, session, csrf, expiresAt } = await signedIn();
    expect(raw).toHaveLength(2);
    const [sessionLine, csrfLine] = [raw.find((line) => line.startsWith('qb_session='))!, raw.find((line) => line.startsWith('qb_csrf='))!];
    for (const line of [sessionLine, csrfLine]) expect(line).toMatch(/^[^=]+=[^;]+; Path=\/; Expires=[^;]+;( HttpOnly;)? Secure; SameSite=Lax$/u);
    for (const line of [sessionLine, csrfLine]) expect(new Date(/Expires=([^;]+)/u.exec(line)![1]!).getTime()).toBe(Math.floor(new Date(expiresAt).getTime() / 1000) * 1000);
    expect(sessionLine).toContain('HttpOnly');
    expect(csrfLine).not.toContain('HttpOnly');
    expect(session.length).toBeGreaterThan(20);
    expect(csrf).not.toBe(session);
  });
});

describe('what the cookie authenticates', () => {
  it('a read, with no Authorization header at all', async () => {
    const { jar } = await signedIn();
    expect((await http().get(READ).set('Cookie', jar)).status).toBe(200);
    expect((await http().get(READ)).status).toBe(401);
  });

  it('a write from the app that echoes the second cookie', async () => {
    const { jar, csrf } = await signedIn();
    expect((await http().post(WRITE).set('Cookie', jar).set('Origin', APP).set('X-CSRF-Token', csrf).send({})).status).toBe(202);
  });
});

describe('a cross-origin POST with the cookie present', () => {
  it('is refused from another site, with or without the echo, and changes nothing', async () => {
    const { jar, csrf } = await signedIn();
    const before = (await database.pool.query('SELECT count(*)::int AS n FROM identity.one_time_token')).rows[0].n;
    for (const echo of [{}, { 'X-CSRF-Token': csrf }]) {
      const refused = await http().post(WRITE).set('Cookie', jar).set('Origin', EVIL).set(echo).send({});
      expect(refused.status).toBe(403);
      expect(refused.body).toMatchObject({ reason: 'CSRF_REFUSED' });
    }
    expect((await database.pool.query('SELECT count(*)::int AS n FROM identity.one_time_token')).rows[0].n).toBe(before);
  });

  it('is refused from the app itself when it does not echo the second cookie: a form on another page that the browser let through still cannot write', async () => {
    const { jar } = await signedIn();
    expect((await http().post(WRITE).set('Cookie', jar).set('Origin', APP).send({})).status).toBe(403);
  });
});

describe('a client that is not a browser', () => {
  it('uses the bearer token it was given, with no cookie and no echo, from anywhere', async () => {
    const { token } = await signedIn();
    expect((await http().get(READ).set('Authorization', `Bearer ${token}`)).status).toBe(200);
    expect((await http().post(WRITE).set('Authorization', `Bearer ${token}`).set('Origin', EVIL).send({})).status).toBe(202);
  });
});

describe('signing out', () => {
  it('clears both cookies and ends the session, so the cookie a browser kept is no use', async () => {
    const { jar, csrf } = await signedIn();
    const out = await http().post('/v1/identity/logout').set('Cookie', jar).set('Origin', APP).set('X-CSRF-Token', csrf).send({});
    expect(out.status).toBe(200);
    const cleared = out.headers['set-cookie'] as unknown as string[];
    expect(cleared.map((line) => line.split(';')[0])).toEqual(['qb_session=', 'qb_csrf=']);
    for (const line of cleared) expect(line).toMatch(/Expires=Thu, 01 Jan 1970/u);
    expect((await http().get(READ).set('Cookie', jar)).status).toBe(401);
  });

  it('cannot be forced on a person by another site', async () => {
    const { jar, csrf } = await signedIn();
    expect((await http().post('/v1/identity/logout').set('Cookie', jar).set('Origin', EVIL).set('X-CSRF-Token', csrf).send({})).status).toBe(403);
    expect((await http().get(READ).set('Cookie', jar)).status).toBe(200);
  });
});

describe('a cookie that has gone stale', () => {
  it('does not stop the person signing in again from the app, and does not let another site do it for them', async () => {
    const { jar } = await signedIn();
    const everywhere = await http().post('/v1/identity/logout-all').set('Cookie', jar).set('Origin', APP).set('X-CSRF-Token', jar.split('qb_csrf=')[1]!).send({});
    expect((everywhere.headers['set-cookie'] as unknown as string[]).map((line) => line.split(';')[0])).toEqual(['qb_session=', 'qb_csrf=']);
    expect((await http().get(READ).set('Cookie', jar)).status).toBe(401);
    expect((await http().post('/v1/identity/login').set('Cookie', jar).set('Origin', APP).send({ email: 'nobody@example.com', password: PASSWORD })).status).toBe(401);
    expect((await http().post('/v1/identity/login').set('Cookie', jar).set('Origin', EVIL).send({ email: 'nobody@example.com', password: PASSWORD })).status).toBe(403);
  });
});
