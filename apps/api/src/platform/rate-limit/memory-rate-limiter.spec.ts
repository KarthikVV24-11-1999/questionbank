import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from './memory-rate-limiter.js';

const policy = { tiers: [{ max: 3, windowMs: 10_000 }, { max: 5, windowMs: 60_000 }] } as const;

const clockAt = (start: number) => {
  let at = start;
  return { now: () => new Date(at), set: (to: number) => void (at = to) };
};

describe('counters in a process\'s memory', () => {
  it('allows up to the burst, then refuses with the seconds left in the window', async () => {
    const clock = clockAt(60_000 * 10 + 1_000);
    const limiter = new MemoryRateLimiter(clock.now);
    for (let hit = 0; hit < 3; hit += 1) expect(await limiter.hit('k', policy)).toEqual({ allowed: true });
    expect(await limiter.hit('k', policy)).toEqual({ allowed: false, retryAfterSeconds: 9, tier: 'burst' });
  });

  it('gives the allowance back when the window ends, and counts the sustained tier across windows', async () => {
    const clock = clockAt(60_000 * 10 + 1_000);
    const limiter = new MemoryRateLimiter(clock.now);
    for (let hit = 0; hit < 4; hit += 1) await limiter.hit('k', policy);
    clock.set(60_000 * 10 + 11_000);
    expect(await limiter.hit('k', policy)).toEqual({ allowed: true });
    expect(await limiter.hit('k', policy)).toEqual({ allowed: false, retryAfterSeconds: 49, tier: 'sustained' });
  });

  it('counts a refused hit, so asking again while limited does not bring the window back sooner', async () => {
    const clock = clockAt(60_000 * 10 + 1_000);
    const limiter = new MemoryRateLimiter(clock.now);
    for (let hit = 0; hit < 8; hit += 1) await limiter.hit('k', policy);
    clock.set(60_000 * 10 + 11_000);
    expect(await limiter.hit('k', policy)).toMatchObject({ allowed: false, tier: 'sustained' });
  });

  it('keeps keys apart', async () => {
    const limiter = new MemoryRateLimiter(clockAt(1_000).now);
    for (let hit = 0; hit < 4; hit += 1) await limiter.hit('a', policy);
    expect(await limiter.hit('a', policy)).toMatchObject({ allowed: false });
    expect(await limiter.hit('b', policy)).toEqual({ allowed: true });
  });

  it('holds no more keys than it was given room for: the ended windows go first, then the oldest key', async () => {
    const clock = clockAt(60_000 * 10);
    const limiter = new MemoryRateLimiter(clock.now, 4);
    const short = { tiers: [{ max: 1, windowMs: 1_000 }] } as const;
    for (const key of ['a', 'b', 'c', 'd']) await limiter.hit(key, short);
    expect(limiter.size).toBe(4);
    clock.set(60_000 * 10 + 5_000);
    await limiter.hit('e', short);
    expect(limiter.size).toBe(1);

    const crowded = new MemoryRateLimiter(clockAt(60_000 * 10).now, 3);
    for (const key of ['a', 'b', 'c', 'd', 'e']) await crowded.hit(key, short);
    expect(crowded.size).toBe(3);
    expect(await crowded.hit('a', short)).toEqual({ allowed: true });
    expect(await crowded.hit('e', short)).toMatchObject({ allowed: false });
  });

  it('drops a window at the very moment it ends, and not before', async () => {
    const clock = clockAt(60_000 * 10);
    const limiter = new MemoryRateLimiter(clock.now, 2);
    const short = { tiers: [{ max: 1, windowMs: 1_000 }] } as const;
    await limiter.hit('a', short);
    await limiter.hit('b', short);
    clock.set(60_000 * 10 + 999);
    await limiter.hit('c', short);
    expect(limiter.size).toBe(2);
    clock.set(60_000 * 10 + 1_000);
    await limiter.hit('d', short);
    expect(limiter.size).toBe(1);
  });

  it('does not sweep until the table passes its limit: a full table keeps what it has', async () => {
    const clock = clockAt(60_000 * 10);
    const limiter = new MemoryRateLimiter(clock.now, 4);
    const short = { tiers: [{ max: 1, windowMs: 1_000 }] } as const;
    for (const key of ['a', 'b', 'c']) await limiter.hit(key, short);
    clock.set(60_000 * 10 + 5_000);
    await limiter.hit('d', short);
    expect(limiter.size).toBe(4);
    await limiter.hit('e', short);
    expect(limiter.size).toBe(2);
  });

  it('refuses a table with no room', () => {
    expect(() => new MemoryRateLimiter(clockAt(0).now, 0)).toThrow(/maxKeys/u);
    expect(() => new MemoryRateLimiter(clockAt(0).now, 1.5)).toThrow(/maxKeys/u);
  });
});
