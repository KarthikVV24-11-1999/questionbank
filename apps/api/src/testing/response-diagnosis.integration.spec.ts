import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostgresAttemptRepository } from '../contexts/assessment/infrastructure/attempt.repository.js';
import { startAttempt, submitAttempt } from '../contexts/assessment/domain/attempt.js';
import { TAG, anAttempt, id } from './assessment-fixtures.js';
import { storeActiveForm } from './assessment-store.js';
import { connectTestDatabase, type TestDatabase } from './database.js';
import { expectValue } from './expect-result.js';
import { classify, observing, type Observed } from './response-diagnosis.js';

/**
 * The instrument that says which kind of 404 a route gave (M7-20) is itself checked against a real row, because a reading nobody has seen go both ways is
 * a reading nobody should trust.
 */
let database: TestDatabase;
const OWNER = id(TAG.student);

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  await storeActiveForm(database.pool);
  await new PostgresAttemptRepository(database.pool).create(anAttempt());
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const bearerFor = (sub: string) => `Bearer h.${Buffer.from(JSON.stringify({ sub })).toString('base64url')}.s`;
const observed = (over: Partial<Observed> & { attemptId?: string }): Observed => ({
  method: 'post',
  url: `/v1/assessment/attempts/${over.attemptId ?? id(TAG.attempt)}/events`,
  status: 404,
  detail: `no attempt ${over.attemptId ?? id(TAG.attempt)}`,
  text: undefined,
  headers: undefined,
  authorization: bearerFor(OWNER),
  ...over,
});

describe('classifying a 404', () => {
  it('says CONTROLLER_DID_NOT_RUN for a 404 with no correlation id, whatever the url and whether or not the row exists', async () => {
    const bare = { 'content-length': '0', 'content-type': 'text/html' };
    for (const url of ['/v1/assessment/attempts', `/v1/assessment/attempts/${id(TAG.attempt)}/events`, '/v1/assessment/forms/x']) {
      expect(await classify(database.pool, observed({ url, headers: bare, detail: undefined })), url).toMatchObject({ kind: 'CONTROLLER_DID_NOT_RUN' });
    }
  });

  it('does not say it for a 404 the controller wrote: one carrying its correlation id is ABSENT or EXCLUDED', async () => {
    const missing = randomUUID();
    expect(await classify(database.pool, observed({ attemptId: missing, headers: { 'x-correlation-id': 'c' } }))).toMatchObject({ kind: 'ABSENT' });
  });

  it('says ABSENT when there is no row with that id', async () => {
    const missing = randomUUID();
    expect(await classify(database.pool, observed({ attemptId: missing }))).toEqual({ kind: 'ABSENT', attemptId: missing });
  });

  it('says EXCLUDED when the row is there, and whether the caller was its owner', async () => {
    const stranger = await classify(database.pool, observed({ authorization: bearerFor(randomUUID()) }));
    expect(stranger).toMatchObject({ kind: 'EXCLUDED', callerIsOwner: false, state: 'created' });
    const owner = await classify(database.pool, observed({}));
    expect(owner).toMatchObject({ kind: 'EXCLUDED', callerIsOwner: true });
  });

  it('cannot tell the owner from a missing or malformed token, and says the caller was not the owner', async () => {
    for (const authorization of [undefined, 'Bearer nonsense', 'Bearer a.%%%.c']) {
      expect(await classify(database.pool, observed({ authorization })), String(authorization)).toMatchObject({ kind: 'EXCLUDED', callerIsOwner: false });
    }
  });

  it('says nothing of a 404 that is not about an attempt, or a status it was not asked about', async () => {
    expect(await classify(database.pool, observed({ url: '/v1/assessment/forms/x' }))).toBeUndefined();
    expect(await classify(database.pool, observed({ detail: 'no form x' }))).toBeUndefined();
    expect(await classify(database.pool, observed({ status: 200 }))).toBeUndefined();
  });
});

describe('classifying a 412 on a result', () => {
  it('says NOT_SUBMITTED with the state the row held, and nothing when the row is gone', async () => {
    const attempts = new PostgresAttemptRepository(database.pool);
    const started = expectValue(startAttempt(anAttempt(), '2026-10-21T09:00:00.000Z'));
    expectValue(await attempts.save(started, 'created'));
    const url = `/v1/assessment/attempts/${id(TAG.attempt)}/result`;
    expect(await classify(database.pool, observed({ status: 412, url, detail: 'a in_progress attempt has no result' }))).toMatchObject({ kind: 'NOT_SUBMITTED', state: 'in_progress' });
    expectValue(await attempts.save(expectValue(submitAttempt(started, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z')), 'in_progress'));
    expect(await classify(database.pool, observed({ status: 412, url, detail: 'x' }))).toMatchObject({ kind: 'NOT_SUBMITTED', state: 'submitted' });
    expect(await classify(database.pool, observed({ status: 412, url: `/v1/assessment/attempts/${randomUUID()}/result` }))).toBeUndefined();
  });
});

describe('watching a request', () => {
  /** A stand-in for a supertest request: it answers when asked and tells its listener. */
  const agentAnswering = (status: number, detail?: string) => ({
    post: (url: string) => ({
      url,
      on(_event: 'response', listener: (r: unknown) => void) {
        listener({ status, text: detail === undefined ? undefined : JSON.stringify({ detail }), body: {}, req: { getHeader: () => bearerFor(OWNER) } });
        return this;
      },
    }),
    notAVerb: 'untouched',
  });

  it('reads the detail from the text when the body is empty, which is how a problem document arrives', () => {
    expect(() => observing(agentAnswering(404, 'no attempt x'), () => database.pool, 'spec').post('/v1/assessment/attempts/x')).not.toThrow();
    expect(() => observing({ post: (_url: string) => ({ on(_e: 'response', l: (r: unknown) => void) { l({ status: 404, text: '<html>Cannot POST</html>', body: {} }); return this; } }) }, () => database.pool, 'spec').post('/v1/assessment/x')).not.toThrow();
  });

  it('returns the request itself, untouched, and leaves other members of the agent alone', () => {
    const watched = observing(agentAnswering(404, 'no attempt x'), () => database.pool, 'spec');
    expect(watched.notAVerb).toBe('untouched');
    expect(watched.post('/v1/assessment/attempts/x').url).toBe('/v1/assessment/attempts/x');
  });

  it('listens for a 404 and a 412 and ignores every other status, without throwing', () => {
    for (const status of [200, 201, 400, 404, 412, 500]) {
      expect(() => observing(agentAnswering(status, undefined), () => database.pool, 'spec').post('/v1/assessment/attempts/x'), String(status)).not.toThrow();
    }
  });
});
