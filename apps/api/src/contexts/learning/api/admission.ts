import { createHash } from 'node:crypto';
import type { RateDecision, RateLimiter, RouteLimits } from '../application/ports.js';

/**
 * How often the profile routes may be asked (M8-20, NFR SEC-09), by where a request came from and by whom it is for: the same two counters, always both, that Track B put before
 * the authentication routes, through the same port. **Every step of onboarding is limited**, the reads and the writes, because each is a database round trip and the scope options a
 * read of a whole taxonomy; the numbers are configuration (`RATE_LIMIT_PROFILE`).
 *
 * This is Learning's own copy of the small class identity has, because a context reaches `platform/` for the role vocabulary and nothing else (ADR-0026) and a shared one would live
 * there. Keys are hashes, so neither a network address nor a learner's identifier reaches the counter store or a log. A limiter that cannot be read refuses (503), as the
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

export class ProfileAdmission {
  /** `name` is the class of route a counter belongs to, so the reads of the map and the profile's questions do not spend each other's allowance (M8-58). */
  constructor(
    private readonly limiter: RateLimiter,
    private readonly limits: RouteLimits,
    private readonly log?: RefusalLog,
    private readonly name: string = 'profile',
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
    this.log?.log({ level: 'warn', message: errorCode === 'RATE_LIMITED' ? 'request limited' : 'request not served', correlationId, context: 'learning.admission', attributes: { errorCode, reason, route } });
  }
}
