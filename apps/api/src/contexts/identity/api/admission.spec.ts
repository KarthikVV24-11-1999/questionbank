import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../../platform/rate-limit/memory-rate-limiter.js';
import type { RateDecision, RateLimiter, RatePolicy } from '../../../platform/rate-limit/rate-limiter.js';
import { parseRouteLimits } from '../../../platform/rate-limit/rate-limiter.js';
import { Admission, type IdentityRouteLimits, type RefusalLog } from './admission.js';

const limitsOf = (text: string, subject = true) => {
  const parsed = parseRouteLimits(text, { subject });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};
const LIMITS: IdentityRouteLimits = {
  login: limitsOf('source=4/10s;subject=2/10s'),
  register: limitsOf('source=4/10s;subject=2/10s'),
  recovery: limitsOf('source=4/10s;subject=2/10s'),
  reset: limitsOf('source=4/10s', false),
  verification: limitsOf('source=4/10s;subject=2/10s'),
  passwordChange: limitsOf('source=4/10s;subject=2/10s'),
};
const NOW = new Date('2026-11-03T10:00:01.000Z');

function recording(inner: RateLimiter = new MemoryRateLimiter(() => NOW)) {
  const keys: string[] = [];
  const limiter: RateLimiter = { hit: (key: string, policy: RatePolicy) => (keys.push(key), inner.hit(key, policy)) };
  return { limiter, keys };
}

function logs() {
  const entries: Array<Parameters<RefusalLog['log']>[0]> = [];
  return { log: { log: (entry: Parameters<RefusalLog['log']>[0]) => void entries.push(entry) } satisfies RefusalLog, entries };
}

describe('who may ask, and how often', () => {
  it('counts a request against its source and against its subject, in that order, once each', async () => {
    const { limiter, keys } = recording();
    await new Admission(limiter, LIMITS).check({ route: 'login', action: 'login', ip: '203.0.113.7', subject: 'Asha@Example.com' }, 'c');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^login:source:[0-9a-f]{64}$/u);
    expect(keys[1]).toMatch(/^login:subject:[0-9a-f]{64}$/u);
  });

  it('keeps neither the network address nor the address of a person in a key', async () => {
    const { limiter, keys } = recording();
    await new Admission(limiter, LIMITS).check({ route: 'login', action: 'login', ip: '203.0.113.7', subject: 'asha@example.com' }, 'c');
    expect(keys.join(' ')).not.toContain('203.0.113.7');
    expect(keys.join(' ')).not.toContain('asha');
  });

  it('counts one person under one key however the address is cased or spaced', async () => {
    const { limiter, keys } = recording();
    const admission = new Admission(limiter, LIMITS);
    await admission.check({ route: 'login', action: 'login', ip: 'x', subject: 'asha@example.com' }, 'c');
    await admission.check({ route: 'login', action: 'login', ip: 'x', subject: '  ASHA@Example.COM ' }, 'c');
    expect(keys[1]).toBe(keys[3]);
  });

  it('keeps what a request is for apart in its counters: verifying a code is not asking for one', async () => {
    const { limiter, keys } = recording();
    const admission = new Admission(limiter, LIMITS);
    await admission.check({ route: 'verification', action: 'verify-submit', ip: 'x', subject: null }, 'c');
    await admission.check({ route: 'verification', action: 'verify-issue', ip: 'x', subject: 'u' }, 'c');
    expect(keys[0]!.split(':source:')[0]).toBe('verify-submit');
    expect(keys[1]!.split(':source:')[0]).toBe('verify-issue');
    expect(keys[2]).toMatch(/^verify-issue:subject:/u);
    expect(keys[0]).not.toBe(keys[1]);
  });

  it('counts only the source where there is no subject, by the route or by the request', async () => {
    const { limiter, keys } = recording();
    const admission = new Admission(limiter, LIMITS);
    await admission.check({ route: 'reset', action: 'reset', ip: 'x', subject: null }, 'c');
    await admission.check({ route: 'reset', action: 'reset', ip: 'x', subject: 'someone' }, 'c');
    const noSubject = await admission.check({ route: 'login', action: 'login', ip: 'x', subject: null }, 'c');
    expect(noSubject).toEqual({ allowed: true });
    expect(keys.map((key) => key.split(':')[1])).toEqual(['source', 'source', 'source']);
  });

  it('counts both even when the first has already refused, so the work does not depend on the answer', async () => {
    const { limiter, keys } = recording();
    const admission = new Admission(limiter, LIMITS);
    for (let request = 0; request < 6; request += 1) await admission.check({ route: 'login', action: 'login', ip: 'x', subject: `person-${request}` }, 'c');
    expect((await admission.check({ route: 'login', action: 'login', ip: 'x', subject: 'person-7' }, 'c'))).toMatchObject({ allowed: false, kind: 'limited' });
    expect(keys).toHaveLength(14);
  });

  it('refuses on the source alone when many addresses come from one place, and on the subject alone when many places ask for one address', async () => {
    const admission = new Admission(new MemoryRateLimiter(() => NOW), LIMITS);
    const fromOne = [];
    for (let request = 0; request < 5; request += 1) fromOne.push(await admission.check({ route: 'login', action: 'login', ip: 'one-place', subject: `person-${request}` }, 'c'));
    expect(fromOne.map((answer) => answer.allowed)).toEqual([true, true, true, true, false]);

    const forOne = [];
    for (let request = 0; request < 3; request += 1) forOne.push(await admission.check({ route: 'login', action: 'login', ip: `place-${request}`, subject: 'one-person' }, 'c'));
    expect(forOne.map((answer) => answer.allowed)).toEqual([true, true, false]);
  });

  it('tells a limited caller the longer of the waits when both refused', async () => {
    const limits: IdentityRouteLimits = { ...LIMITS, login: limitsOf('source=1/10s;subject=1/1m') };
    const admission = new Admission(new MemoryRateLimiter(() => NOW), limits);
    await admission.check({ route: 'login', action: 'login', ip: 'x', subject: 'a' }, 'c');
    expect(await admission.check({ route: 'login', action: 'login', ip: 'x', subject: 'a' }, 'c')).toEqual({ allowed: false, kind: 'limited', retryAfterSeconds: 59 });
  });

  it('leaves a record that says the request was limited, by what and in which tier, and names no one', async () => {
    const { log, entries } = logs();
    const admission = new Admission(new MemoryRateLimiter(() => NOW), LIMITS, log);
    for (let request = 0; request < 3; request += 1) await admission.check({ route: 'login', action: 'login', ip: '203.0.113.7', subject: 'asha@example.com' }, 'corr-1');
    expect(entries).toEqual([
      { level: 'warn', message: 'request limited', correlationId: 'corr-1', context: 'identity.admission', attributes: { errorCode: 'RATE_LIMITED', reason: 'subject_burst', route: 'login' } },
    ]);
    expect(JSON.stringify(entries)).not.toMatch(/203\.0\.113\.7|asha/u);
  });

  it('writes no record for a request that was let through', async () => {
    const { log, entries } = logs();
    await new Admission(new MemoryRateLimiter(() => NOW), LIMITS, log).check({ route: 'login', action: 'login', ip: 'x', subject: 'a' }, 'c');
    expect(entries).toEqual([]);
  });

  it('refuses as unavailable, not as limited, when the counters cannot be read, and records it', async () => {
    const { log, entries } = logs();
    const broken: RateLimiter = { hit: () => Promise.reject(new Error('connection refused to 10.0.0.5')) };
    const answer = await new Admission(broken, LIMITS, log).check({ route: 'login', action: 'login', ip: 'x', subject: 'a' }, 'c');
    expect(answer).toEqual({ allowed: false, kind: 'unavailable' });
    expect(entries).toEqual([{ level: 'warn', message: 'request not served', correlationId: 'c', context: 'identity.admission', attributes: { errorCode: 'RATE_LIMIT_UNAVAILABLE', reason: 'store', route: 'login' } }]);
    expect(JSON.stringify(entries)).not.toContain('10.0.0.5');
  });

  it('also refuses as unavailable when it is the subject\'s counter that cannot be read', async () => {
    let calls = 0;
    const flaky: RateLimiter = { hit: (): Promise<RateDecision> => (++calls === 1 ? Promise.resolve({ allowed: true }) : Promise.reject(new Error('down'))) };
    expect(await new Admission(flaky, LIMITS).check({ route: 'login', action: 'login', ip: 'x', subject: 'a' }, 'c')).toEqual({ allowed: false, kind: 'unavailable' });
  });

  it('records saturation with the same shape, for the controller to call', () => {
    const { log, entries } = logs();
    new Admission(new MemoryRateLimiter(() => NOW), LIMITS, log).record('WORK_SATURATED', 'queue_full', 'login', 'corr-2');
    expect(entries).toEqual([{ level: 'warn', message: 'request not served', correlationId: 'corr-2', context: 'identity.admission', attributes: { errorCode: 'WORK_SATURATED', reason: 'queue_full', route: 'login' } }]);
  });

  it('is happy without anywhere to write', async () => {
    const admission = new Admission(new MemoryRateLimiter(() => NOW), LIMITS);
    for (let request = 0; request < 3; request += 1) await admission.check({ route: 'login', action: 'login', ip: 'x', subject: 'a' }, 'c');
    admission.record('WORK_SATURATED', 'queue_full', 'login', 'c');
  });
});
