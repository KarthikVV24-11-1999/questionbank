import type { PrincipalRef } from '@questionbank/domain-types';
import type { Logger } from '../observability/logger.js';
import { verify, type AuthErrorCode, type SigningConfig } from './token.js';

/**
 * The one `PrincipalResolver` implementation shared by content, curriculum
 * and scoring's `api/` layers — each declares the same interface
 * independently (§9 rule 1: no context reaches into another's application
 * layer), and this is the single adapter that satisfies all three. A
 * per-context branch here would mean the contexts disagree about what
 * "authenticated" means, which is exactly the drift the shared kernel
 * exists to prevent.
 *
 * `resolve` returns `null` for every refusal — a missing header, the wrong
 * scheme, an empty token, or a token `verify` itself refused — and
 * `http-runner.ts` already turns a `null` into the same 401 regardless of
 * which. The distinction is not lost: it is recorded once, internally, as an
 * `errorCode` attribute on a log record shaped identically across every
 * refusal (same level, same message), so an operator can tell them apart
 * without the outward behaviour ever varying.
 */

export type PrincipalResolverHeaders = Readonly<Record<string, string | readonly string[] | undefined>>;

export interface PrincipalResolverDependencies {
  readonly config: SigningConfig;
  readonly logger?: Logger;
  /** Seconds since epoch. Overridable so a test never races the real clock. */
  readonly now?: number;
}

export interface PrincipalResolver {
  resolve(headers: PrincipalResolverHeaders): PrincipalRef | null;
}

type RefusalCode = 'MISSING_HEADER' | 'MALFORMED_SCHEME' | 'EMPTY_TOKEN' | AuthErrorCode;

function firstValue(value: string | readonly string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : (value as string | undefined);
}

const BEARER_PREFIX = 'Bearer ';

export function createPrincipalResolver(deps: PrincipalResolverDependencies): PrincipalResolver {
  function refuse(code: RefusalCode): null {
    deps.logger?.log({
      level: 'warn',
      message: 'authentication refused',
      correlationId: 'n/a',
      context: 'platform.auth',
      attributes: { errorCode: code },
    });
    return null;
  }

  return {
    resolve(headers: PrincipalResolverHeaders): PrincipalRef | null {
      const raw = firstValue(headers['authorization']);
      if (typeof raw !== 'string') {
        return refuse('MISSING_HEADER');
      }
      if (!raw.startsWith(BEARER_PREFIX)) {
        return refuse('MALFORMED_SCHEME');
      }
      const token = raw.slice(BEARER_PREFIX.length);
      if (token.length === 0) {
        return refuse('EMPTY_TOKEN');
      }

      const result = verify(token, deps.config, deps.now === undefined ? {} : { now: deps.now });
      if (!result.ok) {
        return refuse(result.error.code);
      }
      return result.value;
    },
  };
}
