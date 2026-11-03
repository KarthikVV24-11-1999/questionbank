import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../../platform/rate-limit/memory-rate-limiter.js';
import { parseRouteLimits } from '../../../platform/rate-limit/rate-limiter.js';
import type { RateDecision, RateLimiter, RatePolicy } from '../application/ports.js';
import { ProfileAdmission, type RefusalLog } from './admission.js';

const limitsOf = (text: string, subject = true) => {
  const parsed = parseRouteLimits(text, { subject });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};
const LIMITS = limitsOf('source=4/10s;subject=2/10s');
const NOW = new Date('2026-11-04T10:00:01.000Z');
const ask = (admission: ProfileAdmission, ip = 'x', subject = 'learner-1') => admission.check({ ip, subject }, 'GetLearnerProfile', 'corr');

function recording() {
  const inner = new MemoryRateLimiter(() => NOW);
  const keys: string[] = [];
  const limiter: RateLimiter = { hit: (key: string, policy: RatePolicy) => (keys.push(key), inner.hit(key, policy)) };
  return { limiter, keys };
}
function logs() {
  const entries: Array<Parameters<RefusalLog['log']>[0]> = [];
  return { log: { log: (entry: Parameters<RefusalLog['log']>[0]) => void entries.push(entry) } satisfies RefusalLog, entries };
}

describe('who may ask about a profile, and how often (M8-20)', () => {
  it('counts a request against its source and against the learner, in that order, once each, under keys of its own', async () => {
    const { limiter, keys } = recording();
    await ask(new ProfileAdmission(limiter, LIMITS), '203.0.113.7', 'learner-1');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^profile:source:[0-9a-f]{64}$/u);
    expect(keys[1]).toMatch(/^profile:subject:[0-9a-f]{64}$/u);
  });

  it('keeps neither the network address nor the learner\'s identifier in a key', async () => {
    const { limiter, keys } = recording();
    await ask(new ProfileAdmission(limiter, LIMITS), '203.0.113.7', 'learner-1');
    expect(keys.join(' ')).not.toContain('203.0.113.7');
    expect(keys.join(' ')).not.toContain('learner-1');
  });

  it('counts only the source on a route whose limits have no subject', async () => {
    const { limiter, keys } = recording();
    const answer = await ask(new ProfileAdmission(limiter, limitsOf('source=4/10s', false)));
    expect(answer).toEqual({ allowed: true });
    expect(keys.map((key) => key.split(':')[1])).toEqual(['source']);
  });

  it('refuses a learner who asks too often, and not another learner from the same place within the source limit', async () => {
    const admission = new ProfileAdmission(new MemoryRateLimiter(() => NOW), LIMITS);
    expect((await ask(admission, 'a', 'one')).allowed).toBe(true);
    expect((await ask(admission, 'a', 'one')).allowed).toBe(true);
    expect(await ask(admission, 'a', 'one')).toMatchObject({ allowed: false, kind: 'limited' });
    expect((await ask(admission, 'a', 'two')).allowed).toBe(true);
  });

  it('refuses a place that asks too often whoever it asks as', async () => {
    const admission = new ProfileAdmission(new MemoryRateLimiter(() => NOW), LIMITS);
    const answers = [];
    for (let request = 0; request < 5; request += 1) answers.push((await ask(admission, 'one-place', `learner-${request}`)).allowed);
    expect(answers).toEqual([true, true, true, true, false]);
  });

  it('tells a limited caller the longer of the waits when both refused', async () => {
    const admission = new ProfileAdmission(new MemoryRateLimiter(() => NOW), limitsOf('source=1/10s;subject=1/1m'));
    await ask(admission);
    expect(await ask(admission)).toEqual({ allowed: false, kind: 'limited', retryAfterSeconds: 59 });
  });

  it('leaves a record that says the request was limited, by what and in which tier, and names no one', async () => {
    const { log, entries } = logs();
    const admission = new ProfileAdmission(new MemoryRateLimiter(() => NOW), LIMITS, log);
    for (let request = 0; request < 3; request += 1) await admission.check({ ip: '203.0.113.7', subject: 'learner-1' }, 'GetLearnerProfile', 'corr-1');
    expect(entries).toEqual([{ level: 'warn', message: 'request limited', correlationId: 'corr-1', context: 'learning.admission', attributes: { errorCode: 'RATE_LIMITED', reason: 'subject_burst', route: 'GetLearnerProfile' } }]);
    expect(JSON.stringify(entries)).not.toMatch(/203\.0\.113\.7|learner-1/u);
  });

  it('writes no record for a request that was let through', async () => {
    const { log, entries } = logs();
    await ask(new ProfileAdmission(new MemoryRateLimiter(() => NOW), LIMITS, log));
    expect(entries).toEqual([]);
  });

  it('refuses as unavailable, not as limited, when the counters cannot be read, and records it', async () => {
    const { log, entries } = logs();
    const broken: RateLimiter = { hit: () => Promise.reject(new Error('connection refused to 10.0.0.5')) };
    expect(await ask(new ProfileAdmission(broken, LIMITS, log))).toEqual({ allowed: false, kind: 'unavailable' });
    expect(entries).toEqual([{ level: 'warn', message: 'request not served', correlationId: 'corr', context: 'learning.admission', attributes: { errorCode: 'RATE_LIMIT_UNAVAILABLE', reason: 'store', route: 'GetLearnerProfile' } }]);
    expect(JSON.stringify(entries)).not.toContain('10.0.0.5');
  });

  it('is also unavailable when it is the subject\'s counter that cannot be read, and needs nowhere to write', async () => {
    let calls = 0;
    const flaky: RateLimiter = { hit: (): Promise<RateDecision> => (++calls === 1 ? Promise.resolve({ allowed: true }) : Promise.reject(new Error('down'))) };
    expect(await ask(new ProfileAdmission(flaky, LIMITS))).toEqual({ allowed: false, kind: 'unavailable' });
  });
});
