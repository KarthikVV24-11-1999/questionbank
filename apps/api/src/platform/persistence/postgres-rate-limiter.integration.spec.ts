import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { PostgresRateLimiter } from './postgres-rate-limiter.js';

/**
 * The Postgres adapter against a real database (M8-06): that one statement counts every tier, that two instances sharing the table count together, and that concurrent hits
 * are not lost to a read-then-write race.
 */
let database: TestDatabase;
let at = new Date('2026-11-03T10:00:01.000Z');
const clock = () => at;
const policy = { tiers: [{ max: 3, windowMs: 10_000 }, { max: 5, windowMs: 60_000 }] } as const;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});
beforeEach(async () => {
  at = new Date('2026-11-03T10:00:01.000Z');
  await database.pool.query('DELETE FROM ratelimit.counter');
});

describe('counters in Postgres', () => {
  it('allows up to the burst, then refuses with the seconds left in the window', async () => {
    const limiter = new PostgresRateLimiter(database.pool, clock);
    for (let hit = 0; hit < 3; hit += 1) expect(await limiter.hit('k', policy)).toEqual({ allowed: true });
    expect(await limiter.hit('k', policy)).toEqual({ allowed: false, retryAfterSeconds: 9, tier: 'burst' });
  });

  it('writes one row per tier and counts into it, under the window it falls in', async () => {
    const limiter = new PostgresRateLimiter(database.pool, clock);
    await limiter.hit('k', policy);
    await limiter.hit('k', policy);
    const { rows } = await database.pool.query<{ window_ms: number; hits: number; window_start: Date; expires_at: Date }>('SELECT window_ms, hits, window_start, expires_at FROM ratelimit.counter ORDER BY window_ms');
    expect(rows.map((row) => [row.window_ms, row.hits, row.window_start.toISOString(), row.expires_at.toISOString()])).toEqual([
      [10_000, 2, '2026-11-03T10:00:00.000Z', '2026-11-03T10:00:10.000Z'],
      [60_000, 2, '2026-11-03T10:00:00.000Z', '2026-11-03T10:01:00.000Z'],
    ]);
  });

  it('gives the allowance back when the window ends, and counts the sustained tier across windows', async () => {
    const limiter = new PostgresRateLimiter(database.pool, clock);
    for (let hit = 0; hit < 4; hit += 1) await limiter.hit('k', policy);
    at = new Date('2026-11-03T10:00:11.000Z');
    expect(await limiter.hit('k', policy)).toEqual({ allowed: true });
    expect(await limiter.hit('k', policy)).toEqual({ allowed: false, retryAfterSeconds: 49, tier: 'sustained' });
  });

  it('keeps keys apart', async () => {
    const limiter = new PostgresRateLimiter(database.pool, clock);
    for (let hit = 0; hit < 4; hit += 1) await limiter.hit('a', policy);
    expect(await limiter.hit('b', policy)).toEqual({ allowed: true });
  });

  it('counts the same key together from two instances', async () => {
    const one = new PostgresRateLimiter(database.pool, clock);
    const other = new PostgresRateLimiter(database.pool, clock);
    await one.hit('k', policy);
    await other.hit('k', policy);
    await one.hit('k', policy);
    expect(await other.hit('k', policy)).toMatchObject({ allowed: false, tier: 'burst' });
  });

  it('loses no hit to a race: fifty at once count fifty, and exactly the allowed ones are admitted', async () => {
    const limiter = new PostgresRateLimiter(database.pool, clock);
    const wide = { tiers: [{ max: 20, windowMs: 10_000 }] } as const;
    const decisions = await Promise.all(Array.from({ length: 50 }, () => limiter.hit('k', wide)));
    expect(decisions.filter((decision) => decision.allowed)).toHaveLength(20);
    const { rows } = await database.pool.query<{ hits: number }>('SELECT hits FROM ratelimit.counter');
    expect(rows).toEqual([{ hits: 50 }]);
  });

  it('removes the rows whose window has ended and no others', async () => {
    const limiter = new PostgresRateLimiter(database.pool, clock);
    await limiter.hit('k', policy);
    at = new Date('2026-11-03T10:00:30.000Z');
    expect(await limiter.reapExpired()).toBe(1);
    const { rows } = await database.pool.query<{ window_ms: number }>('SELECT window_ms FROM ratelimit.counter');
    expect(rows).toEqual([{ window_ms: 60_000 }]);
    expect(await limiter.reapExpired(new Date('2026-11-03T10:05:00.000Z'))).toBe(1);
  });
});
