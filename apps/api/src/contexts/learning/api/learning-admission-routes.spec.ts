import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../../platform/rate-limit/memory-rate-limiter.js';
import { parseRouteLimits } from '../../../platform/rate-limit/rate-limiter.js';
import type { RateLimiter, RatePolicy } from '../application/ports.js';
import { ProfileAdmission } from './admission.js';
import { LearningController, type PrincipalResolver } from './learning.controller.js';

const limitsOf = (text: string) => {
  const parsed = parseRouteLimits(text, { subject: true });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};
const PRINCIPAL = { kind: 'human' as const, id: '00000000-0000-4000-8000-000000000001', roleContext: ['student'] };
const ID = '00000000-0000-4000-8000-0000000000a1';

function rig(profile: string, learning: string) {
  const inner = new MemoryRateLimiter(() => new Date('2026-11-04T10:00:01.000Z'));
  const keys: string[] = [];
  const limiter: RateLimiter = { hit: (key: string, policy: RatePolicy) => (keys.push(key), inner.hit(key, policy)) };
  const calls: string[] = [];
  const handlers = Object.fromEntries(['GetConceptMap', 'GetReviewPlan', 'ListBookmarks', 'GetConceptEvidence', 'GetLearnerProfile'].map((name) => [name, { name, handle: async () => (calls.push(name), { ok: true, value: {} }) }]));
  const principals: PrincipalResolver = { resolve: () => PRINCIPAL };
  const controller = new LearningController(handlers as never, principals, new ProfileAdmission(limiter, limitsOf(profile)), new ProfileAdmission(limiter, limitsOf(learning), undefined, 'learning'));
  return { controller, keys, calls };
}
const reply = () => {
  const out: { status?: number; headers: Record<string, string> } = { headers: {} };
  const response = { req: { ip: '198.51.100.9' }, setHeader: (k: string, v: string) => void (out.headers[k] = v), status: (c: number) => ((out.status = c), response), type: () => response, json: () => undefined } as unknown as Response;
  return { response, out };
};

describe('the learner routes that were not limited (M8-58)', () => {
  it('limits the concept map, a topic\'s answers, the review plan and the bookmarks, 429 with Retry-After and no handler reached', async () => {
    const { controller, calls } = rig('source=9/10s;subject=9/10s', 'source=9/10s;subject=1/10s');
    await controller.getConceptMap({}, reply().response);
    const second = reply();
    await controller.getConceptMap({}, second.response);
    expect(second.out.status).toBe(429);
    expect(Number(second.out.headers['Retry-After'])).toBeGreaterThan(0);
    expect(calls).toEqual(['GetConceptMap']);
    for (const go of [(r: Response) => controller.getReviewPlan({}, r), (r: Response) => controller.listBookmarks({}, r), (r: Response) => controller.getConceptEvidence(ID, {}, {}, r)]) {
      const refused = reply();
      await go(refused.response);
      expect(refused.out.status).toBe(429);
    }
  });

  it('counts under its own name, so the profile\'s allowance and these are not one allowance', async () => {
    const { controller, keys } = rig('source=9/10s;subject=1/10s', 'source=9/10s;subject=1/10s');
    await controller.getProfile({}, '198.51.100.9', reply().response);
    const map = reply();
    await controller.getConceptMap({}, map.response);
    expect(map.out.status).not.toBe(429);
    expect(keys.filter((key) => key.startsWith('profile:'))).toHaveLength(2);
    expect(keys.filter((key) => key.startsWith('learning:'))).toHaveLength(2);
  });

  it('counts the address the application resolved, not one a request names', async () => {
    const { controller, keys } = rig('source=9/10s;subject=9/10s', 'source=9/10s;subject=9/10s');
    await controller.getConceptMap({ 'x-forwarded-for': '10.0.0.1' }, reply().response);
    const direct: string[] = [];
    await new ProfileAdmission({ hit: async (key: string) => (direct.push(key), { allowed: true as const }) }, limitsOf('source=9/10s;subject=9/10s'), undefined, 'learning').check({ ip: '198.51.100.9', subject: PRINCIPAL.id }, 'x', 'c');
    expect(keys).toEqual(direct);
  });

  it('answers 503 and reaches no handler when the counters cannot be read', async () => {
    const broken: RateLimiter = { hit: async () => Promise.reject(new Error('down')) };
    const calls: string[] = [];
    const handlers = { GetConceptMap: { name: 'GetConceptMap', handle: async () => (calls.push('x'), { ok: true, value: {} }) } };
    const limits = limitsOf('source=9/10s;subject=9/10s');
    const controller = new LearningController(handlers as never, { resolve: () => PRINCIPAL }, new ProfileAdmission(broken, limits), new ProfileAdmission(broken, limits, undefined, 'learning'));
    const out = reply();
    await controller.getConceptMap({}, out.response);
    expect(out.out.status).toBe(503);
    expect(calls).toEqual([]);
  });
});
