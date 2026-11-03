import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import type { BoundedRunner, TransactionalAudit, RateLimiter as IdentityRateLimiter, RouteLimits as IdentityRouteLimits } from '../../contexts/identity/application/ports.js';
import type { RateLimiter as LearningRateLimiter, RouteLimits as LearningRouteLimits } from '../../contexts/learning/application/ports.js';
import { isSaturation } from '../../contexts/identity/application/saturation.js';
import { BoundedWork, WorkSaturated } from '../concurrency/bounded-work.js';
import { PostgresAuditRecorder } from '../persistence/audit-recorder.js';
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

describe('the platform\'s audit recorder fits the transactional audit identity declares (M8-14)', () => {
  const entry = { principal: { kind: 'human' as const, id: 'p', roleContext: ['admin'] }, action: 'RoleAssigned', targetContext: 'identity' as const, targetType: 'UserRole', targetId: 'u:author', correlationId: 'c', occurredAt: new Date('2026-11-03T09:00:00.000Z') };

  it('writes on the connection it is handed, and never on its own pool', async () => {
    const written: Array<{ text: string; values: unknown[] | undefined }> = [];
    const pool = { query: () => Promise.reject(new Error('the pool must not be used')) } as unknown as Pool;
    const audit: TransactionalAudit = new PostgresAuditRecorder(pool);
    await audit.recordWithin({ query: (text, values) => (written.push({ text, values }), Promise.resolve({})) }, entry);
    expect(written).toHaveLength(1);
    expect(written[0]!.text).toContain('INSERT INTO platform.audit_record');
    expect(written[0]!.values).toEqual(['human', 'p', 'RoleAssigned', 'identity', 'UserRole', 'u:author', null, 'c', entry.occurredAt, null]);
  });

  it('and record() is the same write on the pool', async () => {
    const written: unknown[][] = [];
    const pool = { query: (_text: string, values: unknown[]) => (written.push(values), Promise.resolve({})) } as unknown as Pool;
    await new PostgresAuditRecorder(pool).record(entry);
    expect(written).toHaveLength(1);
  });
});

describe('the platform\'s limiter fits the one Learning declares for the onboarding routes (M8-20)', () => {
  it('a limiter and a set of route limits are each assignable to Learning\'s own', async () => {
    const limiter: LearningRateLimiter = new MemoryRateLimiter(() => new Date());
    const limits: RouteLimits = { source: { tiers: [{ max: 1, windowMs: 1000 }] }, subject: { tiers: [{ max: 1, windowMs: 1000 }] } };
    const asLearning: LearningRouteLimits = limits;
    expect(await limiter.hit('k', asLearning.source)).toEqual({ allowed: true });
    expect(await limiter.hit('k', asLearning.source)).toMatchObject({ allowed: false });
  });
});
