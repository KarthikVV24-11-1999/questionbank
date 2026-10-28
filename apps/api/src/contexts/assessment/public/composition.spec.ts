import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { assessmentConsumers, assessmentJobs, register, type AssessmentCompositionDeps } from './composition.js';

const deps = (): AssessmentCompositionDeps => ({
  pool: {} as Pool,
  clock: { now: () => new Date() },
  identifiers: { next: () => 'id' },
  audit: { record: async () => undefined },
  principals: { resolve: () => null },
  intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
  curriculum: {
    examProfilePins: { handle: async () => ({ ok: false, error: { kind: 'NotFound', code: 'x', message: 'x' } }) },
    scoringSpec: { handle: async () => ({ ok: false, error: { kind: 'NotFound', code: 'x', message: 'x' } }) },
  },
  scoring: {
    scoreAttempt: { handle: async () => ({ ok: true, value: {} }) },
    scoreRecord: { handle: async () => ({ ok: false, error: { kind: 'NotFound', code: 'x', message: 'x' } }) },
    judge: { handle: async () => ({ ok: true, value: [] }) },
  },
  content: {
    listCatalogue: { handle: async () => ({ ok: true, value: { entries: [] } }) },
    duplicates: { handle: async () => ({ ok: false, error: { kind: 'x', code: 'x', message: 'x' } }) },
    itemVersion: { handle: async () => ({ ok: true, value: {} }) },
    stimulusVersion: { handle: async () => ({ ok: true, value: {} }) },
    answerKeys: { handle: async () => ({ ok: true, value: [] }) },
    solution: { handle: async () => ({ ok: false, error: { kind: 'NotFound', code: 'x', message: 'x' } }) },
  },
});

describe('assessment composition', () => {
  it('builds a module carrying the controller from a complete set of dependencies', () => {
    const module = register(deps());
    expect(module.controllers).toHaveLength(1);
    expect(module.providers).toHaveLength(2);
  });

  it('refuses at runtime for each required key, one at a time, even reached through a cast', () => {
    for (const key of ['pool', 'clock', 'identifiers', 'audit', 'principals', 'content', 'curriculum', 'scoring', 'intervalCapMs'] as const) {
      const broken: Partial<Record<keyof AssessmentCompositionDeps, unknown>> = { ...deps() };
      delete broken[key];
      expect(() => register(broken as AssessmentCompositionDeps), key).toThrow(key);
    }
  });

  it('holds no import of content: what it calls arrives as handlers in its dependencies', async () => {
    const { readFileSync } = await import('node:fs');
    const source = readFileSync(new URL('./composition.ts', import.meta.url), 'utf8');
    expect(source.match(/from '\.\.\/\.\.\/content/gu)).toBeNull();
  });
});

describe('what the relay and the scheduler are given', () => {
  it('hands AttemptSubmitted to the scoring consumer, and nothing else', () => {
    const consumers = assessmentConsumers(deps());
    expect([...consumers.keys()]).toEqual(['AttemptSubmitted']);
    expect(consumers.get('AttemptSubmitted')?.map((consumer) => consumer.name)).toEqual(['ScoreSubmittedAttempt']);
  });

  it('runs the two sweeps, named, each failing loudly when its command is refused', async () => {
    const jobs = assessmentJobs(deps());
    expect(jobs.map((job) => [job.name, job.everyMs])).toEqual([
      ['assessment.sweep-windows', 30_000],
      ['assessment.submit-expired', 15_000],
    ]);
    // against a pool that cannot answer, the command is refused and the job says so rather than pretending it ran
    for (const job of jobs) await expect(job.run(new Date('2026-10-23T10:00:00.000Z'))).rejects.toThrow(/Sweep|SubmitExpired/u);
  });

  it('refuses the same incomplete dependencies register does', () => {
    expect(() => assessmentConsumers({ pool: {} as Pool } as never)).toThrow(/missing required dependency/u);
    expect(() => assessmentJobs({ pool: {} as Pool } as never)).toThrow(/missing required dependency/u);
  });
});
