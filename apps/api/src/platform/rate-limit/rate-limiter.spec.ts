import { describe, expect, it } from 'vitest';
import { decide, parseRatePolicy, parseRouteLimits, windowStart } from './rate-limiter.js';

const policy = { tiers: [{ max: 2, windowMs: 10_000 }, { max: 5, windowMs: 60_000 }] } as const;

describe('a window is where the epoch puts it', () => {
  it('starts at the last multiple of its length, so every instance agrees where it ends', () => {
    expect(windowStart(new Date(10_000 * 7 + 9_999), 10_000)).toBe(70_000);
    expect(windowStart(new Date(70_000), 10_000)).toBe(70_000);
  });
});

describe('the decision for a set of counts', () => {
  const at = new Date(10_000 * 7 + 2_500);

  it('allows a count at the limit and refuses the one past it', () => {
    expect(decide(policy, [2, 5], at)).toEqual({ allowed: true });
    expect(decide(policy, [3, 1], at)).toMatchObject({ allowed: false, tier: 'burst' });
  });

  it('tells the caller the whole seconds until the window that refused ends, rounded up and never zero', () => {
    expect(decide(policy, [3, 1], at)).toEqual({ allowed: false, retryAfterSeconds: 8, tier: 'burst' });
    expect(decide(policy, [3, 1], new Date(10_000 * 7 + 9_999))).toEqual({ allowed: false, retryAfterSeconds: 1, tier: 'burst' });
  });

  it('names the sustained tier when it refused, and the one that ends last when both did', () => {
    const inMinute = new Date(60_000 * 3 + 20_000);
    expect(decide(policy, [1, 6], inMinute)).toEqual({ allowed: false, retryAfterSeconds: 40, tier: 'sustained' });
    expect(decide(policy, [3, 6], inMinute)).toEqual({ allowed: false, retryAfterSeconds: 40, tier: 'sustained' });
  });

  it('names the sustained tier when both end in the same second', () => {
    const lastSecond = new Date(60_000 * 4 - 1);
    expect(decide(policy, [3, 6], lastSecond)).toEqual({ allowed: false, retryAfterSeconds: 1, tier: 'sustained' });
  });
});

describe('a policy written as text', () => {
  it('reads hits per window, shortest window first', () => {
    expect(parseRatePolicy('100/10s,1000/1h')).toEqual({ ok: true, value: { tiers: [{ max: 100, windowMs: 10_000 }, { max: 1000, windowMs: 3_600_000 }] } });
    expect(parseRatePolicy(' 5/1m ')).toEqual({ ok: true, value: { tiers: [{ max: 5, windowMs: 60_000 }] } });
  });

  it('accepts the edges of what it allows: one hit, a million, a second, a day, and three tiers', () => {
    expect(parseRatePolicy('1/1s')).toMatchObject({ ok: true });
    expect(parseRatePolicy('1000000/24h')).toMatchObject({ ok: true });
    expect(parseRatePolicy('1/1s,2/2s,3/3s')).toMatchObject({ ok: true });
    expect(parseRatePolicy('1/86400s')).toMatchObject({ ok: true });
    expect(parseRatePolicy('1/86401s')).toMatchObject({ ok: false });
  });

  it.each([
    ['', 'is not hits/window'],
    ['5', 'is not hits/window'],
    ['5/1d', 'is not hits/window'],
    ['0/1m', 'hits must be from 1'],
    ['1000001/1m', 'hits must be from 1'],
    ['5/0s', 'a window is from 1 second'],
    ['5/25h', 'a window is from 1 second'],
    ['5/1m,5/1m', 'windows must grow'],
    ['5/1h,5/1m', 'windows must grow'],
    ['1/1s,2/2s,3/3s,4/4s', 'one to 3 tiers'],
  ])('refuses %j, saying why', (text, why) => {
    const parsed = parseRatePolicy(text);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain(why);
  });
});

describe('the limits of a route class written as text', () => {
  it('reads a source and, where the route has someone to name, a subject', () => {
    const parsed = parseRouteLimits('source=100/10s,1000/1h;subject=5/1m', { subject: true });
    expect(parsed).toEqual({ ok: true, value: { source: { tiers: [{ max: 100, windowMs: 10_000 }, { max: 1000, windowMs: 3_600_000 }] }, subject: { tiers: [{ max: 5, windowMs: 60_000 }] } } });
    expect(parseRouteLimits('source=5/1m', { subject: true })).toMatchObject({ ok: true, value: { subject: null } });
  });

  it.each([
    ['subject=5/1m', { subject: true }, 'source=... is required'],
    ['source=5/1m;source=6/1m', { subject: true }, 'given twice'],
    ['source=5/1m;subject=5/1m', { subject: false }, 'no subject'],
    ['source=5/1m;who=5/1m', { subject: true }, 'is not source=... or subject=...'],
    ['source', { subject: true }, 'is not source=... or subject=...'],
    ['source=5/1m=6/1m', { subject: true }, 'is not source=... or subject=...'],
    ['source=nonsense', { subject: true }, 'source: "nonsense"'],
    ['source=5/1m;subject=nonsense', { subject: true }, 'subject: "nonsense"'],
  ])('refuses %j, saying why', (text, options, why) => {
    const parsed = parseRouteLimits(text, options);
    expect(parsed.ok).toBe(false);
    expect(parsed.ok ? '' : parsed.message).toContain(why);
  });
});
