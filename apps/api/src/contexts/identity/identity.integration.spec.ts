import { createHash, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { issue } from '../../platform/auth/token.js';
import { createRecordingTelemetry } from '../../platform/observability/recording-telemetry.js';
import { createApplication } from '../../platform/composition/app-factory.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { identityAbuseDeps, unlimited } from '../../testing/rate-limits.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import { identityHandlers } from './public/composition.js';
import { PostgresUserStore } from './infrastructure/postgres-stores.js';
import { MemoryMail } from './infrastructure/mail-adapters.js';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher.js';
import { SESSION_IDLE_MS, SESSION_LIFETIME_MS } from './domain/session-policy.js';

/**
 * Identity through the composed application: real Postgres, the real session middleware and resolver, and a route of another context (Learning's) to show that a session
 * authenticates a request to a context that was not changed to accept it (M8-03).
 */
let database: TestDatabase;
let app: INestApplication;
const mail = new MemoryMail();
let now = new Date('2026-11-02T09:00:00.000Z');
const PASSWORD = 'correct horse battery staple';
const OTHER_PASSWORD = 'a different long passphrase';
const MAX_SESSIONS = 3;
const LEARNER_ROUTE = '/v1/learning/review-plan';

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  app = await createApplication({ ...COMPOSED_CONFIG, maxSessionsPerUser: MAX_SESSIONS }, { pool: database.pool, telemetry: createRecordingTelemetry(), clock: { now: () => now }, identifiers: uuidFactory, mail, limiter: unlimited });
  await serveOnLoopback(app);
});
afterAll(async () => {
  await app.close();
  await database.revertMigrations();
  await database.close();
});
beforeEach(() => {
  now = new Date('2026-11-02T09:00:00.000Z');
  mail.sent.length = 0;
});

const http = () => request(app.getHttpServer());
const post = (path: string, body: object = {}, token?: string) => {
  const call = http().post(`/v1/identity${path}`);
  return (token === undefined ? call : call.set('Authorization', `Bearer ${token}`)).send(body);
};
const email = () => `person-${randomUUID().slice(0, 8)}@example.com`;
const codeIn = (purpose: string): string => /code is (\S+)\./u.exec(mail.sent.filter((message) => message.purpose === purpose).at(-1)!.body)![1]!;
const withoutCorrelation = (body: Record<string, unknown>) => ({ ...body, correlationId: undefined });

async function registered(address = email(), password = PASSWORD): Promise<string> {
  expect((await post('/register', { email: address, password })).status).toBe(202);
  return address;
}
async function loggedIn(address: string, password = PASSWORD): Promise<{ token: string; userId: string; sessionId: string }> {
  const response = await post('/login', { email: address, password });
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return { token: response.body.sessionToken, userId: response.body.userId, sessionId: response.body.sessionId };
}
const learnerStatus = async (token: string) => (await http().get(LEARNER_ROUTE).set('Authorization', `Bearer ${token}`)).status;

describe('registration and verification', () => {
  it('registers a person, mails a verification code, and verifies the address once', async () => {
    const address = await registered();
    expect(mail.sent).toMatchObject([{ to: address, purpose: 'email_verification' }]);
    const code = codeIn('email_verification');

    const first = await post('/email/verify', { token: code });
    expect(first.status).toBe(200);
    const row = (await database.pool.query('SELECT email_verified_at FROM identity.app_user WHERE email_normalized = $1', [address])).rows[0];
    expect(row.email_verified_at).not.toBeNull();

    const again = await post('/email/verify', { token: code });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ reason: 'TOKEN_INVALID' });
  });

  it('answers a registration for a known address as it answers a new one, and says so by mail to the owner', async () => {
    const address = email();
    const fresh = await post('/register', { email: address, password: PASSWORD });
    const known = await post('/register', { email: address.toUpperCase(), password: OTHER_PASSWORD });
    expect([fresh.status, known.status]).toEqual([202, 202]);
    expect(known.body).toEqual(fresh.body);
    expect(mail.sent.map((message) => message.purpose)).toEqual(['email_verification', 'already_registered']);
    expect((await database.pool.query('SELECT count(*)::int AS n FROM identity.app_user WHERE email_normalized = $1', [address])).rows[0].n).toBe(1);
    // the second password did not replace the first
    await loggedIn(address, PASSWORD);
  });

  it('refuses an address that is not one and a password that is too short, saying only that', async () => {
    expect((await post('/register', { email: 'not-an-address', password: PASSWORD })).body).toMatchObject({ reason: 'EMAIL_INVALID' });
    const short = await post('/register', { email: email(), password: 'short' });
    expect(short.status).toBe(400);
    expect(short.body).toMatchObject({ reason: 'PASSWORD_TOO_SHORT' });
    expect(JSON.stringify(short.body)).not.toContain('short"');
  });

  it('refuses a password that is known to be breached, in any case, and creates nobody and mails nobody', async () => {
    for (const bad of ['password1234', 'Password1234', 'ｐａｓｓｗｏｒｄ１２３４']) {
      const address = email();
      const refused = await post('/register', { email: address, password: bad });
      expect(refused.status, bad).toBe(400);
      expect(refused.body, bad).toMatchObject({ reason: 'PASSWORD_BREACHED', detail: 'That password is too common or has appeared in a data breach. Choose a different one.' });
      expect((await database.pool.query('SELECT count(*)::int AS n FROM identity.app_user WHERE email_normalized = $1', [address])).rows[0].n, bad).toBe(0);
    }
    expect(mail.sent).toEqual([]);
  });

  it('replaces an earlier verification code with a later one', async () => {
    const address = await registered();
    const first = codeIn('email_verification');
    const login = await loggedIn(address);
    expect((await post('/email/verification', {}, login.token)).status).toBe(202);
    const second = codeIn('email_verification');
    expect(second).not.toBe(first);
    expect((await post('/email/verify', { token: first })).status).toBe(400);
    expect((await post('/email/verify', { token: second })).status).toBe(200);
  });

  it('refuses a code that has expired', async () => {
    await registered();
    const code = codeIn('email_verification');
    now = new Date(now.getTime() + 49 * 3_600_000);
    expect((await post('/email/verify', { token: code })).body).toMatchObject({ reason: 'TOKEN_INVALID' });
  });
});

describe('what is stored', () => {
  it('keeps no password, no session token and no one-time code in the clear: hashes of them, and the parameters the password was hashed under', async () => {
    const address = await registered();
    const code = codeIn('email_verification');
    const { token, userId } = await loggedIn(address);
    const credential = (await database.pool.query('SELECT algorithm, n, r, p, key_length, salt, hash FROM identity.credential WHERE user_id = $1', [userId])).rows[0];
    expect(credential).toMatchObject({ algorithm: 'scrypt', n: 65_536, r: 8, p: 1, key_length: 32 });
    expect(credential.salt).toHaveLength(16);
    expect(credential.hash).toHaveLength(32);

    const dump = JSON.stringify([
      (await database.pool.query('SELECT * FROM identity.credential')).rows,
      (await database.pool.query('SELECT * FROM identity.session')).rows,
      (await database.pool.query('SELECT * FROM identity.one_time_token')).rows,
      (await database.pool.query('SELECT * FROM identity.app_user')).rows,
    ]);
    for (const secret of [PASSWORD, token, code]) expect(dump).not.toContain(secret);
    const session = (await database.pool.query('SELECT token_hash FROM identity.session WHERE user_id = $1', [userId])).rows[0];
    expect(Buffer.from(session.token_hash).equals(createHash('sha256').update(token).digest())).toBe(true);
  });

  it('gives two people the same password and different hashes', async () => {
    const [a, b] = [await registered(), await registered()];
    const hashes = (await database.pool.query('SELECT c.hash, c.salt FROM identity.credential c JOIN identity.app_user u USING (user_id) WHERE u.email_normalized = ANY($1)', [[a, b]])).rows;
    expect(hashes).toHaveLength(2);
    expect(Buffer.from(hashes[0].hash).equals(hashes[1].hash)).toBe(false);
    expect(Buffer.from(hashes[0].salt).equals(hashes[1].salt)).toBe(false);
  });
});

describe('the routes that need a session', () => {
  it('answer 401 to a request with none, and the public ones answer it nothing', async () => {
    for (const path of ['/logout', '/logout-all', '/session/rotate', '/password/change', '/email/verification']) {
      expect((await post(path, { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD })).status, path).toBe(401);
    }
    expect((await post('/password/recovery', { email: email() })).status).toBe(202);
  });

  it('are told not to be cached, and so is a login that hands out a token', async () => {
    const address = await registered();
    const login = await post('/login', { email: address, password: PASSWORD });
    expect(login.headers['cache-control']).toBe('no-store');
    expect((await post('/logout', {}, login.body.sessionToken)).headers['cache-control']).toBe('no-store');
  });
});

describe('logging in', () => {
  it('opens a session that authenticates a request to another context, which was not changed to accept it', async () => {
    const { token } = await loggedIn(await registered());
    expect(await learnerStatus(token)).toBe(200);
  });

  it('answers an unknown address, a wrong password and a malformed address identically: the same status and body', async () => {
    const known = await registered();
    const answers = [await post('/login', { email: known, password: 'the wrong password' }), await post('/login', { email: email(), password: PASSWORD }), await post('/login', { email: 'nonsense', password: PASSWORD }), await post('/login', { email: known })];
    expect(new Set(answers.map((answer) => answer.status))).toEqual(new Set([401]));
    const bodies = answers.map((answer) => withoutCorrelation(answer.body));
    expect(bodies.every((body) => JSON.stringify(body) === JSON.stringify(bodies[0]))).toBe(true);
    expect(bodies[0]).toMatchObject({ reason: 'INVALID_CREDENTIALS', status: 401 });
  });

  it('does not accept a disabled account, and says what it says to every other refusal', async () => {
    const address = await registered();
    await database.pool.query('UPDATE identity.app_user SET disabled_at = now() WHERE email_normalized = $1', [address]);
    const refused = await post('/login', { email: address, password: PASSWORD });
    expect(refused.status).toBe(401);
    expect(refused.body).toMatchObject({ reason: 'INVALID_CREDENTIALS' });
  });

  it('refuses a stub-signed token for the same person, whatever its claims', async () => {
    const { userId } = await loggedIn(await registered());
    const issued = Math.floor(Date.now() / 1000);
    const stub = issue({ sub: userId, kind: 'human', roles: ['learner'], iat: issued, exp: issued + 3600, iss: COMPOSED_CONFIG.authIssuer, jti: randomUUID() }, { signingKey: COMPOSED_CONFIG.authSigningKey, issuer: COMPOSED_CONFIG.authIssuer });
    expect(await learnerStatus(stub)).toBe(401);
    expect((await http().post('/v1/analytics/events').set('Authorization', `Bearer ${stub}`).send({ events: [] })).status).toBe(401);
  });

  it('refuses no header, a wrong scheme, an empty token and a made-up one, all with the same 401', async () => {
    for (const header of [undefined, 'Basic abc', 'Bearer ', 'Bearer not-a-session']) {
      const call = http().get(LEARNER_ROUTE);
      const response = await (header === undefined ? call : call.set('Authorization', header));
      expect(response.status, String(header)).toBe(401);
    }
  });
});

describe('revocation is effective at the next request', () => {
  it('logout ends the session, and the very next request with its token is refused', async () => {
    const { token } = await loggedIn(await registered());
    expect(await learnerStatus(token)).toBe(200);
    expect((await post('/logout', {}, token)).status).toBe(200);
    expect(await learnerStatus(token)).toBe(401);
  });

  it('logout-all ends every session of the user and nobody else\'s', async () => {
    const address = await registered();
    const [one, two] = [await loggedIn(address), await loggedIn(address)];
    const stranger = await loggedIn(await registered());
    expect((await post('/logout-all', {}, one.token)).body).toEqual({ revoked: 2 });
    expect([await learnerStatus(one.token), await learnerStatus(two.token), await learnerStatus(stranger.token)]).toEqual([401, 401, 200]);
  });

  it('will not end a session that is not the caller\'s: a token that is someone else\'s is not found, as one that is no one\'s is', async () => {
    const mine = await loggedIn(await registered());
    const theirs = await loggedIn(await registered());
    const { logout } = identityHandlers({ pool: database.pool, clock: { now: () => now }, identifiers: uuidFactory, audit: { record: async () => undefined }, mail, principals: { resolve: () => null }, maxSessionsPerUser: 5, ...identityAbuseDeps });
    const asMe = { principal: { kind: 'human' as const, id: mine.userId, roleContext: ['learner'] }, correlationId: 'c' };
    expect(await logout.handle({ sessionToken: theirs.token }, asMe)).toMatchObject({ ok: false, error: { kind: 'NotFound', code: 'SESSION_NOT_FOUND' } });
    expect(await logout.handle({ sessionToken: 'a token that is no one\'s' }, asMe)).toMatchObject({ ok: false, error: { kind: 'NotFound', code: 'SESSION_NOT_FOUND' } });
    expect(await learnerStatus(theirs.token)).toBe(200);
  });

  it('ends the oldest session when a login exceeds the configured maximum', async () => {
    const address = await registered();
    const sessions = [];
    for (let i = 0; i < MAX_SESSIONS + 1; i += 1) {
      now = new Date(now.getTime() + 1_000);
      sessions.push(await loggedIn(address));
    }
    expect(await Promise.all(sessions.map((session) => learnerStatus(session.token)))).toEqual([401, 200, 200, 200]);
    expect((await database.pool.query(`SELECT revoked_reason FROM identity.session WHERE session_id = $1`, [sessions[0]!.sessionId])).rows[0].revoked_reason).toBe('device_limit');
  });

  it('will not rotate a session that is not the caller\'s, nor one that has already ended', async () => {
    const mine = await loggedIn(await registered());
    const theirs = await loggedIn(await registered());
    const { rotateSession } = identityHandlers({ pool: database.pool, clock: { now: () => now }, identifiers: uuidFactory, audit: { record: async () => undefined }, mail, principals: { resolve: () => null }, maxSessionsPerUser: 5, ...identityAbuseDeps });
    const asMe = { principal: { kind: 'human' as const, id: mine.userId, roleContext: ['learner'] }, correlationId: 'c' };
    expect(await rotateSession.handle({ sessionToken: theirs.token }, asMe)).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND' } });
    expect((await post('/logout', {}, mine.token)).status).toBe(200);
    expect(await rotateSession.handle({ sessionToken: mine.token }, asMe)).toMatchObject({ ok: false, error: { code: 'SESSION_NOT_FOUND' } });
    expect(await learnerStatus(theirs.token)).toBe(200);
  });

  it('rotates a session: the new token works and the old one is refused', async () => {
    const { token } = await loggedIn(await registered());
    const rotated = await post('/session/rotate', {}, token);
    expect(rotated.status).toBe(200);
    expect(rotated.body.sessionToken).not.toBe(token);
    expect([await learnerStatus(token), await learnerStatus(rotated.body.sessionToken)]).toEqual([401, 200]);
    expect((await post('/session/rotate', {}, token)).status).toBe(401);
  });

  it('refuses a session past its life and one unused for a week, and accepts one just inside both', async () => {
    const day = 24 * 3_600_000;
    const advance = (ms: number) => void (now = new Date(now.getTime() + ms));
    const lifetime = await loggedIn(await registered());
    // used every six days, so it is never idle, and old enough at the end to be past its life
    for (let i = 0; i < 4; i += 1) {
      advance(6 * day);
      expect(await learnerStatus(lifetime.token)).toBe(200);
    }
    advance(SESSION_LIFETIME_MS - 24 * day - 1_000);
    expect(await learnerStatus(lifetime.token)).toBe(200);
    advance(2_000);
    expect(await learnerStatus(lifetime.token)).toBe(401);

    const idle = await loggedIn(await registered());
    advance(SESSION_IDLE_MS - 1_000);
    expect(await learnerStatus(idle.token)).toBe(200);
    // use renews the idle window
    advance(SESSION_IDLE_MS - 1_000);
    expect(await learnerStatus(idle.token)).toBe(200);
    advance(SESSION_IDLE_MS + 1_000);
    expect(await learnerStatus(idle.token)).toBe(401);
  });

  it('refuses a session of a user who has since been disabled', async () => {
    const address = await registered();
    const { token } = await loggedIn(address);
    await database.pool.query('UPDATE identity.app_user SET disabled_at = now() WHERE email_normalized = $1', [address]);
    expect(await learnerStatus(token)).toBe(401);
  });
});

describe('changing a password', () => {
  it('needs the current one, replaces it, ends the other sessions and keeps the one in use', async () => {
    const address = await registered();
    const [mine, other] = [await loggedIn(address), await loggedIn(address)];
    const wrong = await post('/password/change', { currentPassword: 'not it', newPassword: OTHER_PASSWORD }, mine.token);
    expect(wrong.status).toBe(401);
    expect(wrong.body).toMatchObject({ reason: 'CURRENT_PASSWORD_WRONG' });

    const changed = await post('/password/change', { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD }, mine.token);
    expect(changed.body).toEqual({ revokedOtherSessions: 1 });
    expect([await learnerStatus(mine.token), await learnerStatus(other.token)]).toEqual([200, 401]);
    expect((await post('/login', { email: address, password: PASSWORD })).status).toBe(401);
    await loggedIn(address, OTHER_PASSWORD);
  });

  it('refuses a new password that is too short, and changes nothing', async () => {
    const address = await registered();
    const { token } = await loggedIn(address);
    expect((await post('/password/change', { currentPassword: PASSWORD, newPassword: 'short' }, token)).body).toMatchObject({ reason: 'PASSWORD_TOO_SHORT' });
    await loggedIn(address, PASSWORD);
  });
});

describe('changing a password to one that is known to be bad', () => {
  it('refuses it, keeps the old password, and leaves every session standing', async () => {
    const address = await registered();
    const [mine, other] = [await loggedIn(address), await loggedIn(address)];
    const refused = await post('/password/change', { currentPassword: PASSWORD, newPassword: 'iloveyou1234' }, mine.token);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ reason: 'PASSWORD_BREACHED', detail: 'That password is too common or has appeared in a data breach. Choose a different one.' });
    expect([await learnerStatus(mine.token), await learnerStatus(other.token)]).toEqual([200, 200]);
    await loggedIn(address, PASSWORD);
  });
});

describe('recovering a password', () => {
  it('answers a known address and an unknown one the same, and mails only the known one', async () => {
    const address = await registered();
    mail.sent.length = 0;
    const known = await post('/password/recovery', { email: address });
    const unknown = await post('/password/recovery', { email: email() });
    const malformed = await post('/password/recovery', { email: 'nonsense' });
    expect([known.status, unknown.status, malformed.status]).toEqual([202, 202, 202]);
    expect(known.body).toEqual(unknown.body);
    expect(known.body).toEqual(malformed.body);
    expect(mail.sent.map((message) => [message.to, message.purpose])).toEqual([[address, 'password_recovery']]);
  });

  it('mails no recovery code to a disabled account, and answers as it answers everyone', async () => {
    const address = await registered();
    await database.pool.query('UPDATE identity.app_user SET disabled_at = now() WHERE email_normalized = $1', [address]);
    mail.sent.length = 0;
    const response = await post('/password/recovery', { email: address });
    expect(response.status).toBe(202);
    expect(mail.sent).toEqual([]);
  });

  it('resets the password once, ends every session, and refuses the code a second time', async () => {
    const address = await registered();
    const { token } = await loggedIn(address);
    await post('/password/recovery', { email: address });
    const code = codeIn('password_recovery');
    const reset = await post('/password/reset', { token: code, newPassword: OTHER_PASSWORD });
    expect(reset.status).toBe(200);
    expect(await learnerStatus(token)).toBe(401);
    expect((await post('/login', { email: address, password: PASSWORD })).status).toBe(401);
    await loggedIn(address, OTHER_PASSWORD);
    const again = await post('/password/reset', { token: code, newPassword: 'yet another passphrase' });
    expect(again.status).toBe(400);
    expect(again.body).toMatchObject({ reason: 'TOKEN_INVALID' });
  });

  it('replaces an earlier recovery code with a later one, and refuses one that has expired', async () => {
    const address = await registered();
    await post('/password/recovery', { email: address });
    const first = codeIn('password_recovery');
    await post('/password/recovery', { email: address });
    const second = codeIn('password_recovery');
    expect((await post('/password/reset', { token: first, newPassword: OTHER_PASSWORD })).status).toBe(400);
    now = new Date(now.getTime() + 2 * 3_600_000);
    expect((await post('/password/reset', { token: second, newPassword: OTHER_PASSWORD })).status).toBe(400);
  });

  it('refuses a recovery code that has been made worthless by a password change', async () => {
    const address = await registered();
    const { token } = await loggedIn(address);
    await post('/password/recovery', { email: address });
    const code = codeIn('password_recovery');
    await post('/password/change', { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD }, token);
    expect((await post('/password/reset', { token: code, newPassword: 'yet another passphrase' })).status).toBe(400);
  });

  it('refuses to reset to a password that is too short, and leaves the code unspent', async () => {
    const address = await registered();
    await post('/password/recovery', { email: address });
    const code = codeIn('password_recovery');
    expect((await post('/password/reset', { token: code, newPassword: 'short' })).body).toMatchObject({ reason: 'PASSWORD_TOO_SHORT' });
    expect((await post('/password/reset', { token: code, newPassword: OTHER_PASSWORD })).status).toBe(200);
  });
});

describe('resetting a password to one that is known to be bad', () => {
  it('refuses it, leaves the code unspent and the old password in force, and accepts a better one with the same code', async () => {
    const address = await registered();
    await post('/password/recovery', { email: address });
    const code = codeIn('password_recovery');
    const refused = await post('/password/reset', { token: code, newPassword: 'letmein123456' });
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ reason: 'PASSWORD_BREACHED', detail: 'That password is too common or has appeared in a data breach. Choose a different one.' });
    await loggedIn(address, PASSWORD);
    expect((await post('/password/reset', { token: code, newPassword: OTHER_PASSWORD })).status).toBe(200);
    await loggedIn(address, OTHER_PASSWORD);
  });

  it('says the same about a breached password whether or not the code is good: the password is judged first, and the code is not spent by it', async () => {
    const withMadeUpCode = await post('/password/reset', { token: 'made-up-code', newPassword: 'letmein123456' });
    const address = await registered();
    await post('/password/recovery', { email: address });
    const withGoodCode = await post('/password/reset', { token: codeIn('password_recovery'), newPassword: 'letmein123456' });
    expect([withMadeUpCode.status, withGoodCode.status]).toEqual([400, 400]);
    expect(withoutCorrelation(withMadeUpCode.body)).toEqual(withoutCorrelation(withGoodCode.body));
  });
});

describe('a credential under older parameters is strengthened on the next login, never reset', () => {
  it('rehashes under today\'s parameters on a successful login, and the password still works', async () => {
    const weak = new ScryptPasswordHasher({ algorithm: 'scrypt', n: 16_384, r: 8, p: 1, keyLength: 32 });
    const users = new PostgresUserStore(database.pool);
    const address = email();
    const userId = randomUUID();
    await users.create({ userId, email: address, emailNormalized: address, emailVerifiedAt: null, roles: ['learner'], disabledAt: null, createdAt: now }, await weak.hash(PASSWORD));
    expect((await database.pool.query('SELECT n FROM identity.credential WHERE user_id = $1', [userId])).rows[0].n).toBe(16_384);

    await loggedIn(address);
    expect((await database.pool.query('SELECT n, r, p, key_length FROM identity.credential WHERE user_id = $1', [userId])).rows[0]).toEqual({ n: 65_536, r: 8, p: 1, key_length: 32 });
    await loggedIn(address);
  });

  it('does not rewrite a credential on a failed login', async () => {
    const weak = new ScryptPasswordHasher({ algorithm: 'scrypt', n: 16_384, r: 8, p: 1, keyLength: 32 });
    const address = email();
    const userId = randomUUID();
    await new PostgresUserStore(database.pool).create({ userId, email: address, emailNormalized: address, emailVerifiedAt: null, roles: ['learner'], disabledAt: null, createdAt: now }, await weak.hash(PASSWORD));
    expect((await post('/login', { email: address, password: 'not the password at all' })).status).toBe(401);
    expect((await database.pool.query('SELECT n FROM identity.credential WHERE user_id = $1', [userId])).rows[0].n).toBe(16_384);
  });
});

describe('an unknown address costs what a known one costs', () => {
  const handlers = (hash: () => void) => {
    const real = new ScryptPasswordHasher({ algorithm: 'scrypt', n: 16_384, r: 8, p: 1, keyLength: 32 });
    const counting = { parameters: real.parameters, hash: (password: string) => (hash(), real.hash(password)), verify: (password: string, stored: Parameters<typeof real.verify>[1]) => (hash(), real.verify(password, stored)) };
    return identityHandlers({ pool: database.pool, clock: { now: () => now }, identifiers: uuidFactory, audit: { record: async () => undefined }, mail, principals: { resolve: () => null }, maxSessionsPerUser: 5, hasher: counting, ...identityAbuseDeps });
  };
  const guest = { principal: { kind: 'human' as const, id: '00000000-0000-4000-8000-000000000000', roleContext: ['guest'] }, correlationId: 'c' };

  it('does one password hash on the unknown path and on the wrong-password path, and the same on the right one', async () => {
    let work = 0;
    const { login } = handlers(() => (work += 1));
    const users = new PostgresUserStore(database.pool);
    const address = email();
    const real = new ScryptPasswordHasher({ algorithm: 'scrypt', n: 16_384, r: 8, p: 1, keyLength: 32 });
    await users.create({ userId: randomUUID(), email: address, emailNormalized: address, emailVerifiedAt: null, roles: ['learner'], disabledAt: null, createdAt: now }, await real.hash(PASSWORD));
    await login.handle({ email: email(), password: PASSWORD }, guest); // the decoy is made once, here
    work = 0;
    const counts: number[] = [];
    for (const attempt of [{ email: email(), password: PASSWORD }, { email: address, password: 'wrong' }, { email: 'nonsense', password: PASSWORD }, { email: address, password: PASSWORD }]) {
      work = 0;
      await login.handle(attempt, guest);
      counts.push(work);
    }
    // the right one is allowed one more: it makes the session, not a hash, but its credential is current here so there is no rehash either
    expect(counts).toEqual([1, 1, 1, 1]);
  });

  it('takes about as long: an unknown address is not answered early', async () => {
    const { login } = handlers(() => undefined);
    const address = email();
    // the same cost as the hasher the handlers use: a known account on older parameters would time differently from the decoy, which is a limit the README names
    const real = new ScryptPasswordHasher({ algorithm: 'scrypt', n: 16_384, r: 8, p: 1, keyLength: 32 });
    await new PostgresUserStore(database.pool).create({ userId: randomUUID(), email: address, emailNormalized: address, emailVerifiedAt: null, roles: ['learner'], disabledAt: null, createdAt: now }, await real.hash(PASSWORD));
    const time = async (attempt: { email: string; password: string }) => {
      const begun = performance.now();
      await login.handle(attempt, guest);
      return performance.now() - begun;
    };
    await time({ email: email(), password: PASSWORD }); // the decoy, made once
    const unknown: number[] = [];
    const wrong: number[] = [];
    for (let i = 0; i < 5; i += 1) {
      unknown.push(await time({ email: email(), password: PASSWORD }));
      wrong.push(await time({ email: address, password: 'wrong password entirely' }));
    }
    const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
    // an early return would be a few milliseconds against a hash's tens; this holds the two within a factor of two of each other
    expect(median(unknown)).toBeGreaterThan(median(wrong) * 0.5);
    expect(median(unknown)).toBeLessThan(median(wrong) * 2);
  });

  it('does the work of a registration for a known address, and of a recovery for an unknown one', async () => {
    let work = 0;
    let drawn = 0;
    const h = handlers(() => (work += 1));
    const address = email();
    await h.register.handle({ email: address, password: PASSWORD }, guest);
    work = 0;
    await h.register.handle({ email: address, password: PASSWORD }, guest);
    expect(work).toBe(1);
    drawn = mail.sent.length;
    await h.requestPasswordRecovery.handle({ email: email() }, guest);
    expect(mail.sent.length).toBe(drawn);
  });
});

describe('the audit trail', () => {
  it('records the consequential commands, with ids and no secrets', async () => {
    const address = await registered();
    const { token, userId } = await loggedIn(address);
    await post('/password/change', { currentPassword: PASSWORD, newPassword: OTHER_PASSWORD }, token);
    await post('/logout-all', {}, token);
    const rows = (await database.pool.query(`SELECT action, target_id FROM platform.audit_record WHERE target_context = 'identity' AND target_id = $1 ORDER BY audit_record_id`, [userId])).rows.map((row) => row.action);
    expect(rows).toEqual(['UserRegistered', 'PasswordChanged', 'AllSessionsRevoked']);
  });
});

describe('assigning and removing a role (M8-12)', () => {
  /** What the first-administrator command does, in the test's own words: the routes cannot make the first admin, and neither can a test without writing the row. */
  async function admin(): Promise<{ email: string; token: string; userId: string }> {
    const address = await registered();
    const { userId } = await loggedIn(address);
    // one administrator at a time, so that a test about the last one is about the last one
    await database.pool.query(`UPDATE identity.app_user SET roles = array_remove(roles, 'admin') WHERE 'admin' = ANY(roles)`);
    await database.pool.query(`UPDATE identity.app_user SET roles = ARRAY['learner', 'admin'] WHERE user_id = $1`, [userId]);
    return { email: address, ...(await loggedIn(address)) };
  }
  const rolesOf = async (userId: string): Promise<string[]> => (await database.pool.query('SELECT roles FROM identity.app_user WHERE user_id = $1', [userId])).rows[0].roles;

  it('lets an admin give a role and take it away, answers with what the person holds now, and audits both', async () => {
    const boss = await admin();
    const address = await registered();
    const { userId } = await loggedIn(address);
    const given = await post('/roles/assign', { email: address.toUpperCase(), role: 'author' }, boss.token);
    expect([given.status, given.body]).toEqual([200, { userId, roles: ['learner', 'author'], changed: true }]);
    expect(await rolesOf(userId)).toEqual(['learner', 'author']);
    const taken = await post('/roles/remove', { email: address, role: 'author' }, boss.token);
    expect([taken.status, taken.body]).toEqual([200, { userId, roles: ['learner'], changed: true }]);
    const audit = (await database.pool.query(`SELECT action, principal_id, target_type, target_id FROM platform.audit_record WHERE target_context = 'identity' AND target_id = $1 ORDER BY audit_record_id`, [`${userId}:author`])).rows;
    expect(audit).toEqual([
      { action: 'RoleAssigned', principal_id: boss.userId, target_type: 'UserRole', target_id: `${userId}:author` },
      { action: 'RoleRemoved', principal_id: boss.userId, target_type: 'UserRole', target_id: `${userId}:author` },
    ]);
  });

  it('refuses everyone who is not an admin, with the same 403, and nobody gains a role', async () => {
    const address = await registered();
    const me = await loggedIn(address);
    const attempt = await post('/roles/assign', { email: address, role: 'admin' }, me.token);
    expect(attempt.status).toBe(403);
    expect(attempt.body).toMatchObject({ reason: 'NOT_PERMITTED' });
    expect((await post('/roles/remove', { email: address, role: 'learner' }, me.token)).status).toBe(403);
    expect((await post('/roles/assign', { email: address, role: 'admin' })).status).toBe(401);
    expect(await rolesOf(me.userId)).toEqual(['learner']);
  });

  it('is in force at the person\'s next request, on the session they already had: a role given is there, and a role taken is gone', async () => {
    const boss = await admin();
    const address = await registered();
    const person = await loggedIn(address);
    const other = await registered();
    const askAsPerson = () => post('/roles/assign', { email: other, role: 'author' }, person.token);

    expect((await askAsPerson()).status).toBe(403);
    expect((await post('/roles/assign', { email: address, role: 'admin' }, boss.token)).status).toBe(200);
    expect((await askAsPerson()).status).toBe(200);

    expect((await post('/roles/remove', { email: address, role: 'admin' }, boss.token)).status).toBe(200);
    expect((await askAsPerson()).status).toBe(403);
    // taking a role away ends nothing else: the session is the same one and still works
    expect(await learnerStatus(person.token)).toBe(200);
  });

  it('will not let anyone change their own roles, in either direction, and says so', async () => {
    const boss = await admin();
    const removed = await post('/roles/remove', { email: boss.email, role: 'admin' }, boss.token);
    expect([removed.status, removed.body.reason]).toEqual([422, 'OWN_ROLES']);
    const given = await post('/roles/assign', { email: boss.email, role: 'author' }, boss.token);
    expect([given.status, given.body.reason]).toEqual([422, 'OWN_ROLES']);
    expect(await rolesOf(boss.userId)).toEqual(['learner', 'admin']);
  });

  it('refuses a role a person cannot hold, an address nobody has, and a role already held, each in its own way', async () => {
    const boss = await admin();
    const address = await registered();
    for (const role of ['guest', 'system', 'generation_pipeline', 'banana']) {
      const refused = await post('/roles/assign', { email: address, role }, boss.token);
      expect([refused.status, (refused.body as { reason: string }).reason], role).toEqual([400, 'ROLE_NOT_ASSIGNABLE']);
    }
    const unknown = await post('/roles/assign', { email: email(), role: 'author' }, boss.token);
    expect([unknown.status, unknown.body.reason]).toEqual([404, 'USER_NOT_FOUND']);
    const already = await post('/roles/assign', { email: address, role: 'learner' }, boss.token);
    expect([already.status, already.body.changed]).toEqual([200, false]);
  });
});
