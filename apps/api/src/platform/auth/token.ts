import { createHmac, timingSafeEqual } from 'node:crypto';
import type { PrincipalKind, PrincipalRef, RoleSet, UserId } from '@questionbank/domain-types';

/**
 * The auth stub (DEC-M0-7, ADR-0014). It **issues and verifies a
 * principal** — it does not issue an identity. There is no user store, no
 * password, no refresh rotation, no revocation list, and no role
 * assignment; all five are Identity's, in M8. See the ADR for the trigger
 * that replaces this file.
 *
 * HMAC-SHA256 over a fixed three-segment format (`header.payload.signature`,
 * each base64url), signed and verified with `node:crypto` alone —
 * `jose`/`jsonwebtoken` are not in the offline store, and nothing here needs
 * them. `verify` never reads an algorithm from the token to decide how to
 * check it: the header is fixed and ignored, so there is no "alg: none"
 * shortcut to find, by construction rather than by a check.
 */

const PRINCIPAL_KINDS: readonly PrincipalKind[] = ['human', 'ai_agent', 'system'];

/** Fixed and ignored on verify — ships to keep the wire format self-describing, never read back. */
const HEADER_JSON = '{"typ":"qb-token","alg":"HS256"}';

export interface TokenClaims {
  readonly sub: UserId;
  readonly kind: PrincipalKind;
  readonly roles: RoleSet;
  /** Seconds since epoch. */
  readonly iat: number;
  readonly exp: number;
  readonly iss: string;
  readonly jti: string;
}

export type AuthErrorCode =
  | 'MALFORMED_TOKEN'
  | 'INVALID_SIGNATURE'
  | 'INVALID_CLAIMS'
  | 'UNKNOWN_PRINCIPAL_KIND'
  | 'ISSUER_MISMATCH'
  | 'EXPIRED';

export interface AuthError {
  readonly code: AuthErrorCode;
  readonly message: string;
}

export type AuthResult = { readonly ok: true; readonly value: PrincipalRef } | { readonly ok: false; readonly error: AuthError };

export interface SigningConfig {
  readonly signingKey: string;
  readonly issuer: string;
}

function base64url(input: Buffer): string {
  return input.toString('base64url');
}

function sign(header: string, payload: string, signingKey: string): string {
  return base64url(createHmac('sha256', signingKey).update(`${header}.${payload}`).digest());
}

function fail(code: AuthErrorCode, message: string): { readonly ok: false; readonly error: AuthError } {
  return { ok: false, error: { code, message } };
}

export function issue(claims: TokenClaims, config: SigningConfig): string {
  const header = base64url(Buffer.from(HEADER_JSON, 'utf8'));
  const payload = base64url(
    Buffer.from(
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
    ),
  );
  const signature = sign(header, payload, config.signingKey);
  return `${header}.${payload}.${signature}`;
}

/** Equal-length check first — a length mismatch never reaches `timingSafeEqual`, which throws on one. */
function signaturesMatch(expected: Buffer, actual: Buffer): boolean {
  if (expected.length !== actual.length) return false;
  return timingSafeEqual(expected, actual);
}

function isRoleSet(value: unknown): value is RoleSet {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

type ClaimsResult = { readonly ok: true; readonly value: TokenClaims } | { readonly ok: false; readonly error: AuthError };

function parseClaims(payloadSegment: string): ClaimsResult {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(payloadSegment, 'base64url').toString('utf8'));
  } catch {
    return fail('MALFORMED_TOKEN', 'the token payload is not valid JSON');
  }

  if (typeof decoded !== 'object' || decoded === null) {
    return fail('INVALID_CLAIMS', 'the token payload is not a claims object');
  }
  const claims = decoded as Record<string, unknown>;

  if (typeof claims['sub'] !== 'string' || claims['sub'].length === 0) {
    return fail('INVALID_CLAIMS', 'sub is required');
  }
  if (typeof claims['iss'] !== 'string' || claims['iss'].length === 0) {
    return fail('INVALID_CLAIMS', 'iss is required');
  }
  if (typeof claims['jti'] !== 'string' || claims['jti'].length === 0) {
    return fail('INVALID_CLAIMS', 'jti is required');
  }
  if (typeof claims['iat'] !== 'number' || typeof claims['exp'] !== 'number') {
    return fail('INVALID_CLAIMS', 'iat and exp must be numbers');
  }
  if (!isRoleSet(claims['roles'])) {
    return fail('INVALID_CLAIMS', 'roles must be an array of strings');
  }
  if (typeof claims['kind'] !== 'string' || !PRINCIPAL_KINDS.includes(claims['kind'] as PrincipalKind)) {
    return fail('UNKNOWN_PRINCIPAL_KIND', `kind must be one of ${PRINCIPAL_KINDS.join(', ')}`);
  }

  return {
    ok: true,
    value: {
      sub: claims['sub'],
      kind: claims['kind'] as PrincipalKind,
      roles: claims['roles'],
      iat: claims['iat'],
      exp: claims['exp'],
      iss: claims['iss'],
      jti: claims['jti'],
    },
  };
}

export interface VerifyOptions {
  /** Seconds since epoch. Defaults to the real clock; overridable so a test never races it. */
  readonly now?: number;
}

/**
 * Total: never throws. Returns exactly a `PrincipalRef` on success — no
 * other claim survives verification, so nothing downstream can start
 * depending on a field the shared kernel does not name (§9 rule 5).
 */
export function verify(token: string, config: SigningConfig, options: VerifyOptions = {}): AuthResult {
  const segments = token.split('.');
  if (segments.length !== 3) {
    return fail('MALFORMED_TOKEN', 'a token must have exactly three segments');
  }
  const [header, payload, signature] = segments as [string, string, string];
  if (header.length === 0 || payload.length === 0 || signature.length === 0) {
    return fail('MALFORMED_TOKEN', 'no token segment may be empty');
  }

  const expectedSignature = sign(header, payload, config.signingKey);
  const expectedBytes = Buffer.from(expectedSignature, 'base64url');
  const actualBytes = Buffer.from(signature, 'base64url');
  if (!signaturesMatch(expectedBytes, actualBytes)) {
    return fail('INVALID_SIGNATURE', 'the signature does not match');
  }

  const parsed = parseClaims(payload);
  if (!parsed.ok) return parsed;
  const claims = parsed.value;

  if (claims.iss !== config.issuer) {
    return fail('ISSUER_MISMATCH', 'the token was issued by a different issuer');
  }

  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (now >= claims.exp) {
    return fail('EXPIRED', 'the token has expired');
  }

  return { ok: true, value: { kind: claims.kind, id: claims.sub, roleContext: claims.roles } };
}
