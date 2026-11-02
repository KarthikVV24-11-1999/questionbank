import { describe, expect, it } from 'vitest';
import type { BoundedRunner, RateLimiter as IdentityRateLimiter, RouteLimits as IdentityRouteLimits } from '../../contexts/identity/application/ports.js';
import { isSaturation } from '../../contexts/identity/application/saturation.js';
import { BoundedWork, WorkSaturated } from '../concurrency/bounded-work.js';
import { systemTimers } from '../scheduling/system-timers.js';
import { MemoryRateLimiter } from './memory-rate-limiter.js';
import type { RouteLimits } from './rate-limiter.js';

/**
 * Identity declares the shapes of the limiter and the bound it asks for, because a context may not import `platform/` beyond the role vocabulary (ADR-0026). The platform's own
 * types are meant to satisfy them. These assignments are checked by the compiler, so a change on either side that breaks the fit fails the typecheck, and by the runtime asserts
 * below for the one thing a type cannot carry: what a saturation says it is.
 */
describe('the platform\'s limiter and bound fit the ports identity declares', () => {
  it('a limiter, a set of route limits and a bound are each assignable to identity\'s own', async () => {
    const limiter: IdentityRateLimiter = new MemoryRateLimiter(() => new Date());
    const limits: RouteLimits = { source: { tiers: [{ max: 1, windowMs: 1000 }] }, subject: null };
    const asIdentity: IdentityRouteLimits = limits;
    const bound: BoundedRunner = new BoundedWork({ concurrency: 1, queueLimit: 1, waitMs: 10, timers: systemTimers });
    expect(await limiter.hit('k', asIdentity.source)).toEqual({ allowed: true });
    expect(await bound.run(() => Promise.resolve('ran'))).toBe('ran');
  });

  it('a saturation from the bound is recognised by identity, and an ordinary error is not', () => {
    expect(isSaturation(new WorkSaturated('queue_full'))).toBe(true);
    expect(isSaturation(new WorkSaturated('wait_timeout'))).toBe(true);
    for (const other of [new Error('boom'), null, undefined, 'queue_full', { saturated: true }, { saturated: true, reason: 'other' }, { saturated: false, reason: 'queue_full' }]) expect(isSaturation(other)).toBe(false);
  });
});
