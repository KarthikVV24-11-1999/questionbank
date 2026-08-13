import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { issue, verify, type TokenClaims } from './token.js';

const CONFIG = { signingKey: 'a'.repeat(32), issuer: 'questionbank' };
const OTHER_CONFIG = { signingKey: 'b'.repeat(32), issuer: 'questionbank' };

function baseClaims(overrides: Partial<TokenClaims> = {}): TokenClaims {
  const now = 1_000_000;
  return {
    sub: 'user-1',
    kind: 'human',
    roles: ['author'],
    iat: now,
    exp: now + 3600,
    iss: 'questionbank',
    jti: 'jti-1',
    ...overrides,
  };
}

describe('issue/verify — round trip', () => {
  it('a token issued now verifies now', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const result = verify(token, CONFIG, { now: claims.iat });
    expect(result).toEqual({ ok: true, value: { kind: 'human', id: 'user-1', roleContext: ['author'] } });
  });

  it('the verified result is exactly a PrincipalRef — kind, id, roleContext, nothing else', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const result = verify(token, CONFIG, { now: claims.iat });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.keys(result.value).sort()).toEqual(['id', 'kind', 'roleContext']);
    }
  });

  it('ai_agent verifies normally (D10 — machines act, and provenance records it)', () => {
    const claims = baseClaims({ kind: 'ai_agent', sub: 'agent-1', roles: ['content_generator'] });
    const token = issue(claims, CONFIG);
    const result = verify(token, CONFIG, { now: claims.iat });
    expect(result).toEqual({ ok: true, value: { kind: 'ai_agent', id: 'agent-1', roleContext: ['content_generator'] } });
  });

  it('system verifies normally', () => {
    const claims = baseClaims({ kind: 'system', sub: 'system-1', roles: [] });
    const token = issue(claims, CONFIG);
    const result = verify(token, CONFIG, { now: claims.iat });
    expect(result.ok).toBe(true);
  });
});

describe('verify — malformed token shape', () => {
  it('refuses a token with too few segments', () => {
    expect(verify('a.b', CONFIG)).toEqual({
      ok: false,
      error: { code: 'MALFORMED_TOKEN', message: 'a token must have exactly three segments' },
    });
  });

  it('refuses a token with too many segments', () => {
    expect(verify('a.b.c.d', CONFIG)).toEqual({
      ok: false,
      error: { code: 'MALFORMED_TOKEN', message: 'a token must have exactly three segments' },
    });
  });

  it('refuses an empty signature segment rather than treating it as absent', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const [header, payload] = token.split('.');
    expect(verify(`${header}.${payload}.`, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'MALFORMED_TOKEN', message: 'no token segment may be empty' },
    });
  });

  it('refuses an empty header segment', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const [, payload, signature] = token.split('.');
    expect(verify(`.${payload}.${signature}`, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'MALFORMED_TOKEN', message: 'no token segment may be empty' },
    });
  });

  it('refuses an empty payload segment', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const [header, , signature] = token.split('.');
    expect(verify(`${header}..${signature}`, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'MALFORMED_TOKEN', message: 'no token segment may be empty' },
    });
  });

});

describe('verify — signature integrity', () => {
  it('refuses a tampered payload (signature computed over a different payload)', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const [header, , signature] = token.split('.');
    const tamperedPayload = Buffer.from(JSON.stringify({ ...baseClaims(), sub: 'attacker' }), 'utf8').toString(
      'base64url',
    );
    const result = verify(`${header}.${tamperedPayload}.${signature}`, CONFIG, { now: claims.iat });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'the signature does not match' } });
  });

  it('refuses a tampered signature', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const [header, payload, signature] = token.split('.');
    const tampered = (signature as string).slice(0, -1) + (signature?.at(-1) === 'A' ? 'B' : 'A');
    const result = verify(`${header}.${payload}.${tampered}`, CONFIG, { now: claims.iat });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'the signature does not match' } });
  });

  it('refuses a token signed with a different key', () => {
    const claims = baseClaims();
    const token = issue(claims, OTHER_CONFIG);
    const result = verify(token, CONFIG, { now: claims.iat });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('INVALID_SIGNATURE');
  });

  it('compares signatures of mismatched length without throwing', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const [header, payload] = token.split('.');
    // A signature segment shorter than the real one — different byte length
    // after base64url decoding, which is exactly the case that would throw
    // inside node:crypto.timingSafeEqual if the length were not checked first.
    expect(() => verify(`${header}.${payload}.AA`, CONFIG, { now: claims.iat })).not.toThrow();
    const result = verify(`${header}.${payload}.AA`, CONFIG, { now: claims.iat });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_SIGNATURE', message: 'the signature does not match' } });
  });

  it('there is no alg-free shortcut — a header claiming "none" still requires a valid signature', () => {
    const claims = baseClaims();
    const forgedHeader = Buffer.from(JSON.stringify({ typ: 'qb-token', alg: 'none' }), 'utf8').toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        sub: claims.sub,
        kind: claims.kind,
        roles: claims.roles,
        iat: claims.iat,
        exp: claims.exp,
        iss: claims.iss,
        jti: claims.jti,
      }),
      'utf8',
    ).toString('base64url');
    // No signature segment content can make this pass, because verify()
    // never reads the header to decide how to check the signature — it
    // always recomputes HMAC-SHA256 over header.payload with the real key.
    const result = verify(`${forgedHeader}.${payload}.`, CONFIG, { now: claims.iat });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('MALFORMED_TOKEN');

    const resultWithFakeSig = verify(`${forgedHeader}.${payload}.AAAA`, CONFIG, { now: claims.iat });
    expect(resultWithFakeSig).toEqual({
      ok: false,
      error: { code: 'INVALID_SIGNATURE', message: 'the signature does not match' },
    });
  });
});

describe('verify — claim validation', () => {
  const HEADER = Buffer.from('{"typ":"qb-token","alg":"HS256"}', 'utf8').toString('base64url');

  // Re-derives the same HMAC issue() computes, so these tests can present an
  // otherwise-validly-signed token over a deliberately malformed payload —
  // exercising claim validation specifically, not signature mismatch.
  function signAlike(header: string, payload: string): string {
    return createHmac('sha256', CONFIG.signingKey).update(`${header}.${payload}`).digest().toString('base64url');
  }

  function tokenWithRawPayload(payload: unknown): string {
    const payloadSegment = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
    return `${HEADER}.${payloadSegment}.${signAlike(HEADER, payloadSegment)}`;
  }

  it('refuses a payload segment that decodes to invalid JSON', () => {
    const payloadSegment = Buffer.from('not json', 'utf8').toString('base64url');
    const token = `${HEADER}.${payloadSegment}.${signAlike(HEADER, payloadSegment)}`;
    expect(verify(token, CONFIG, { now: 0 })).toEqual({
      ok: false,
      error: { code: 'MALFORMED_TOKEN', message: 'the token payload is not valid JSON' },
    });
  });

  it('refuses an unknown principal kind, never coercing it', () => {
    const claims = baseClaims();
    const token = tokenWithRawPayload({
      sub: claims.sub,
      kind: 'moderator',
      roles: claims.roles,
      iat: claims.iat,
      exp: claims.exp,
      iss: claims.iss,
      jti: claims.jti,
    });
    const result = verify(token, CONFIG, { now: claims.iat });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe('UNKNOWN_PRINCIPAL_KIND');
  });

  it('refuses roles that is not an array of strings', () => {
    const claims = baseClaims();
    const token = tokenWithRawPayload({
      sub: claims.sub,
      kind: claims.kind,
      roles: [1, 2, 3],
      iat: claims.iat,
      exp: claims.exp,
      iss: claims.iss,
      jti: claims.jti,
    });
    const result = verify(token, CONFIG, { now: claims.iat });
    expect(result).toEqual({ ok: false, error: { code: 'INVALID_CLAIMS', message: 'roles must be an array of strings' } });
  });

  it('refuses a missing sub', () => {
    const claims = baseClaims();
    const token = tokenWithRawPayload({ kind: claims.kind, roles: claims.roles, iat: claims.iat, exp: claims.exp, iss: claims.iss, jti: claims.jti });
    expect(verify(token, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'INVALID_CLAIMS', message: 'sub is required' },
    });
  });

  it('refuses a missing iss', () => {
    const claims = baseClaims();
    const token = tokenWithRawPayload({ sub: claims.sub, kind: claims.kind, roles: claims.roles, iat: claims.iat, exp: claims.exp, jti: claims.jti });
    expect(verify(token, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'INVALID_CLAIMS', message: 'iss is required' },
    });
  });

  it('refuses a missing jti', () => {
    const claims = baseClaims();
    const token = tokenWithRawPayload({ sub: claims.sub, kind: claims.kind, roles: claims.roles, iat: claims.iat, exp: claims.exp, iss: claims.iss });
    expect(verify(token, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'INVALID_CLAIMS', message: 'jti is required' },
    });
  });

  it('refuses non-numeric iat/exp', () => {
    const claims = baseClaims();
    const token = tokenWithRawPayload({ sub: claims.sub, kind: claims.kind, roles: claims.roles, iat: 'nope', exp: claims.exp, iss: claims.iss, jti: claims.jti });
    expect(verify(token, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'INVALID_CLAIMS', message: 'iat and exp must be numbers' },
    });
  });

  it('refuses a payload that is not an object', () => {
    const token = tokenWithRawPayload('not-an-object');
    const result = verify(token, CONFIG, { now: 0 });
    expect(result).toEqual({
      ok: false,
      error: { code: 'INVALID_CLAIMS', message: 'the token payload is not a claims object' },
    });
  });
});

describe('verify — issuer and expiry', () => {
  it('refuses an issuer mismatch', () => {
    const claims = baseClaims({ iss: 'someone-else' });
    const token = issue(claims, CONFIG);
    expect(verify(token, CONFIG, { now: claims.iat })).toEqual({
      ok: false,
      error: { code: 'ISSUER_MISMATCH', message: 'the token was issued by a different issuer' },
    });
  });

  it('refuses an expired token', () => {
    const claims = baseClaims({ exp: 1_000_100 });
    const token = issue(claims, CONFIG);
    expect(verify(token, CONFIG, { now: 1_000_100 })).toEqual({
      ok: false,
      error: { code: 'EXPIRED', message: 'the token has expired' },
    });
  });

  it('accepts a token one second before expiry', () => {
    const claims = baseClaims({ exp: 1_000_100 });
    const token = issue(claims, CONFIG);
    expect(verify(token, CONFIG, { now: 1_000_099 }).ok).toBe(true);
  });

  it('uses the real clock when no now option is supplied', () => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    const claims = baseClaims({ iat: nowSeconds, exp: nowSeconds + 3600 });
    const token = issue(claims, CONFIG);
    expect(verify(token, CONFIG).ok).toBe(true);

    const expiredClaims = baseClaims({ iat: nowSeconds - 7200, exp: nowSeconds - 3600 });
    const expiredToken = issue(expiredClaims, CONFIG);
    const result = verify(expiredToken, CONFIG);
    expect(result).toEqual({ ok: false, error: { code: 'EXPIRED', message: 'the token has expired' } });
  });
});

describe('nothing in this module knows about publication (INV-01)', () => {
  it('the source contains no mention of publish/publication', () => {
    const source = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'token.ts'), 'utf8').toLowerCase();
    expect(source).not.toContain('publish');
  });
});
