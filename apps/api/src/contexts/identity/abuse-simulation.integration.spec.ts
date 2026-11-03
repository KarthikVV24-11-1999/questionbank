import { seedPerson } from '../../testing/identity-people.js';
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import type { Pool } from 'pg';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createApplication } from '../../platform/composition/app-factory.js';
import { DEFAULT_ABUSE_LIMITS, type AppConfig } from '../../platform/config/config.js';
import { createRecordingTelemetry } from '../../platform/observability/recording-telemetry.js';
import { PostgresRateLimiter } from '../../platform/persistence/postgres-rate-limiter.js';
import { parseRouteLimits, type RateLimiter } from '../../platform/rate-limit/rate-limiter.js';
import { COMPOSED_CONFIG } from '../../testing/composed-generation.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { uuidFactory } from '../../testing/generation-context.js';
import { serveOnLoopback } from '../../testing/loopback.js';
import type { BreachedPasswords, BreachVerdict, PasswordHasher } from './application/ports.js';
import { CURRENT_PASSWORD_PARAMETERS, type PasswordParameters, type StoredCredential } from './domain/password-hash.js';
import { MemoryMail } from './infrastructure/mail-adapters.js';
import { PostgresUserStore } from './infrastructure/postgres-stores.js';
import { ScryptPasswordHasher } from './infrastructure/scrypt-password-hasher.js';

/**
 * Abuse simulation (NFR SEC-09, M8-06 to M8-10). Through the composed application, real Postgres, the real limiter and the real bound on hashing.
 *
 * **The pair is the point.** One half shows that a burst which, before this track, would have been admitted whole is refused now; the other that a school logging in at nine
 * is served in full by the same defaults. A limiter that refuses everything passes the first half and fails the second, so they live in this one file.
 *
 * **What is measured, and what is not.**
 *   - Derives in flight are counted at the hasher itself, so that figure is exact: the most that ever ran at once.
 *   - Memory is the test process's resident set sampled every few milliseconds while the burst runs, as growth over where it started. It is an upper-bound check, not a model: it
 *     includes the allocator's own caching and the garbage collector's timing, so it can overstate and the bound has slack in it. It is not compared with an unbounded run's
 *     figure, because that figure is capped by libuv's four-thread pool and is not the "200 requests, 12.8 GB" the brief supposed (docs/DEBT.md D99 records what the real exposure is).
 *     What the unbounded control below does prove is that the counter is not blind: with the bound raised, more than the default number of derives do run at once.
 *   - Not proven here: behaviour under a pool larger than four, or in a container with a memory limit. Those need the deployed environment.
 *   - The 12.8 GB figure itself is not reproduced and cannot be on this stack; see above.
 */
const PASSWORD = 'correct horse battery staple';
const CHEAP: PasswordParameters = { algorithm: 'scrypt', n: 1024, r: 8, p: 1, keyLength: 32 };
const MIB = 1024 * 1024;

let database: TestDatabase;
let now = new Date('2026-11-03T09:00:00.000Z');
const open: INestApplication[] = [];

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});
beforeEach(async () => {
  now = new Date('2026-11-03T09:00:00.000Z');
  await database.pool.query('DELETE FROM ratelimit.counter');
});
afterEach(async () => {
  await Promise.all(open.splice(0).map((app) => app.close()));
});

const policy = (text: string, subject = true) => {
  const parsed = parseRouteLimits(text, { subject });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};
const WIDE = 'source=1000000/10s;subject=1000000/1m';

/** A hasher that counts what the bound lets through, how many ran together, and can be told to hold every verify until released. */
class Instrumented implements PasswordHasher {
  readonly inner: ScryptPasswordHasher;
  derives = 0;
  inFlight = 0;
  peak = 0;
  held = false;
  #release: Array<() => void> = [];
  constructor(readonly parameters: PasswordParameters) {
    this.inner = new ScryptPasswordHasher(parameters);
  }
  async #derive<T>(work: () => Promise<T>): Promise<T> {
    this.derives += 1;
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this.held) await new Promise<void>((resolve) => this.#release.push(resolve));
      return await work();
    } finally {
      this.inFlight -= 1;
    }
  }
  hash(password: string): Promise<StoredCredential> {
    return this.#derive(() => this.inner.hash(password));
  }
  verify(password: string, stored: StoredCredential): Promise<boolean> {
    return this.#derive(() => this.inner.verify(password, stored));
  }
  releaseAll(): void {
    this.held = false;
    for (const release of this.#release.splice(0)) release();
  }
}

/** The pool, counting reads of the table of people: a limited request must not make one. */
function countingPool(pool: Pool): { pool: Pool; reads: () => number } {
  let reads = 0;
  const proxy = new Proxy(pool, {
    get(target, property) {
      const value: unknown = Reflect.get(target, property, target);
      if (property === 'query') {
        return (...args: unknown[]) => {
          if (typeof args[0] === 'string' && args[0].includes('identity.app_user')) reads += 1;
          return (value as (...forwarded: unknown[]) => unknown).apply(target, args);
        };
      }
      return typeof value === 'function' ? (value as (...forwarded: unknown[]) => unknown).bind(target) : value;
    },
  });
  return { pool: proxy, reads: () => reads };
}

async function compose(options: { config?: Partial<AppConfig>; hasher?: PasswordHasher; limiter?: RateLimiter; breached?: BreachedPasswords } = {}) {
  const lines: string[] = [];
  const mail = new MemoryMail();
  const counted = countingPool(database.pool);
  const hits: string[] = [];
  const real = new PostgresRateLimiter(database.pool, () => now);
  const limiter: RateLimiter = options.limiter ?? { hit: (key, rules) => (hits.push(key), real.hit(key, rules)) };
  const app = await createApplication(
    { ...COMPOSED_CONFIG, trustProxyHops: 1, ...options.config },
    { pool: counted.pool, telemetry: createRecordingTelemetry(), clock: { now: () => now }, identifiers: uuidFactory, mail, limiter, logWrite: (line) => void lines.push(line), ...(options.hasher === undefined ? {} : { hasher: options.hasher }), ...(options.breached === undefined ? {} : { breached: options.breached }) },
  );
  await serveOnLoopback(app);
  open.push(app);
  const http = () => request(app.getHttpServer());
  const post = (path: string, body: object, source = '198.51.100.1', token?: string) => {
    const call = http().post(`/v1/identity${path}`).set('X-Forwarded-For', source);
    return (token === undefined ? call : call.set('Authorization', `Bearer ${token}`)).send(body);
  };
  return { app, http, mail, lines, hits, reads: counted.reads, post, records: () => lines.map((line) => JSON.parse(line) as Record<string, unknown>) };
}

async function person(hasher: PasswordHasher, address = `person-${randomUUID().slice(0, 8)}@example.com`, credential?: StoredCredential): Promise<{ email: string; userId: string }> {
  const userId = randomUUID();
  await seedPerson(database.pool, { userId, email: address, emailNormalized: address, emailVerifiedAt: null, roles: ['learner'], disabledAt: null, createdAt: now }, credential ?? (await hasher.hash(PASSWORD)));
  return { email: address, userId };
}

const stripped = (body: Record<string, unknown>) => ({ ...body, correlationId: undefined });
const unknownAddress = () => `nobody-${randomUUID().slice(0, 8)}@example.com`;

describe('a limited request (M8-07, M8-09)', () => {
  it('answers 429 with Retry-After in the shape every other refusal has, once an address has been asked about too often', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy('source=1000/10s;subject=3/1m,10/15m') } });
    const who = await person(hasher);
    const answers = [];
    for (let attempt = 0; attempt < 4; attempt += 1) answers.push(await system.post('/login', { email: who.email, password: 'wrong wrong wrong' }));
    expect(answers.map((answer) => answer.status)).toEqual([401, 401, 401, 429]);
    const limited = answers[3]!;
    expect(limited.headers['retry-after']).toBe('60');
    expect(limited.headers['content-type']).toContain('application/problem+json');
    expect(limited.headers['cache-control']).toBe('no-store');
    expect(Object.keys(limited.body as object).sort()).toEqual(['code', 'correlationId', 'detail', 'reason', 'retryable', 'status', 'title', 'type']);
    expect(limited.body).toMatchObject({ status: 429, title: 'Too many requests', code: 'RateLimited', reason: 'RATE_LIMITED', retryable: true, detail: 'Too many requests. Try again later.' });
  });

  it('says nothing about the limit beyond Retry-After: no remaining, no allowance, no tier, no which-of-the-two', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy('source=1000/10s;subject=1/1m,10/15m') } });
    const who = await person(hasher);
    await system.post('/login', { email: who.email, password: 'wrong wrong wrong' });
    const limited = await system.post('/login', { email: who.email, password: 'wrong wrong wrong' });
    const everything = JSON.stringify({ body: limited.body, headers: limited.headers });
    expect(everything).not.toMatch(/remaining|allowance|burst|sustained|tier|subject|source|1\/1m/iu);
    expect(Object.keys(limited.headers).filter((name) => /limit|remaining|reset/iu.test(name))).toEqual([]);
  });

  it('answers a known address and an unknown one the same when limited, and does no work for either: no derive, no lookup of the address', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy('source=1000/10s;subject=2/1m') } });
    const known = await person(hasher);
    const unknown = unknownAddress();
    const probe = (email: string) => system.post('/login', { email, password: 'wrong wrong wrong' });
    // warm the decoy so the figures below are a request's own
    await probe(unknownAddress());
    for (const email of [known.email, unknown]) {
      await probe(email);
      await probe(email);
    }
    const derivesBefore = hasher.derives;
    const readsBefore = system.reads();
    const hitsBefore = system.hits.length;
    const asKnown = await probe(known.email);
    const asUnknown = await probe(unknown);
    expect([asKnown.status, asUnknown.status]).toEqual([429, 429]);
    expect(asKnown.headers['retry-after']).toBe(asUnknown.headers['retry-after']);
    expect(asKnown.headers['content-type']).toBe(asUnknown.headers['content-type']);
    expect(stripped(asKnown.body as Record<string, unknown>)).toEqual(stripped(asUnknown.body as Record<string, unknown>));
    // the counting test: the same two counters read for each, nothing else done
    expect(system.hits.length - hitsBefore).toBe(4);
    expect(hasher.derives - derivesBefore).toBe(0);
    expect(system.reads() - readsBefore).toBe(0);
  });

  it('does the same work for a known address and an unknown one when not limited: one derive, two counters, one turn at the hasher', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy(WIDE) } });
    const known = await person(hasher);
    await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' });
    const measure = async (email: string, password: string) => {
      const before = [hasher.derives, system.hits.length];
      const answer = await system.post('/login', { email, password });
      return { status: answer.status, derives: hasher.derives - before[0]!, hits: system.hits.length - before[1]! };
    };
    const wrongPassword = await measure(known.email, 'wrong wrong wrong');
    const noSuchAddress = await measure(unknownAddress(), 'wrong wrong wrong');
    const malformed = await measure('not an address', 'wrong wrong wrong');
    expect([wrongPassword, noSuchAddress, malformed]).toEqual([
      { status: 401, derives: 1, hits: 2 },
      { status: 401, derives: 1, hits: 2 },
      { status: 401, derives: 1, hits: 2 },
    ]);
  });

  it('holds a source that asks about many addresses, and an address that is asked about from many sources', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy('source=5/10s;subject=3/1m') } });
    const fromOne = [];
    for (let attempt = 0; attempt < 7; attempt += 1) fromOne.push((await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.50')).status);
    expect(fromOne).toEqual([401, 401, 401, 401, 401, 429, 429]);

    const forOne = [];
    const target = unknownAddress();
    for (let attempt = 0; attempt < 5; attempt += 1) forOne.push((await system.post('/login', { email: target, password: 'wrong wrong wrong' }, `203.0.113.${100 + attempt}`)).status);
    expect(forOne).toEqual([401, 401, 401, 429, 429]);
  });

  it('counts an address however it is written', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy('source=1000/10s;subject=2/1m') } });
    const who = await person(hasher, 'mixed.case@example.com');
    const statuses = [];
    for (const written of ['mixed.case@example.com', 'MIXED.CASE@example.com', '  Mixed.Case@Example.com ']) statuses.push((await system.post('/login', { email: written, password: 'wrong wrong wrong' })).status);
    expect(who.email).toBe('mixed.case@example.com');
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('holds an address for no longer than the longest window of its policy, and lets it in again after that: the ceiling', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy('source=100000/10s;subject=3/1m,7/15m') } });
    const who = await person(hasher);
    const attempt = () => system.post('/login', { email: who.email, password: PASSWORD });
    for (let request = 0; request < 3; request += 1) expect((await attempt()).status).toBe(200);
    const burst = await attempt();
    expect([burst.status, burst.headers['retry-after']]).toEqual([429, '60']);
    now = new Date(now.getTime() + 60_000);
    for (let request = 0; request < 3; request += 1) expect((await attempt()).status).toBe(200);
    // seven in the quarter-hour have been asked: the next is past the sustained tier, which holds now and says how long
    now = new Date(now.getTime() + 60_000);
    const sustained = await attempt();
    expect(sustained.status).toBe(429);
    expect(Number(sustained.headers['retry-after'])).toBeGreaterThan(60);
    expect(Number(sustained.headers['retry-after'])).toBeLessThanOrEqual(900);
    // an attacker failing on purpose in the meantime does not push the end further out
    for (let request = 0; request < 20; request += 1) await system.post('/login', { email: who.email, password: 'wrong wrong wrong' });
    now = new Date(now.getTime() + 900_000);
    expect((await attempt()).status).toBe(200);
  });

  it('limits recovery mail per address, so the route cannot be used to fill an inbox, and sends no more than the limit', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitRecovery: policy('source=1000/1m;subject=2/1m,5/1h') } });
    const who = await person(hasher);
    const statuses = [];
    for (let request = 0; request < 5; request += 1) statuses.push((await system.post('/password/recovery', { email: who.email }, `203.0.113.${request}`)).status);
    expect(statuses).toEqual([202, 202, 429, 429, 429]);
    expect(system.mail.sent.filter((message) => message.purpose === 'password_recovery')).toHaveLength(2);
  });

  it('limits registration per address, so an address that is already taken cannot be sent mail without end', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitRegister: policy('source=1000/10s;subject=2/1m,5/1h') } });
    const who = await person(hasher);
    const statuses = [];
    for (let request = 0; request < 4; request += 1) statuses.push((await system.post('/register', { email: who.email, password: PASSWORD }, `203.0.113.${request}`)).status);
    expect(statuses).toEqual([202, 202, 429, 429]);
    expect(system.mail.sent.filter((message) => message.purpose === 'already_registered')).toHaveLength(2);
  });

  it('limits a reset and a verification code by where they came from, since nobody is named', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitReset: policy('source=2/1m'), rateLimitVerification: policy('source=2/1m;subject=1/1m') } });
    const reset: number[] = [];
    const verify: number[] = [];
    for (let request = 0; request < 3; request += 1) {
      reset.push((await system.post('/password/reset', { token: 'nonsense', newPassword: PASSWORD }, '203.0.113.9')).status);
      verify.push((await system.post('/email/verify', { token: 'nonsense' }, '203.0.113.9')).status);
    }
    expect(reset[2]).toBe(429);
    expect(reset[0]).not.toBe(429);
    expect(verify[2]).toBe(429);
    expect(verify[0]).not.toBe(429);
    // asking for a code is counted apart from submitting one
    expect((await system.post('/email/verification', {}, '203.0.113.10')).status).toBe(401);
  });

  it('limits what a signed-in user may ask of the routes that cost, by user and by source', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy(WIDE), rateLimitPasswordChange: policy('source=1000/1m;subject=2/1m'), rateLimitVerification: policy('source=1000/1m;subject=1/1m') } });
    const who = await person(hasher);
    const login = await system.post('/login', { email: who.email, password: PASSWORD });
    const token = (login.body as { sessionToken: string }).sessionToken;
    const changes: number[] = [];
    for (let request = 0; request < 3; request += 1) changes.push((await system.post('/password/change', { currentPassword: 'not the password', newPassword: 'another long passphrase' }, '203.0.113.20', token)).status);
    expect(changes.slice(0, 2)).not.toContain(429);
    expect(changes[2]).toBe(429);
    const issue = [];
    for (let request = 0; request < 2; request += 1) issue.push((await system.post('/email/verification', {}, '203.0.113.21', token)).status);
    expect(issue).toEqual([202, 429]);
  });

  it('counts each signed-in user apart: one user at the limit does not hold another', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy(WIDE), rateLimitPasswordChange: policy('source=1000/1m;subject=1/1m') } });
    const first = await person(hasher);
    const second = await person(hasher);
    const tokenOf = async (who: { email: string }) => ((await system.post('/login', { email: who.email, password: PASSWORD })).body as { sessionToken: string }).sessionToken;
    const change = (token: string) => system.post('/password/change', { currentPassword: 'not the password', newPassword: 'another long passphrase' }, '203.0.113.30', token).then((answer) => answer.status);
    const [firstToken, secondToken] = [await tokenOf(first), await tokenOf(second)];
    expect(await change(firstToken!)).not.toBe(429);
    expect(await change(firstToken!)).toBe(429);
    expect(await change(secondToken!)).not.toBe(429);
  });

  it('counts asking for a verification code apart from submitting one', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy(WIDE), rateLimitVerification: policy('source=3/1m;subject=5/1m') } });
    const who = await person(hasher);
    const token = ((await system.post('/login', { email: who.email, password: PASSWORD })).body as { sessionToken: string }).sessionToken;
    const submit = () => system.post('/email/verify', { token: 'nonsense' }, '203.0.113.31').then((answer) => answer.status);
    for (let request = 0; request < 3; request += 1) expect(await submit()).not.toBe(429);
    // three submissions have used the source's allowance for submitting; asking for a code is its own count
    expect((await system.post('/email/verification', {}, '203.0.113.31', token)).status).toBe(202);
    expect(await submit()).toBe(429);
  });

  it('does not count a request that never reached a person: no session, no counter for the user', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher });
    const before = system.hits.length;
    expect((await system.post('/password/change', { currentPassword: 'x', newPassword: 'y' })).status).toBe(401);
    expect(system.hits.length - before).toBe(0);
  });

  it('refuses as unavailable, and does no work, when the counters cannot be read', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, limiter: { hit: () => Promise.reject(new Error('the counter table is gone')) } });
    const who = await person(hasher);
    const answer = await system.post('/login', { email: who.email, password: PASSWORD });
    expect(answer.status).toBe(503);
    expect(answer.body).toMatchObject({ code: 'Unavailable', reason: 'UNAVAILABLE', retryable: true });
    expect(JSON.stringify(answer.body)).not.toContain('counter table');
    expect(hasher.derives).toBe(1);
  });

  it('leaves one record for a limited request, a different code from a refused one, and no address in either', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy('source=1000/10s;subject=1/1m') } });
    const who = await person(hasher);
    await system.post('/login', { email: who.email, password: 'wrong wrong wrong' }, '203.0.113.77');
    await system.post('/login', { email: who.email, password: 'wrong wrong wrong' }, '203.0.113.77');
    await system.http().get('/v1/learning/review-plan');
    const records = system.records();
    const limited = records.filter((record) => record['errorCode'] === 'RATE_LIMITED');
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ message: 'request limited', context: 'identity.admission', errorCode: 'RATE_LIMITED', reason: 'subject_burst', route: 'login' });
    expect(records.some((record) => record['errorCode'] === 'MISSING_HEADER')).toBe(true);
    expect(system.lines.join('\n')).not.toMatch(/203\.0\.113\.77|example\.com/u);
  });
});

describe('where a request came from (M8-07)', () => {
  it('believes a forwarded address only as far as it was told to: none, and then every client behind a proxy is one source', async () => {
    const hasher = new Instrumented(CHEAP);
    const none = await compose({ hasher, config: { trustProxyHops: 0, rateLimitLogin: policy('source=2/10s;subject=1000/1m') } });
    const statuses = [];
    for (let request = 0; request < 3; request += 1) statuses.push((await none.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, `203.0.113.${request}`)).status);
    expect(statuses).toEqual([401, 401, 429]);
  });

  it('and one hop reads the address the proxy saw, so clients behind it are counted apart', async () => {
    const hasher = new Instrumented(CHEAP);
    const one = await compose({ hasher, config: { trustProxyHops: 1, rateLimitLogin: policy('source=2/10s;subject=1000/1m') } });
    const statuses = [];
    for (let request = 0; request < 3; request += 1) statuses.push((await one.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, `203.0.113.${request}`)).status);
    expect(statuses).toEqual([401, 401, 401]);
  });
});

describe('the bound on hashing: what a full queue answers (M8-08)', () => {
  const tight: Partial<AppConfig> = { passwordHashConcurrency: 1, passwordHashQueue: 1, passwordHashWaitMs: 150, rateLimitLogin: policy(WIDE) };
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 60));

  async function fill(system: Awaited<ReturnType<typeof compose>>, hasher: Instrumented) {
    // the decoy is made once, on the first unknown address; made here, so that the two below are plain verifies and the queue is what is being filled
    await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.99');
    hasher.held = true;
    const running = system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.1').then((answer) => answer);
    await settle();
    const queued = system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.2').then((answer) => answer);
    await settle();
    return { running, queued };
  }

  it('refuses at once, 503 with Retry-After, when the queue is full, and the same whether the address is known or not', async () => {
    const answers = [];
    for (const kind of ['known', 'unknown'] as const) {
      const hasher = new Instrumented(CHEAP);
      const system = await compose({ hasher, config: { ...tight, passwordHashWaitMs: 5_000 } });
      const who = await person(hasher);
      const held = await fill(system, hasher);
      const started = Date.now();
      const refused = await system.post('/login', { email: kind === 'known' ? who.email : unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.3');
      expect(Date.now() - started).toBeLessThan(1_000);
      answers.push(refused);
      hasher.releaseAll();
      await Promise.all([held.running, held.queued]);
      expect(system.records().some((record) => record['errorCode'] === 'WORK_SATURATED' && record['reason'] === 'queue_full')).toBe(true);
    }
    expect(answers.map((answer) => answer.status)).toEqual([503, 503]);
    expect(answers[0]!.headers['retry-after']).toBe('5');
    expect(answers[0]!.headers['retry-after']).toBe(answers[1]!.headers['retry-after']);
    expect(stripped(answers[0]!.body as Record<string, unknown>)).toEqual(stripped(answers[1]!.body as Record<string, unknown>));
    expect(answers[0]!.body).toMatchObject({ code: 'Unavailable', reason: 'BUSY', retryable: true });
  });

  it('answers a request that waited its time with the same 503, and says in the record which it was', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: tight });
    const held = await fill(system, hasher);
    const started = Date.now();
    const waited = await held.queued;
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(waited.status).toBe(503);
    expect(waited.body).toMatchObject({ code: 'Unavailable', reason: 'BUSY' });
    expect(system.records().some((record) => record['errorCode'] === 'WORK_SATURATED' && record['reason'] === 'wait_timeout')).toBe(true);
    hasher.releaseAll();
    expect((await held.running).status).toBe(401);
  });

  it('recovers: after a refusal for want of room the next unknown address is served, and the decoy was not lost with it', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { ...tight, passwordHashWaitMs: 5_000, passwordHashQueue: 0 } });
    await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.99');
    hasher.held = true;
    const first = system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.1').then((answer) => answer);
    await settle();
    const refused = await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.2');
    expect(refused.status).toBe(503);
    hasher.releaseAll();
    expect((await first).status).toBe(401);
    expect((await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.3')).status).toBe(401);
  });

  it('does not let the first unknown address after a refused decoy fail for ever', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { ...tight, passwordHashQueue: 0, passwordHashWaitMs: 5_000 } });
    const blocker = hasher.hash('holding the only slot');
    hasher.held = true;
    const held = hasher.hash('x');
    await settle();
    hasher.releaseAll();
    await Promise.all([blocker, held]);
    const answers = [];
    for (let request = 0; request < 3; request += 1) answers.push((await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, `203.0.113.${request}`)).status);
    expect(answers).toEqual([401, 401, 401]);
  });
});

describe('a burst, with real parameters (M8-10)', () => {
  it('refuses what a source may not ask, spends nothing on it, and never runs more derives together than the bound allows', async () => {
    const hasher = new Instrumented(CURRENT_PASSWORD_PARAMETERS);
    const system = await compose({ hasher, config: { rateLimitLogin: { source: DEFAULT_ABUSE_LIMITS.rateLimitLogin.source, subject: DEFAULT_ABUSE_LIMITS.rateLimitLogin.subject } } });
    await system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.200');
    const derivesBefore = hasher.derives;
    const baseline = process.memoryUsage().rss;
    let peakRss = baseline;
    const sampler = setInterval(() => void (peakRss = Math.max(peakRss, process.memoryUsage().rss)), 5);
    const answers = await Promise.all(Array.from({ length: 400 }, () => system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.201')));
    clearInterval(sampler);
    const byStatus = (status: number) => answers.filter((answer) => answer.status === status).length;
    const growthMiB = Math.round((peakRss - baseline) / MIB);
    console.info(`abuse burst: 400 requests, ${byStatus(401)} served, ${byStatus(429)} limited, ${byStatus(503)} busy; peak derives together ${hasher.peak}; resident set grew ${growthMiB} MiB at most`);

    // admitted up to the source's burst, the rest refused with no derive spent on them
    expect(byStatus(401) + byStatus(429) + byStatus(503)).toBe(400);
    expect(byStatus(401)).toBe(100);
    expect(byStatus(429)).toBe(300);
    expect(hasher.derives - derivesBefore).toBe(100);
    expect(hasher.peak).toBeLessThanOrEqual(DEFAULT_ABUSE_LIMITS.passwordHashConcurrency);
    // two derives of 64 MiB each, with room for the allocator, the collector and the 400 requests themselves
    expect(growthMiB).toBeLessThan(DEFAULT_ABUSE_LIMITS.passwordHashConcurrency * 64 + 160);
  }, 120_000);

  it('is not a counter that cannot see: with the bound raised, more derives than the default do run together', async () => {
    const hasher = new Instrumented(CURRENT_PASSWORD_PARAMETERS);
    const system = await compose({ hasher, config: { passwordHashConcurrency: 16, rateLimitLogin: policy(WIDE) } });
    await Promise.all(Array.from({ length: 24 }, () => system.post('/login', { email: unknownAddress(), password: 'wrong wrong wrong' }, '203.0.113.210')));
    expect(hasher.peak).toBeGreaterThan(DEFAULT_ABUSE_LIMITS.passwordHashConcurrency);
  }, 120_000);

  it('serves a school: a hundred students with their own accounts, logging in at once from one address, are all let in, none limited and none turned away', async () => {
    const hasher = new Instrumented(CURRENT_PASSWORD_PARAMETERS);
    const credential = await hasher.hash(PASSWORD);
    const students = await Promise.all(Array.from({ length: 100 }, () => person(hasher, undefined, credential)));
    const system = await compose({ hasher });
    const started = Date.now();
    const answers = await Promise.all(students.map((student) => system.post('/login', { email: student.email, password: PASSWORD }, '203.0.113.220')));
    const elapsedMs = Date.now() - started;
    const statuses = answers.map((answer) => answer.status);
    console.info(`school burst: 100 logins at once from one address, ${statuses.filter((status) => status === 200).length} served in ${elapsedMs} ms; peak derives together ${hasher.peak}`);
    expect(statuses.filter((status) => status !== 200)).toEqual([]);
    expect(elapsedMs).toBeLessThan(DEFAULT_ABUSE_LIMITS.passwordHashWaitMs + 5_000);
    expect(hasher.peak).toBeLessThanOrEqual(DEFAULT_ABUSE_LIMITS.passwordHashConcurrency);
  }, 120_000);
});

describe('a password that is known to be bad (M8-11)', () => {
  const BREACHED = 'password1234';

  it('is refused for a known address and an unknown one alike, and costs neither a derive nor a lookup of the address', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitRegister: policy(WIDE) } });
    const known = await person(hasher);
    const attempt = (email: string) => system.post('/register', { email, password: BREACHED });
    const derivesBefore = hasher.derives;
    const readsBefore = system.reads();
    const hitsBefore = system.hits.length;
    const asKnown = await attempt(known.email);
    const asUnknown = await attempt(unknownAddress());
    expect([asKnown.status, asUnknown.status]).toEqual([400, 400]);
    expect(stripped(asKnown.body as Record<string, unknown>)).toEqual(stripped(asUnknown.body as Record<string, unknown>));
    expect(asKnown.body).toMatchObject({ reason: 'PASSWORD_BREACHED' });
    // the counting test, as for the limiter: the same two counters for each, and nothing else done
    expect(system.hits.length - hitsBefore).toBe(4);
    expect(hasher.derives - derivesBefore).toBe(0);
    expect(system.reads() - readsBefore).toBe(0);
    expect(system.mail.sent).toEqual([]);
  });

  it('is refused at a reset, before the code is looked up and before a derive, and the same whether or not the code is good', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitReset: policy('source=1000000/10s') } });
    const derivesBefore = hasher.derives;
    const readsBefore = system.reads();
    const answers = await Promise.all(['a code', 'another code', ''].map((token) => system.post('/password/reset', { token, newPassword: BREACHED })));
    expect(answers.map((answer) => answer.status)).toEqual([400, 400, 400]);
    expect(new Set(answers.map((answer) => JSON.stringify(stripped(answer.body as Record<string, unknown>)))).size).toBe(1);
    expect(hasher.derives - derivesBefore).toBe(0);
    expect(system.reads() - readsBefore).toBe(0);
  });

  it('is refused at a change of password before the current one is checked, with no derive', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitPasswordChange: policy('source=1000000/1m;subject=1000000/1m') } });
    const who = await person(hasher);
    const login = await system.post('/login', { email: who.email, password: PASSWORD });
    expect(login.status).toBe(200);
    const derivesBefore = hasher.derives;
    const refused = await system.post('/password/change', { currentPassword: 'not the current one', newPassword: BREACHED }, '198.51.100.1', login.body.sessionToken);
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ reason: 'PASSWORD_BREACHED' });
    expect(hasher.derives - derivesBefore).toBe(0);
  });

  it('is a burst that costs nothing: four hundred registrations from one source with a bad password are refused or limited, none derives, none is mailed', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher });
    const answers = await Promise.all(Array.from({ length: 400 }, () => system.post('/register', { email: unknownAddress(), password: BREACHED }, '203.0.113.230')));
    const counts = new Map<number, number>();
    for (const answer of answers) counts.set(answer.status, (counts.get(answer.status) ?? 0) + 1);
    expect([...counts.keys()].sort()).toEqual([400, 429]);
    expect(counts.get(400)).toBe(DEFAULT_ABUSE_LIMITS.rateLimitRegister.source.tiers[0]!.max);
    expect(hasher.derives).toBe(0);
    expect(system.mail.sent).toEqual([]);
  });

  it('does not refuse what it should not: students registering with passwords of their own are all accepted beside the same burst', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitRegister: policy(WIDE) } });
    const answers = await Promise.all([
      ...Array.from({ length: 20 }, () => system.post('/register', { email: unknownAddress(), password: BREACHED }, '203.0.113.231')),
      ...Array.from({ length: 20 }, (_, index) => system.post('/register', { email: unknownAddress(), password: `student ${index} picks a long passphrase`, }, `203.0.113.${240 + (index % 10)}`)),
    ]);
    expect(answers.slice(0, 20).map((answer) => answer.status)).toEqual(Array(20).fill(400));
    expect(answers.slice(20).map((answer) => answer.status)).toEqual(Array(20).fill(202));
  });

  const source = (answer: BreachVerdict | 'throw'): BreachedPasswords => ({ lookup: () => (answer === 'throw' ? Promise.reject(new Error('connect ETIMEDOUT 203.0.113.9:443')) : Promise.resolve(answer)) });

  it.each([
    ['says it cannot answer', 'unavailable', 'source_unavailable'],
    ['fails', 'throw', 'source_error'],
  ] as const)('accepts the password and says so in one record when the source %s: the defence lapses loudly, and registration keeps working', async (_name, answer, reason) => {
    const hasher = new Instrumented(CHEAP);
    const address = unknownAddress();
    const system = await compose({ hasher, config: { rateLimitRegister: policy(WIDE) } , breached: source(answer) });
    const accepted = await system.post('/register', { email: address, password: BREACHED });
    expect(accepted.status).toBe(202);
    const lapses = system.records().filter((record) => record['errorCode'] === 'BREACH_CHECK_UNAVAILABLE');
    expect(lapses).toHaveLength(1);
    expect(lapses[0]).toMatchObject({ level: 'warn', message: 'password not checked against known passwords', context: 'identity.password', reason, route: 'register', correlationId: accepted.headers['x-correlation-id'] });
    expect(system.lines.join('\n')).not.toMatch(new RegExp(`${address}|${BREACHED}|203\\.0\\.113\\.9|ETIMEDOUT`, 'u'));
    expect((await database.pool.query('SELECT count(*)::int AS n FROM identity.app_user WHERE email_normalized = $1', [address])).rows[0].n).toBe(1);
  });
});

async function clearPeople(): Promise<void> {
  for (const table of ['session', 'one_time_token', 'credential', 'app_user']) await database.pool.query(`DELETE FROM identity.${table}`);
}

describe('a password that cannot be checked, at change and at reset (M8-11)', () => {
  const lapsed: BreachedPasswords = { lookup: () => Promise.resolve('unavailable') };

  it('is accepted at a change of password, and the record names the route', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, breached: lapsed, config: { rateLimitPasswordChange: policy('source=1000000/1m;subject=1000000/1m'), rateLimitLogin: policy(WIDE) } });
    const who = await person(hasher);
    const login = await system.post('/login', { email: who.email, password: PASSWORD });
    const changed = await system.post('/password/change', { currentPassword: PASSWORD, newPassword: 'password1234' }, '198.51.100.1', login.body.sessionToken);
    expect(changed.status).toBe(200);
    expect(system.records().filter((record) => record['errorCode'] === 'BREACH_CHECK_UNAVAILABLE')).toMatchObject([{ route: 'password-change', reason: 'source_unavailable' }]);
  });

  it('is accepted at a reset, and the record names the route', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, breached: lapsed, config: { rateLimitRecovery: policy(WIDE), rateLimitReset: policy('source=1000000/10s') } });
    const who = await person(hasher);
    await system.post('/password/recovery', { email: who.email });
    const code = /code is (\S+)\./u.exec(system.mail.sent.at(-1)!.body)![1]!;
    const reset = await system.post('/password/reset', { token: code, newPassword: 'password1234' });
    expect(reset.status).toBe(200);
    expect(system.records().filter((record) => record['errorCode'] === 'BREACH_CHECK_UNAVAILABLE')).toMatchObject([{ route: 'reset', reason: 'source_unavailable' }]);
  });
});

describe('roles under abuse (M8-12)', () => {
  async function signedIn(system: Awaited<ReturnType<typeof compose>>, hasher: PasswordHasher, roles: string[]) {
    const who = await person(hasher);
    await database.pool.query('UPDATE identity.app_user SET roles = $2 WHERE user_id = $1', [who.userId, roles]);
    const login = await system.post('/login', { email: who.email, password: PASSWORD });
    expect(login.status).toBe(200);
    return { ...who, token: login.body.sessionToken as string };
  }
  const rolesOf = async (userId: string): Promise<string[]> => (await database.pool.query('SELECT roles FROM identity.app_user WHERE user_id = $1', [userId])).rows[0].roles;
  const admins = async (): Promise<number> => (await database.pool.query(`SELECT count(*)::int AS n FROM identity.app_user WHERE 'admin' = ANY(roles)`)).rows[0].n;

  beforeEach(clearPeople);

  it('refuses a learner who asks again and again to be made an administrator, every time, and changes nothing', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy(WIDE) } });
    const learner = await signedIn(system, hasher, ['learner']);
    const answers = await Promise.all(Array.from({ length: 60 }, () => system.post('/roles/assign', { email: learner.email, role: 'admin' }, '203.0.113.60', learner.token)));
    expect(new Set(answers.map((answer) => answer.status))).toEqual(new Set([403]));
    expect(await rolesOf(learner.userId)).toEqual(['learner']);
    expect((await database.pool.query(`SELECT count(*)::int AS n FROM platform.audit_record WHERE action = 'RoleAssigned' AND target_id = $1`, [`${learner.userId}:admin`])).rows[0].n).toBe(0);
  });

  it('leaves one administrator when two remove each other at once, and tells the second why', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy(WIDE) } });
    for (let round = 0; round < 6; round += 1) {
      await clearPeople();
      const [a, b] = [await signedIn(system, hasher, ['learner', 'admin']), await signedIn(system, hasher, ['learner', 'admin'])];
      const answers = await Promise.all([system.post('/roles/remove', { email: b.email, role: 'admin' }, '203.0.113.61', a.token), system.post('/roles/remove', { email: a.email, role: 'admin' }, '203.0.113.62', b.token)]);
      expect(answers.map((answer) => answer.status).sort(), `round ${round}`).toEqual([200, 422]);
      expect(await admins(), `round ${round}`).toBe(1);
    }
  });

  it('stops an administrator the moment the role is taken away: every request after it, on the session they already held, is refused', async () => {
    const hasher = new Instrumented(CHEAP);
    const system = await compose({ hasher, config: { rateLimitLogin: policy(WIDE) } });
    const [keeper, revoked] = [await signedIn(system, hasher, ['learner', 'admin']), await signedIn(system, hasher, ['learner', 'admin'])];
    expect((await system.post('/roles/assign', { email: keeper.email, role: 'ops' }, '203.0.113.63', revoked.token)).status).toBe(200);
    expect((await system.post('/roles/remove', { email: revoked.email, role: 'admin' }, '203.0.113.64', keeper.token)).status).toBe(200);
    const after = await Promise.all(Array.from({ length: 20 }, () => system.post('/roles/remove', { email: keeper.email, role: 'ops' }, '203.0.113.63', revoked.token)));
    expect(new Set(after.map((answer) => answer.status))).toEqual(new Set([403]));
    expect(await rolesOf(keeper.userId)).toEqual(['learner', 'admin', 'ops']);
  });
});
