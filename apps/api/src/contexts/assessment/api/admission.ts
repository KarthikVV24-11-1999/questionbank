import { createHash } from 'node:crypto';
import type { RateDecision, RateLimiter, RouteLimits } from '../application/ports.js';

/**
 * How often a class of learner route may be asked (M8-58, NFR SEC-09), by where a request came from and by whom it is for: the same two counters, always both, that the authentication
 * routes and Learning's have. `name` is the class (`events`, `attempts`), so the answers a run sends and the questions it asks do not spend each other's allowance; the numbers are
 * configuration (`RATE_LIMIT_EVENTS`, `RATE_LIMIT_ATTEMPTS`).
 *
 * This is Assessment's own copy of the small class Learning and identity have, because a context reaches `platform/` for the role vocabulary and nothing else (ADR-0026) and a shared one
 * would live there. Keys are hashes, so neither a network address nor a learner's identifier reaches the counter store or a log. A limiter that cannot be read refuses (503), as the
 * authentication routes do: nothing can then be said to be within its limit.
 */
export interface RefusalLog {
  log(entry: {
    readonly level: 'warn';
    readonly message: string;
    readonly correlationId: string;
    readonly context: string;
    readonly attributes: { readonly errorCode: string; readonly reason: string; readonly route: string };
  }): void;
}

export type Admitted =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly kind: 'limited'; readonly retryAfterSeconds: number }
  | { readonly allowed: false; readonly kind: 'unavailable' };

const digest = (value: string): string => createHash('sha256').update(value, 'utf8').digest('hex');

export class RouteAdmission {
  /** `name` is the class of route a counter belongs to, so the reads of the map and the profile's questions do not spend each other's allowance (M8-58). */
  constructor(
    private readonly limiter: RateLimiter,
    private readonly limits: RouteLimits,
    private readonly name: string,
    private readonly log?: RefusalLog,
  ) {}

  async check(request: { readonly ip: string; readonly subject: string }, route: string, correlationId: string): Promise<Admitted> {
    let source: RateDecision;
    let subject: RateDecision = { allowed: true };
    try {
      source = await this.limiter.hit(`${this.name}:source:${digest(request.ip)}`, this.limits.source);
      if (this.limits.subject !== null) subject = await this.limiter.hit(`${this.name}:subject:${digest(request.subject)}`, this.limits.subject);
    } catch {
      this.record('RATE_LIMIT_UNAVAILABLE', 'store', route, correlationId);
      return { allowed: false, kind: 'unavailable' };
    }
    let worst: { readonly by: 'source' | 'subject'; readonly retryAfterSeconds: number; readonly tier: string } | undefined;
    for (const [by, decision] of [['source', source], ['subject', subject]] as const) {
      if (!decision.allowed && (worst === undefined || decision.retryAfterSeconds > worst.retryAfterSeconds)) worst = { by, retryAfterSeconds: decision.retryAfterSeconds, tier: decision.tier };
    }
    if (worst === undefined) return { allowed: true };
    this.record('RATE_LIMITED', `${worst.by}_${worst.tier}`, route, correlationId);
    return { allowed: false, kind: 'limited', retryAfterSeconds: worst.retryAfterSeconds };
  }

  private record(errorCode: string, reason: string, route: string, correlationId: string): void {
    this.log?.log({ level: 'warn', message: errorCode === 'RATE_LIMITED' ? 'request limited' : 'request not served', correlationId, context: 'assessment.admission', attributes: { errorCode, reason, route } });
  }
}
