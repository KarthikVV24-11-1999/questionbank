import { createHash } from 'node:crypto';
import type { RateDecision, RateLimiter, RateTierName, RouteLimits } from '../application/ports.js';

/**
 * Who may ask, and how often (M8-07, closes D94 in docs/DEBT.md): the limits for each authentication route class, applied before the route does anything that costs.
 *
 * **Both, always.** A request is counted against where it came from and against whom it is about, and both counts are taken whatever the first said. Source alone lets a botnet
 * grind one account from a thousand addresses; subject alone lets one machine grind every account. The two counters are read in the same order and the same number of times for
 * every request, so the limiter's own work does not depend on the answer.
 *
 * **Nothing here knows whether an address is registered.** The subject is the text the caller sent, trimmed and lower-cased and hashed; it is never looked up. A limited request
 * for an address that exists and one for an address that does not take the same path, count the same keys, and get the same 429, and no user is read before the decision.
 * That is DEC-M8-2 (docs/IMPLEMENTATION-DECISIONS.md) kept through the limiter: a limiter that answered faster for an unknown address would give back what the decoy hash took away.
 *
 * Keys are hashes, so neither an address nor a network address reaches the counter store or a log.
 *
 * **Lockout is a ceiling, not an escalation.** A held address is held until the end of the longest window of its policy and no longer, so failing on purpose against someone's
 * address can keep them out for at most that long at a time, and never for as long as the attacker likes. The reasoning, and what it gives up, is written next to the numbers in
 * `platform/config/config.ts`.
 */
export type RouteClass = 'login' | 'register' | 'recovery' | 'reset' | 'verification' | 'passwordChange';

export type IdentityRouteLimits = Readonly<Record<RouteClass, RouteLimits>>;

/** The record a limited request leaves, in the shape of the refusal records the principal resolver writes: one entry, the code as an attribute, and never a person. */
export interface RefusalLog {
  log(entry: {
    readonly level: 'warn';
    readonly message: string;
    readonly correlationId: string;
    readonly context: string;
    readonly attributes: { readonly errorCode: string; readonly reason: string; readonly route: string };
  }): void;
}

export interface Limited {
  /** Which policy applies. */
  readonly route: RouteClass;
  /** What the request is for, which names its counters: verifying a code and asking for one are limited apart under one policy. */
  readonly action: string;
  readonly ip: string;
  /** Whom it is about: the text an address was given as, or a user id. Absent where there is nobody to name. */
  readonly subject: string | null;
}

export type Admitted =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly kind: 'limited'; readonly retryAfterSeconds: number }
  | { readonly allowed: false; readonly kind: 'unavailable' };

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export class Admission {
  constructor(
    private readonly limiter: RateLimiter,
    private readonly limits: IdentityRouteLimits,
    private readonly log?: RefusalLog,
  ) {}

  async check(request: Limited, correlationId: string): Promise<Admitted> {
    const policy = this.limits[request.route];
    let source: RateDecision;
    let subject: RateDecision = { allowed: true };
    try {
      source = await this.limiter.hit(`${request.action}:source:${digest(request.ip)}`, policy.source);
      if (policy.subject !== null && request.subject !== null) {
        subject = await this.limiter.hit(`${request.action}:subject:${digest(request.subject.trim().toLowerCase().slice(0, 320))}`, policy.subject);
      }
    } catch {
      // The counters cannot be read, so nothing can be said to be within its limit: refused, and said to be unavailable, not limited.
      this.record('RATE_LIMIT_UNAVAILABLE', 'store', request.action, correlationId);
      return { allowed: false, kind: 'unavailable' };
    }
    let worst: { readonly by: 'source' | 'subject'; readonly retryAfterSeconds: number; readonly tier: RateTierName } | undefined;
    for (const [by, decision] of [['source', source], ['subject', subject]] as const) {
      if (!decision.allowed && (worst === undefined || decision.retryAfterSeconds > worst.retryAfterSeconds)) worst = { by, retryAfterSeconds: decision.retryAfterSeconds, tier: decision.tier };
    }
    if (worst === undefined) return { allowed: true };
    this.record('RATE_LIMITED', `${worst.by}_${worst.tier}`, request.action, correlationId);
    return { allowed: false, kind: 'limited', retryAfterSeconds: worst.retryAfterSeconds };
  }

  /** For the controller, which answers saturation of the bounded work and records it the same way. */
  record(errorCode: string, reason: string, route: string, correlationId: string): void {
    this.log?.log({ level: 'warn', message: errorCode === 'RATE_LIMITED' ? 'request limited' : 'request not served', correlationId, context: 'identity.admission', attributes: { errorCode, reason, route } });
  }
}
