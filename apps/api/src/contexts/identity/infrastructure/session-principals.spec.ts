import { describe, expect, it } from 'vitest';
import type { Authentication, SessionAuthenticator } from '../application/session-authenticator.js';
import { PostgresPrincipalResolver, SessionResolutions, sessionAuthentication, type AuthLogger } from './session-principals.js';

const PRINCIPAL = { kind: 'human' as const, id: '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a', roleContext: ['learner'] };
const logs = () => {
  const entries: Array<{ message: string; context: string; errorCode: string }> = [];
  const logger: AuthLogger = { log: (entry) => void entries.push({ message: entry.message, context: entry.context, errorCode: entry.attributes.errorCode }) };
  return { entries, logger };
};
const authenticator = (answer: Authentication | Error) => ({ authenticate: async (header: string | undefined) => (answer instanceof Error ? Promise.reject(answer) : (seen.push(header), answer)) }) as unknown as SessionAuthenticator;
const seen: Array<string | undefined> = [];

describe('the principal resolver over recorded sessions', () => {
  it('hands back the principal recorded for the very headers it is given', () => {
    const resolutions = new SessionResolutions();
    const headers = { authorization: 'Bearer x' };
    resolutions.record(headers, { ok: true, principal: PRINCIPAL });
    expect(new PostgresPrincipalResolver(resolutions).resolve(headers)).toEqual(PRINCIPAL);
  });

  it('returns null for every refusal and logs one record with the code, and never a token', () => {
    const { entries, logger } = logs();
    const resolutions = new SessionResolutions();
    const headers = { authorization: 'Bearer a-token-that-must-not-be-logged' };
    resolutions.record(headers, { ok: false, code: 'SESSION_REVOKED' });
    expect(new PostgresPrincipalResolver(resolutions, logger).resolve(headers)).toBeNull();
    expect(entries).toEqual([{ message: 'authentication refused', context: 'identity.auth', errorCode: 'SESSION_REVOKED' }]);
    expect(JSON.stringify(entries)).not.toContain('a-token-that-must-not-be-logged');
  });

  it('refuses headers no request went through: a copy of a request\'s headers, and a hand-made object', () => {
    const { entries, logger } = logs();
    const resolutions = new SessionResolutions();
    const headers = { authorization: 'Bearer x' };
    resolutions.record(headers, { ok: true, principal: PRINCIPAL });
    const resolver = new PostgresPrincipalResolver(resolutions, logger);
    expect(resolver.resolve({ ...headers })).toBeNull();
    expect(resolver.resolve({ authorization: 'Bearer x' })).toBeNull();
    expect(entries.map((entry) => entry.errorCode)).toEqual(['NOT_RESOLVED', 'NOT_RESOLVED']);
  });

  it('works without a logger', () => {
    expect(new PostgresPrincipalResolver(new SessionResolutions()).resolve({})).toBeNull();
  });
});

describe('the middleware that fills it', () => {
  it('authenticates the request\'s bearer header and records the answer for its headers, then carries on', async () => {
    seen.length = 0;
    const resolutions = new SessionResolutions();
    const request = { headers: { authorization: 'Bearer abc' } as Record<string, string | string[] | undefined> };
    await new Promise<void>((next) => sessionAuthentication(authenticator({ ok: true, principal: PRINCIPAL }), resolutions)(request, undefined, () => next()));
    expect(seen).toEqual(['Bearer abc']);
    expect(new PostgresPrincipalResolver(resolutions).resolve(request.headers)).toEqual(PRINCIPAL);
  });

  it('passes no header as no header, and a header that is not one string as none', async () => {
    seen.length = 0;
    for (const headers of [{}, { authorization: ['Bearer a', 'Bearer b'] }]) {
      await new Promise<void>((next) => sessionAuthentication(authenticator({ ok: false, code: 'MISSING_HEADER' }), new SessionResolutions())({ headers }, undefined, () => next()));
    }
    expect(seen).toEqual([undefined, undefined]);
  });

  it('fails closed when the lookup itself fails: the request goes on, unauthenticated, with the reason recorded', async () => {
    const { entries, logger } = logs();
    const resolutions = new SessionResolutions();
    const request = { headers: { authorization: 'Bearer abc' } as Record<string, string | string[] | undefined> };
    await new Promise<void>((next) => sessionAuthentication(authenticator(new Error('connection refused')), resolutions)(request, undefined, () => next()));
    expect(new PostgresPrincipalResolver(resolutions, logger).resolve(request.headers)).toBeNull();
    expect(entries.map((entry) => entry.errorCode)).toEqual(['LOOKUP_UNAVAILABLE']);
  });
});
