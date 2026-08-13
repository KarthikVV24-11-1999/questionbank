import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { readCode } from '../../../fitness/source-scan.js';
import { CURRICULUM_REGISTRY } from '../api/curriculum.controller.js';
import type { HandlerRegistry } from '../application/handler-registry.js';
import { register, type CurriculumCompositionDeps } from './composition.js';

const CONTEXT_DIR = fileURLToPath(new URL('../', import.meta.url));

const fakePool = {} as Pool;

function validDeps(overrides: Partial<CurriculumCompositionDeps> = {}): CurriculumCompositionDeps {
  return {
    pool: fakePool,
    clock: { now: () => new Date('2026-08-13T00:00:00.000Z') },
    identifiers: { next: () => 'id-1' },
    audit: { record: async () => undefined },
    principals: { resolve: () => null },
    ...overrides,
  };
}

const SPEC = parse(
  readFileSync(resolve(CONTEXT_DIR, '../../../../../packages/contracts/openapi/curriculum.yaml'), 'utf8'),
) as { readonly paths: Record<string, Record<string, { readonly 'x-handler'?: string }>> };

const DOCUMENT_HANDLER_NAMES = [
  ...new Set(
    Object.values(SPEC.paths).flatMap((item) =>
      Object.values(item)
        .map((operation) => operation['x-handler'])
        .filter((name): name is string => typeof name === 'string'),
    ),
  ),
];

describe('curriculum composition — register resolves every handler', () => {
  it('builds a module whose registry resolves every handler the OpenAPI document names', async () => {
    expect(DOCUMENT_HANDLER_NAMES.length).toBeGreaterThan(15);

    const moduleRef = await Test.createTestingModule({ imports: [register(validDeps())] }).compile();
    const registry = moduleRef.get<HandlerRegistry>(CURRICULUM_REGISTRY);

    const missing = DOCUMENT_HANDLER_NAMES.filter((name) => registry.get(name) === undefined);
    expect(missing).toEqual([]);
  });
});

type MutableDeps = { -readonly [K in keyof CurriculumCompositionDeps]?: CurriculumCompositionDeps[K] };

describe('curriculum composition — missing a required dependency is refused at runtime', () => {
  it('refuses for each required key, one at a time', () => {
    for (const key of ['pool', 'clock', 'identifiers', 'audit', 'principals'] as const) {
      const broken: MutableDeps = { ...validDeps() };
      delete broken[key];
      expect(() => register(broken as CurriculumCompositionDeps), key).toThrow(key);
    }
  });

  it('does not reject a fully-supplied deps object', () => {
    expect(() => register(validDeps())).not.toThrow();
  });
});

function importsComposition(source: string): boolean {
  return /from\s+['"]\.\/composition(\.js)?['"]/u.test(source);
}

describe('the public barrel does not import the composition module', () => {
  it('index.ts contains no import of composition.js', () => {
    const code = readCode(resolve(CONTEXT_DIR, 'public/index.ts'));
    expect(importsComposition(code)).toBe(false);
  });

  it('the check itself fires on a planted re-export', () => {
    expect(importsComposition(`export * from './composition.js';\n`)).toBe(true);
  });
});
