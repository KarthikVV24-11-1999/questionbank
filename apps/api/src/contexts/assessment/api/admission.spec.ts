import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { MemoryRateLimiter } from '../../../platform/rate-limit/memory-rate-limiter.js';
import { parseRouteLimits } from '../../../platform/rate-limit/rate-limiter.js';
import { policy } from '../application/authorization.js';
import { HandlerRegistry } from '../application/handler-registry.js';
import type { RateLimiter, RatePolicy } from '../application/ports.js';
import { RouteAdmission, type RefusalLog } from './admission.js';
import { AssessmentController, type PrincipalResolver } from './assessment.controller.js';

const limitsOf = (text: string) => {
  const parsed = parseRouteLimits(text, { subject: true });
  if (!parsed.ok) throw new Error(parsed.message);
  return parsed.value;
};
const NOW = new Date('2026-11-04T10:00:01.000Z');
const PRINCIPAL = { kind: 'human' as const, id: '00000000-0000-4000-8000-000000000001', roleContext: ['student'] };
const ID = '00000000-0000-4000-8000-0000000000a1';

function recording() {
  const inner = new MemoryRateLimiter(() => NOW);
  const keys: string[] = [];
  const limiter: RateLimiter = { hit: (key: string, policyOf: RatePolicy) => (keys.push(key), inner.hit(key, policyOf)) };
  return { limiter, keys };
}

describe('how often a class of learner route may be asked (M8-58)', () => {
  it('counts under the class\'s own name, source then subject, and keeps neither address nor identifier in a key', async () => {
    const { limiter, keys } = recording();
    await new RouteAdmission(limiter, limitsOf('source=4/10s;subject=2/10s'), 'events').check({ ip: '203.0.113.7', subject: 'learner-1' }, 'IngestResponseEvents', 'c');
    expect(keys).toHaveLength(2);
    expect(keys[0]).toMatch(/^events:source:[0-9a-f]{64}$/u);
    expect(keys[1]).toMatch(/^events:subject:[0-9a-f]{64}$/u);
    expect(keys.join(' ')).not.toContain('203.0.113.7');
    expect(keys.join(' ')).not.toContain('learner-1');
  });

  it('refuses a learner who asks too often with when to come back, and not another learner from the same place', async () => {
    const admission = new RouteAdmission(recording().limiter, limitsOf('source=10/10s;subject=2/10s'), 'events');
    const ask = (subject: string) => admission.check({ ip: 'x', subject }, 'IngestResponseEvents', 'c');
    expect((await ask('a')).allowed).toBe(true);
    expect((await ask('a')).allowed).toBe(true);
    expect(await ask('a')).toMatchObject({ allowed: false, kind: 'limited', retryAfterSeconds: expect.any(Number) });
    expect((await ask('b')).allowed).toBe(true);
  });

  it('refuses everyone from a source that asks too often, whoever they are', async () => {
    const admission = new RouteAdmission(recording().limiter, limitsOf('source=2/10s;subject=9/10s'), 'attempts');
    const ask = (subject: string) => admission.check({ ip: 'x', subject }, 'GetAttempt', 'c');
    await ask('a');
    await ask('b');
    expect(await ask('c')).toMatchObject({ allowed: false, kind: 'limited' });
  });

  it('refuses as unavailable, and says so in the log, when the counters cannot be read', async () => {
    const entries: Array<Parameters<RefusalLog['log']>[0]> = [];
    const broken: RateLimiter = { hit: async () => Promise.reject(new Error('down')) };
    const answer = await new RouteAdmission(broken, limitsOf('source=2/10s;subject=2/10s'), 'events', { log: (entry) => void entries.push(entry) }).check({ ip: 'x', subject: 's' }, 'IngestResponseEvents', 'corr');
    expect(answer).toEqual({ allowed: false, kind: 'unavailable' });
    expect(entries).toEqual([expect.objectContaining({ correlationId: 'corr', context: 'assessment.admission', attributes: { errorCode: 'RATE_LIMIT_UNAVAILABLE', reason: 'store', route: 'IngestResponseEvents' } })]);
  });
});

const reply = () => {
  const out: { status?: number; body?: unknown; headers: Record<string, string> } = { headers: {} };
  const response = { req: { ip: '198.51.100.9' }, setHeader: (k: string, v: string) => ((out.headers[k] = v), response), status: (c: number) => ((out.status = c), response), type: () => response, json: (b: unknown) => void (out.body = b), send: () => undefined } as unknown as Response;
  return { response, out };
};

describe('which routes are limited, and by which allowance', () => {
  function rig(events: string, attempts: string) {
    const { limiter, keys } = recording();
    const calls: string[] = [];
    const names = ['IngestResponseEvents', 'GetPracticeFeedback', 'SubmitAttempt', 'GetPracticePackage', 'GetForm', 'GetPackageSigningKey'];
    const registry = HandlerRegistry.of(
      names.map((name) => ({ name, policy: policy(name, ['student']), handle: async () => (calls.push(name), { ok: true, value: { bytes: new Uint8Array(), digest: 'd', signature: 's', keyId: 'k', replayed: false } }) })) as never,
    );
    const principals: PrincipalResolver = { resolve: () => PRINCIPAL };
    const controller = new AssessmentController(registry, principals, { events: new RouteAdmission(limiter, limitsOf(events), 'events'), attempts: new RouteAdmission(limiter, limitsOf(attempts), 'attempts') });
    return { controller, keys, calls };
  }

  it('limits the answers a run sends, answering 429 with Retry-After, before the body is read and without reaching the handler', async () => {
    const { controller, calls } = rig('source=9/10s;subject=1/10s', 'source=9/10s;subject=9/10s');
    await controller.ingestEvents(ID, { events: [] }, {}, reply().response);
    const second = reply();
    await controller.ingestEvents(ID, { events: [] }, {}, second.response);
    expect(second.out.status).toBe(429);
    expect(Number(second.out.headers['Retry-After'])).toBeGreaterThan(0);
    expect(calls).toEqual([]);
  });

  it('limits what else a learner does with a run, each by the attempts allowance', async () => {
    const { controller, keys } = rig('source=9/10s;subject=9/10s', 'source=9/10s;subject=1/10s');
    await controller.getPracticeFeedback(ID, ID, {}, reply().response);
    const second = reply();
    await controller.getPracticeFeedback(ID, ID, {}, second.response);
    expect(second.out.status).toBe(429);
    expect(keys.every((key) => key.startsWith('attempts:'))).toBe(true);
    const third = reply();
    await controller.submitAttempt(ID, {}, {}, third.response);
    expect(third.out.status).toBe(429);
  });

  it('keeps the two allowances apart: answers sent do not spend what a run\'s other routes may ask', async () => {
    const { controller } = rig('source=9/10s;subject=1/10s', 'source=9/10s;subject=1/10s');
    await controller.ingestEvents(ID, { events: [] }, {}, reply().response);
    const other = reply();
    await controller.getPracticeFeedback(ID, ID, {}, other.response);
    expect(other.out.status).not.toBe(429);
  });

  it('counts an operator\'s routes and the public key in neither', async () => {
    const { controller, keys } = rig('source=1/10s;subject=1/10s', 'source=1/10s;subject=1/10s');
    for (let i = 0; i < 3; i += 1) {
      await controller.getForm(ID, {}, reply().response);
      await controller.getPackageSigningKey({}, reply().response);
    }
    expect(keys).toEqual([]);
  });

  it('counts the address the application resolved, so a person cannot choose it with a header', async () => {
    const { controller, keys } = rig('source=9/10s;subject=9/10s', 'source=9/10s;subject=9/10s');
    await controller.ingestEvents(ID, { events: [] }, { 'x-forwarded-for': '10.0.0.1' }, reply().response);
    const again = recording();
    await new RouteAdmission(again.limiter, limitsOf('source=9/10s;subject=9/10s'), 'events').check({ ip: '198.51.100.9', subject: PRINCIPAL.id }, 'IngestResponseEvents', 'c');
    expect(keys).toEqual(again.keys);
  });

  it('limits every learner route of a run, each one on its own, and no other', async () => {
    const goes: Array<[string, (c: AssessmentController, r: Response) => Promise<void>]> = [
      ['GetFormPackage', (c, r) => c.getFormPackage(ID, {}, r)],
      ['CreateAttempt', (c, r) => c.createAttempt({}, {}, r)],
      ['CreatePracticeAttempt', (c, r) => c.createPracticeAttempt({}, {}, r)],
      ['GrowPracticeAttempt', (c, r) => c.growPracticeAttempt(ID, {}, {}, r)],
      ['GetPracticePackage', (c, r) => c.getPracticePackage(ID, {}, r)],
      ['GetPracticeFeedback', (c, r) => c.getPracticeFeedback(ID, ID, {}, r)],
      ['GetAttempt', (c, r) => c.getAttempt(ID, {}, r)],
      ['GetAttemptResult', (c, r) => c.getAttemptResult(ID, {}, r)],
      ['GetSlotSolution', (c, r) => c.getSlotSolution(ID, ID, undefined, {}, r)],
      ['StartAttempt', (c, r) => c.startAttempt(ID, {}, r)],
      ['SubmitAttempt', (c, r) => c.submitAttempt(ID, {}, {}, r)],
      ['IngestResponseEvents', (c, r) => c.ingestEvents(ID, {}, {}, r)],
    ];
    for (const [name, go] of goes) {
      const { controller } = rig('source=9/10s;subject=1/10s', 'source=9/10s;subject=1/10s');
      await go(controller, reply().response);
      const second = reply();
      await go(controller, second.response);
      expect([name, second.out.status]).toEqual([name, 429]);
    }
  });

  it('answers 503 and reaches no handler when the counters cannot be read', async () => {
    const broken: RateLimiter = { hit: async () => Promise.reject(new Error('down')) };
    const calls: string[] = [];
    const registry = HandlerRegistry.of([{ name: 'IngestResponseEvents', policy: policy('IngestResponseEvents', ['student']), handle: async () => (calls.push('x'), { ok: true, value: {} }) }] as never);
    const limits = limitsOf('source=9/10s;subject=9/10s');
    const controller = new AssessmentController(registry, { resolve: () => PRINCIPAL }, { events: new RouteAdmission(broken, limits, 'events'), attempts: new RouteAdmission(broken, limits, 'attempts') });
    const out = reply();
    await controller.ingestEvents(ID, {}, {}, out.response);
    expect(out.out.status).toBe(503);
    expect(out.out.body).toMatchObject({ code: 'Unavailable', reason: 'STORE_UNAVAILABLE', retryable: true });
    expect(calls).toEqual([]);
  });
});
