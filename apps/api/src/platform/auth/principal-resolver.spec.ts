import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { LogEntry, Logger } from '../observability/logger.js';
import { readCode } from '../../fitness/source-scan.js';
import { issue, type TokenClaims } from './token.js';
import { createPrincipalResolver } from './principal-resolver.js';

const CONFIG = { signingKey: 'a'.repeat(32), issuer: 'questionbank' };

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

function recordingLogger(): { logger: Logger; entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return { logger: { log: (entry) => entries.push(entry) }, entries };
}

describe('createPrincipalResolver — a valid Bearer token resolves', () => {
  it('returns the PrincipalRef verify would return', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const resolver = createPrincipalResolver({ config: CONFIG, now: claims.iat });
    const result = resolver.resolve({ authorization: `Bearer ${token}` });
    expect(result).toEqual({ kind: 'human', id: 'user-1', roleContext: ['author'] });
  });

  it('reads the first value when the header arrives as an array', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const resolver = createPrincipalResolver({ config: CONFIG, now: claims.iat });
    const result = resolver.resolve({ authorization: [`Bearer ${token}`] });
    expect(result).toEqual({ kind: 'human', id: 'user-1', roleContext: ['author'] });
  });
});

describe('createPrincipalResolver — every refusal shape yields null', () => {
  it('a missing header', () => {
    const resolver = createPrincipalResolver({ config: CONFIG });
    expect(resolver.resolve({})).toBeNull();
  });

  it('an empty-array header', () => {
    const resolver = createPrincipalResolver({ config: CONFIG });
    expect(resolver.resolve({ authorization: [] })).toBeNull();
  });

  it('a non-Bearer scheme', () => {
    const resolver = createPrincipalResolver({ config: CONFIG });
    expect(resolver.resolve({ authorization: 'Basic dXNlcjpwYXNz' })).toBeNull();
  });

  it('a Bearer scheme with no token', () => {
    const resolver = createPrincipalResolver({ config: CONFIG });
    expect(resolver.resolve({ authorization: 'Bearer ' })).toBeNull();
  });

  it('an invalid signature', () => {
    const claims = baseClaims();
    const token = issue(claims, { signingKey: 'b'.repeat(32), issuer: 'questionbank' });
    const resolver = createPrincipalResolver({ config: CONFIG, now: claims.iat });
    expect(resolver.resolve({ authorization: `Bearer ${token}` })).toBeNull();
  });

  it('an expired token — null outwardly, a distinguishable reason internally', () => {
    const claims = baseClaims({ exp: 1_000_100 });
    const token = issue(claims, CONFIG);
    const { logger, entries } = recordingLogger();
    const resolver = createPrincipalResolver({ config: CONFIG, logger, now: 1_000_100 });

    expect(resolver.resolve({ authorization: `Bearer ${token}` })).toBeNull();
    expect(entries).toHaveLength(1);
    expect(entries[0]?.attributes?.['errorCode']).toBe('EXPIRED');
  });
});

describe('createPrincipalResolver — every refusal logs at the same level with the same shape', () => {
  it('missing header, malformed scheme, empty token and an invalid token all log identically shaped entries', () => {
    const { logger, entries } = recordingLogger();
    const resolver = createPrincipalResolver({ config: CONFIG, logger });

    resolver.resolve({});
    resolver.resolve({ authorization: 'Basic xyz' });
    resolver.resolve({ authorization: 'Bearer ' });
    resolver.resolve({ authorization: 'Bearer not-a-real-token' });

    expect(entries).toHaveLength(4);
    for (const entry of entries) {
      expect(entry.level).toBe('warn');
      expect(entry.message).toBe('authentication refused');
      expect(entry.context).toBe('platform.auth');
      expect(Object.keys(entry)).toEqual(Object.keys(entries[0] as LogEntry));
    }

    const codes = entries.map((entry) => entry.attributes?.['errorCode']);
    expect(codes).toEqual(['MISSING_HEADER', 'MALFORMED_SCHEME', 'EMPTY_TOKEN', 'MALFORMED_TOKEN']);
  });

  it('resolving without a logger does not throw', () => {
    const resolver = createPrincipalResolver({ config: CONFIG });
    expect(() => resolver.resolve({})).not.toThrow();
  });
});

describe('createPrincipalResolver — the token never reaches a log record', () => {
  it('the raw token substring is absent from every log entry, valid or refused', () => {
    const claims = baseClaims();
    const validToken = issue(claims, CONFIG);
    const invalidToken = `${validToken}-tampered`;
    const { logger, entries } = recordingLogger();
    const resolver = createPrincipalResolver({ config: CONFIG, logger, now: claims.iat });

    resolver.resolve({ authorization: `Bearer ${validToken}` });
    resolver.resolve({ authorization: `Bearer ${invalidToken}` });

    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(validToken);
    expect(serialized).not.toContain(invalidToken);
  });
});

describe('createPrincipalResolver — one instance, no per-context branch', () => {
  it('resolves identically regardless of which context calls it — no context name appears in the executable code', () => {
    // stripComments-based readCode, not raw text: the doc comment above
    // legitimately names all three contexts to explain *why* one adapter
    // serves them — that is prose, not a branch, and only the code matters.
    const code = readCode(resolve(dirname(fileURLToPath(import.meta.url)), 'principal-resolver.ts')).toLowerCase();
    for (const contextName of ['content', 'curriculum', 'scoring']) {
      expect(code).not.toContain(contextName);
    }
  });

  it('the same resolver instance serves two different-looking call sites identically', () => {
    const claims = baseClaims();
    const token = issue(claims, CONFIG);
    const resolver = createPrincipalResolver({ config: CONFIG, now: claims.iat });
    const asContentHeaders = { authorization: `Bearer ${token}`, 'x-correlation-id': 'corr-content' };
    const asScoringHeaders = { authorization: `Bearer ${token}`, 'x-correlation-id': 'corr-scoring' };
    expect(resolver.resolve(asContentHeaders)).toEqual(resolver.resolve(asScoringHeaders));
  });
});
