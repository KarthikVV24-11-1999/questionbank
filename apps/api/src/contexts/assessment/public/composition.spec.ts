import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { register, type AssessmentCompositionDeps } from './composition.js';

const deps = (): AssessmentCompositionDeps => ({
  pool: {} as Pool,
  clock: { now: () => new Date() },
  identifiers: { next: () => 'id' },
  audit: { record: async () => undefined },
  principals: { resolve: () => null },
  curriculum: { examProfilePins: { handle: async () => ({ ok: false, error: { kind: 'NotFound', code: 'x', message: 'x' } }) } },
  content: {
    listCatalogue: { handle: async () => ({ ok: true, value: { entries: [] } }) },
    duplicates: { handle: async () => ({ ok: false, error: { kind: 'x', code: 'x', message: 'x' } }) },
    itemVersion: { handle: async () => ({ ok: true, value: {} }) },
    stimulusVersion: { handle: async () => ({ ok: true, value: {} }) },
  },
});

describe('assessment composition', () => {
  it('builds a module carrying the controller from a complete set of dependencies', () => {
    const module = register(deps());
    expect(module.controllers).toHaveLength(1);
    expect(module.providers).toHaveLength(2);
  });

  it('refuses at runtime for each required key, one at a time, even reached through a cast', () => {
    for (const key of ['pool', 'clock', 'identifiers', 'audit', 'principals', 'content', 'curriculum'] as const) {
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
