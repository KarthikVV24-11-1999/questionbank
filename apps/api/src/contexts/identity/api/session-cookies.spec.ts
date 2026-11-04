import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { CSRF_COOKIE, SESSION_COOKIE, clearSessionCookies, cookiesOf, csrfTokenFor, sessionCookies, setSessionCookies, type CookieRequest } from './session-cookies.js';

const TOKEN = 'a-session-token-0123456789';
const APP = 'https://learn.example.org';

function request(over: Partial<CookieRequest> & { readonly headers?: Record<string, string> } = {}): CookieRequest {
  return { method: 'POST', path: '/v1/learning/profile', protocol: 'https', ...over, headers: { cookie: `${SESSION_COOKIE}=${TOKEN}; ${CSRF_COOKIE}=${csrfTokenFor(TOKEN)}`, host: 'learn.example.org', ...over.headers } };
}
function respond() {
  const out: { status?: number; body?: Record<string, unknown>; headers: Record<string, string>; cookies: { name: string; value?: string; options: Record<string, unknown> }[]; cleared: { name: string; options: Record<string, unknown> }[] } = { headers: {}, cookies: [], cleared: [] };
  const response = {
    status(code: number) { out.status = code; return response; },
    type() { return response; },
    setHeader(name: string, value: string) { out.headers[name] = value; return response; },
    json(body: Record<string, unknown>) { out.body = body; return response; },
    cookie(name: string, value: string, options: Record<string, unknown>) { out.cookies.push({ name, value, options }); return response; },
    clearCookie(name: string, options: Record<string, unknown>) { out.cleared.push({ name, options }); return response; },
  } as unknown as Response;
  return { out, response };
}
function pass(req: CookieRequest, allowedOrigin: string | null = APP) {
  const { out, response } = respond();
  let nexted = false;
  sessionCookies(allowedOrigin === null ? {} : { allowedOrigin })(req, response, () => void (nexted = true));
  return { nexted, out, req };
}
const echoed = { 'x-csrf-token': csrfTokenFor(TOKEN) };

describe('reading cookies', () => {
  it('reads each name once, decoded, and ignores what is not a pair or does not decode', () => {
    expect(cookiesOf('a=1; b=two%20words; =x; novalue; c=%E0%A4%A')).toEqual({ a: '1', b: 'two words' });
    expect(cookiesOf('a=first; a=second')).toEqual({ a: 'first' });
    expect(cookiesOf(undefined)).toEqual({});
  });
});

describe('the cookies a login sets', () => {
  it('the session is HttpOnly, Secure, SameSite=Lax and lasts as long as the session; the second is readable and says nothing about the first but a hash', () => {
    const { out, response } = respond();
    setSessionCookies(response, TOKEN, '2026-11-11T09:00:00.000Z');
    expect(out.cookies).toEqual([
      { name: 'qb_session', value: TOKEN, options: { secure: true, sameSite: 'lax', path: '/', expires: new Date('2026-11-11T09:00:00.000Z'), httpOnly: true } },
      { name: 'qb_csrf', value: csrfTokenFor(TOKEN), options: { secure: true, sameSite: 'lax', path: '/', expires: new Date('2026-11-11T09:00:00.000Z'), httpOnly: false } },
    ]);
    expect(csrfTokenFor(TOKEN)).not.toContain(TOKEN);
    expect(csrfTokenFor(TOKEN)).not.toBe(csrfTokenFor(`${TOKEN}x`));
  });

  it('are both cleared by the same attributes they were set with', () => {
    const { out, response } = respond();
    clearSessionCookies(response);
    expect(out.cleared).toEqual([
      { name: 'qb_session', options: { secure: true, sameSite: 'lax', path: '/', httpOnly: true } },
      { name: 'qb_csrf', options: { secure: true, sameSite: 'lax', path: '/', httpOnly: false } },
    ]);
  });
});

describe('a request that carries the cookie', () => {
  it('is given the bearer header the rest of the application reads', () => {
    const seen = pass(request({ method: 'GET' }));
    expect(seen.nexted).toBe(true);
    expect(seen.req.headers['authorization']).toBe(`Bearer ${TOKEN}`);
  });

  it('is let through when it is an unsafe request from this app that echoes the second cookie', () => {
    const seen = pass(request({ headers: { origin: APP, ...echoed } }));
    expect([seen.nexted, seen.out.status]).toEqual([true, undefined]);
  });

  it('is let through with no Origin header at all, when the second cookie is echoed', () => {
    expect(pass(request({ headers: echoed })).nexted).toBe(true);
  });

  it('is refused, with the cookie present, when an unsafe request names another origin, even with the second cookie echoed', () => {
    const seen = pass(request({ headers: { origin: 'https://evil.example', ...echoed } }));
    expect([seen.nexted, seen.out.status, seen.out.body?.['reason']]).toEqual([false, 403, 'CSRF_REFUSED']);
  });

  it('is refused when its origin is the opaque one a sandboxed page sends', () => {
    expect(pass(request({ headers: { origin: 'null', ...echoed } })).out.status).toBe(403);
  });

  it('is refused when an unsafe request does not echo the second cookie, or echoes another session\'s', () => {
    expect(pass(request({ headers: { origin: APP } })).out.status).toBe(403);
    expect(pass(request({ headers: { origin: APP, 'x-csrf-token': csrfTokenFor('another-session-token') } })).out.status).toBe(403);
    expect(pass(request({ headers: { origin: APP, 'x-csrf-token': TOKEN } })).out.status).toBe(403);
  });

  it('is not made to echo anything for a read, whatever its origin', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) expect(pass(request({ method, headers: { origin: 'https://evil.example' } })).nexted, method).toBe(true);
  });

  it('is refused for every unsafe method', () => {
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) expect(pass(request({ method, headers: { origin: 'https://evil.example' } })).out.status, method).toBe(403);
  });

  it('holds the routes that act as nobody to the origin and not to the echo, so a stale cookie cannot lock a person out of signing in', () => {
    for (const path of ['/v1/identity/login', '/v1/identity/register', '/v1/identity/password/recovery', '/v1/identity/password/reset', '/v1/identity/email/verify']) {
      expect(pass(request({ path, headers: { origin: APP } })).nexted, path).toBe(true);
      expect(pass(request({ path, headers: { origin: 'https://evil.example' } })).out.status, path).toBe(403);
    }
    expect(pass(request({ path: '/v1/identity/logout', headers: { origin: APP } })).out.status).toBe(403);
  });

  it('uses its own origin when the deployment named none, which is the request\'s scheme and host', () => {
    expect(pass(request({ headers: { origin: 'https://learn.example.org', ...echoed } }), null).nexted).toBe(true);
    expect(pass(request({ headers: { origin: 'https://evil.example', ...echoed } }), null).out.status).toBe(403);
    expect(pass(request({ protocol: 'http', headers: { origin: 'https://learn.example.org', ...echoed } }), null).out.status).toBe(403);
  });

  it('says why in the shape every refusal has, and is not kept by a cache', () => {
    const seen = pass(request({ headers: { origin: 'https://evil.example' } }));
    expect(seen.out.body).toMatchObject({ status: 403, reason: 'CSRF_REFUSED', detail: 'The request came from another site.' });
    expect(seen.out.headers['Cache-Control']).toBe('no-store');
  });
});

describe('a request that does not rely on the cookie', () => {
  it('is left alone when it carries a bearer header, whatever else it carries', () => {
    const seen = pass(request({ headers: { authorization: 'Bearer mine', origin: 'https://evil.example' } }));
    expect([seen.nexted, seen.req.headers['authorization']]).toEqual([true, 'Bearer mine']);
  });

  it('is left alone when it carries no session cookie', () => {
    const seen = pass(request({ headers: { cookie: `${CSRF_COOKIE}=x`, origin: 'https://evil.example' } }));
    expect([seen.nexted, seen.req.headers['authorization']]).toEqual([true, undefined]);
  });
});
