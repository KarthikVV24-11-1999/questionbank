import type { Pool } from 'pg';
import { decide, windowStart, type RateDecision, type RateLimiter, type RatePolicy } from '../rate-limit/rate-limiter.js';

/**
 * Counters in Postgres (M8-06), for the authentication routes. One statement per hit counts every tier at once: a row per (key, window length, window start), created or
 * incremented by `ON CONFLICT DO UPDATE`, so two instances hitting the same key are serialised by the row lock and neither reads a count it then writes. The idempotency store
 * (`idempotency-store.ts`) is built the same way, on a constraint rather than a read.
 *
 * The round trip is the price, and for these routes it is nothing next to what is being guarded: a password derive is a hundred milliseconds of CPU and 64 MB. The answer is
 * the same from every instance, which the in-memory adapter's is not.
 *
 * Keys arrive already hashed by the caller, so an address or a network address is never in this table. Rows are useful until their window ends; `reapExpired` removes the rest
 * and runs from the scheduler.
 */
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private readonly pool: Pool,
    private readonly now: () => Date,
  ) {}

  async hit(key: string, policy: RatePolicy): Promise<RateDecision> {
    const at = this.now();
    const starts = policy.tiers.map((tier) => windowStart(at, tier.windowMs));
    const { rows } = await this.pool.query<{ window_ms: number; hits: number }>(
      `INSERT INTO ratelimit.counter (counter_key, window_ms, window_start, expires_at, hits)
       SELECT $1, w.window_ms, to_timestamp(w.start_ms / 1000.0), to_timestamp((w.start_ms + w.window_ms) / 1000.0), 1
       FROM unnest($2::int[], $3::bigint[]) AS w(window_ms, start_ms)
       ON CONFLICT (counter_key, window_ms, window_start) DO UPDATE SET hits = ratelimit.counter.hits + 1
       RETURNING window_ms, hits`,
      [key, policy.tiers.map((tier) => tier.windowMs), starts],
    );
    const byWindow = new Map(rows.map((row) => [row.window_ms, row.hits]));
    return decide(
      policy,
      policy.tiers.map((tier) => byWindow.get(tier.windowMs) ?? 0),
      at,
    );
  }

  /** Windows that have ended count for nothing. Returns how many rows went. */
  async reapExpired(at: Date = this.now()): Promise<number> {
    const result = await this.pool.query('DELETE FROM ratelimit.counter WHERE expires_at <= $1', [at]);
    return result.rowCount ?? 0;
  }
}
