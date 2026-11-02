import { decide, windowStart, type RateDecision, type RateLimiter, type RatePolicy } from './rate-limiter.js';

/**
 * Counters in this process's memory (M8-06), for routes asked often enough that a round trip per request is not acceptable.
 *
 * **The limit is per process.** With two instances behind one balancer a client is held to the configured rate by each of them, so the real limit is the configured one times
 * the number of instances. That is acceptable for the surfaces this serves (a read route is limited to stop a scraper, not to hold an exact line) and is not for an
 * authentication route, which is why those use the Postgres adapter. It is registered as a debt with its trigger (D97 in docs/DEBT.md).
 *
 * Memory is bounded: when the table passes `maxKeys` the windows that have ended are dropped, and if it is still full the oldest key goes. A client cannot grow the table past
 * that by asking with a new key each time; it can only push out the counters of others, which costs them a fresh allowance and no more.
 */
export class MemoryRateLimiter implements RateLimiter {
  readonly #counters = new Map<string, { start: number; hits: number }>();

  constructor(
    private readonly now: () => Date,
    private readonly maxKeys = 50_000,
  ) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) throw new Error('MemoryRateLimiter: maxKeys must be a positive integer');
  }

  hit(key: string, policy: RatePolicy): Promise<RateDecision> {
    const at = this.now();
    const counts = policy.tiers.map((tier) => {
      const slot = `${key}|${tier.windowMs}`;
      const start = windowStart(at, tier.windowMs);
      const found = this.#counters.get(slot);
      if (found !== undefined && found.start === start) {
        found.hits += 1;
        return found.hits;
      }
      this.#counters.delete(slot);
      this.#counters.set(slot, { start, hits: 1 });
      this.#trim(at, policy);
      return 1;
    });
    return Promise.resolve(decide(policy, counts, at));
  }

  get size(): number {
    return this.#counters.size;
  }

  #trim(at: Date, policy: RatePolicy): void {
    if (this.#counters.size <= this.maxKeys) return;
    const longest = Math.max(...policy.tiers.map((tier) => tier.windowMs));
    for (const [slot, counter] of this.#counters) {
      const windowMs = Number(slot.slice(slot.lastIndexOf('|') + 1));
      if (counter.start + (Number.isFinite(windowMs) ? windowMs : longest) <= at.getTime()) this.#counters.delete(slot);
    }
    while (this.#counters.size > this.maxKeys) {
      const oldest = this.#counters.keys().next();
      if (oldest.done === true) return;
      this.#counters.delete(oldest.value);
    }
  }
}
