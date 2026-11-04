import { createHash, timingSafeEqual } from 'node:crypto';
import type { Response } from 'express';
import { toProblemDetails } from './problem-details.js';

/**
 * The session in a cookie (M8-42, D69, ADR-0065). A browser holds the session where a script cannot read it: `qb_session` is `HttpOnly`, `Secure` and `SameSite=Lax`, so a
 * page's own code (and anything injected into it) cannot take the token, and a request from another site does not carry it on a POST.
 *
 * **What this guards against, and what it does not.** `SameSite=Lax` already keeps the cookie off a cross-site POST in current browsers. It is not relied on alone: a cookie
 * session is refused on any unsafe request that names another origin, and on any that does not echo the second cookie, `qb_csrf`, in `X-CSRF-Token`. That cookie is readable
 * by the app (it has to be, to be echoed) and is a hash of the session token, so it says nothing a script could use to *be* the session: it is only proof that the caller could
 * read this origin's cookies, which another site cannot. A script already running in the app's own page can still *act* as the person (it can send the header); an `HttpOnly`
 * cookie stops it *taking* the session away, not using it while the page is open.
 *
 * **Bearer clients are unchanged.** A request that carries an `Authorization` header is authenticated by it, and needs neither cookie nor header: nothing a browser sends on
 * its own is an `Authorization` header.
 */
export const SESSION_COOKIE = 'qb_session';
export const CSRF_COOKIE = 'qb_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** The routes that act as nobody, which a stale session cookie must not lock a person out of: they still refuse another origin. */
const ANONYMOUS_PATHS = new Set(['/v1/identity/register', '/v1/identity/login', '/v1/identity/password/recovery', '/v1/identity/password/reset', '/v1/identity/email/verify']);

/** What the second cookie holds for a session: a hash of its token, which cannot be turned back into it. */
export function csrfTokenFor(sessionToken: string): string {
  return createHash('sha256').update(`qb-csrf:${sessionToken}`, 'utf8').digest('base64url');
}

export function cookiesOf(header: string | undefined): Readonly<Record<string, string>> {
  const found: Record<string, string> = {};
  for (const part of (header ?? '').split(';')) {
    const at = part.indexOf('=');
    if (at < 1) continue;
    const name = part.slice(0, at).trim();
    if (name === '' || name in found) continue;
    try {
      found[name] = decodeURIComponent(part.slice(at + 1).trim());
    } catch {
      // a value that does not decode is not one this application set
    }
  }
  return found;
}

export function setSessionCookies(response: Response, sessionToken: string, expiresAt: string): void {
  const common = { secure: true, sameSite: 'lax' as const, path: '/', expires: new Date(expiresAt) };
  response.cookie(SESSION_COOKIE, sessionToken, { ...common, httpOnly: true });
  response.cookie(CSRF_COOKIE, csrfTokenFor(sessionToken), { ...common, httpOnly: false });
}

export function clearSessionCookies(response: Response): void {
  const common = { secure: true, sameSite: 'lax' as const, path: '/' };
  response.clearCookie(SESSION_COOKIE, { ...common, httpOnly: true });
  response.clearCookie(CSRF_COOKIE, { ...common, httpOnly: false });
}

export interface CookieRequest {
  readonly method: string;
  readonly path: string;
  readonly protocol: string;
  readonly headers: Record<string, string | string[] | undefined>;
}

const same = (a: string, b: string): boolean => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/**
 * Installed before the session middleware. A request that carries the session cookie and no `Authorization` header is given one, so everything after this sees a bearer
 * request; an unsafe one is first checked for origin and for the echoed second cookie.
 *
 * `allowedOrigin` is the learner app's origin (`PUBLIC_URL`). Absent, the request's own origin is used, which is right for a development server and weaker behind a proxy
 * that rewrites `Host`; a deployment sets it (docs/DEPLOYMENT.md).
 */
export function sessionCookies(options: { readonly allowedOrigin?: string }) {
  return (request: CookieRequest, response: Response, next: (error?: unknown) => void): void => {
    const token = cookiesOf(headerOf(request, 'cookie'))[SESSION_COOKIE];
    if (token === undefined || headerOf(request, 'authorization') !== undefined) {
      next();
      return;
    }
    request.headers['authorization'] = `Bearer ${token}`;
    if (SAFE_METHODS.has(request.method)) {
      next();
      return;
    }
    const origin = headerOf(request, 'origin');
    const allowed = options.allowedOrigin ?? `${request.protocol}://${headerOf(request, 'host') ?? ''}`;
    if (origin !== undefined && origin !== allowed) return refuse(response, request, 'The request came from another site.');
    if (!ANONYMOUS_PATHS.has(request.path)) {
      const echoed = headerOf(request, CSRF_HEADER);
      if (echoed === undefined || !same(echoed, csrfTokenFor(token))) return refuse(response, request, 'The request did not come from this app.');
    }
    next();
  };
}

function headerOf(request: CookieRequest, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}

function refuse(response: Response, request: CookieRequest, detail: string): void {
  const correlationId = headerOf(request, 'x-correlation-id') ?? 'n/a';
  response.status(403).type('application/problem+json').setHeader('Cache-Control', 'no-store');
  response.json(toProblemDetails({ kind: 'Authorization', code: 'CSRF_REFUSED', message: detail }, correlationId));
}
