import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { readCode } from '../../../fitness/source-scan.js';
import { versionId } from '../../../testing/generation-fixtures.js';
import { GENERATION_REGISTRY } from '../api/generation.controller.js';
import type { HandlerRegistry } from '../application/handler-registry.js';
import { InvalidPrecheckConfigurationError } from '../application/prechecks/index.js';
import { JUDGED_CHECKS } from '../application/prechecks/judge.js';
import { register, type GenerationCompositionDeps } from './composition.js';

const CONTEXT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const fakePool = {} as Pool;
const handler = { handle: async () => ({ ok: true as const, value: {} }) } as never;

function validDeps(overrides: Partial<GenerationCompositionDeps> = {}): GenerationCompositionDeps {
  return {
    pool: fakePool,
    clock: { now: () => new Date('2026-10-16T00:00:00.000Z') },
    identifiers: { next: () => 'id-1' },
    audit: { record: async () => undefined },
    principals: { resolve: () => null },
    content: { createDraft: handler, submitForReview: handler, duplicatesForProposal: handler, validateProposal: () => ({ findings: [] }) as never },
    curriculum: { taxonomyVersion: handler },
    ...overrides,
  };
}

const PRECHECK_CONFIG = Object.fromEntries(
  JUDGED_CHECKS.map((check, index) => [check, { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 20 + index) }]),
);

/** The handlers the context declares. Asserted as a set: a loop over the registry cannot notice one going missing. */
const DECLARED_HANDLERS = [
  'AcceptCandidate',
  'GetCandidate',
  'ListRunCandidates',
  'ProposeCandidate',
  'RecordPrecheckVerdict',
  'RejectCandidate',
  'RunPrecheckBattery',
  'StartGenerationRun',
];

async function registryOf(deps: GenerationCompositionDeps): Promise<HandlerRegistry> {
  const moduleRef = await Test.createTestingModule({ imports: [register(deps)] }).compile();
  return moduleRef.get<HandlerRegistry>(GENERATION_REGISTRY);
}

describe('generation composition — register resolves every handler', () => {
  it('builds a module whose registry resolves exactly the handlers the context declares', async () => {
    const registry = await registryOf(validDeps());
    expect(DECLARED_HANDLERS.filter((name) => registry.get(name) === undefined)).toEqual([]);
    expect([...registry.names].sort()).toEqual(DECLARED_HANDLERS);
  });

  it('builds the same set when a battery configuration is supplied', async () => {
    const registry = await registryOf(validDeps({ precheckConfig: PRECHECK_CONFIG }));
    expect([...registry.names].sort()).toEqual(DECLARED_HANDLERS);
  });
});

describe('generation composition — a configuration that cannot be right refuses boot', () => {
  it('refuses a pairing that is not a registry id, naming the check', () => {
    const broken = { ...PRECHECK_CONFIG, ambiguity_clarity: { modelVersionId: 'not-a-uuid', promptVersionId: 'nor-this' } };
    expect(() => register(validDeps({ precheckConfig: broken }))).toThrow(InvalidPrecheckConfigurationError);
    expect(() => register(validDeps({ precheckConfig: broken }))).toThrow(/ambiguity_clarity/u);
  });

  it('refuses two checks sharing a prompt, which would be one check in two costumes', () => {
    const shared = { ...PRECHECK_CONFIG, distractor_validity: PRECHECK_CONFIG['answer_verification']! };
    expect(() => register(validDeps({ precheckConfig: shared }))).toThrow(/PRECHECK_PROMPTS_NOT_DISTINCT/u);
  });

  it('refuses a configuration that omits a judged check', () => {
    const { safety_appropriateness: _omitted, ...incomplete } = PRECHECK_CONFIG;
    expect(() => register(validDeps({ precheckConfig: incomplete }))).toThrow(/safety_appropriateness/u);
  });
});

type MutableDeps = { -readonly [K in keyof GenerationCompositionDeps]?: GenerationCompositionDeps[K] };

describe('generation composition — missing a required dependency is refused at runtime', () => {
  it('refuses for each required key, one at a time', () => {
    for (const key of ['pool', 'clock', 'identifiers', 'audit', 'principals', 'content', 'curriculum'] as const) {
      const broken: MutableDeps = { ...validDeps() };
      delete broken[key];
      expect(() => register(broken as GenerationCompositionDeps), key).toThrow(key);
    }
  });

  it('does not reject a fully-supplied deps object, nor one without the optional provider and configuration', () => {
    expect(() => register(validDeps())).not.toThrow();
    expect(() => register(validDeps({ provider: { propose: async () => ({ ok: false }) as never, judge: async () => ({ ok: false }) as never } }))).not.toThrow();
  });
});

function importsComposition(source: string): boolean {
  return /from\s+['"]\.\/composition(\.js)?['"]/u.test(source);
}

describe('the public barrel does not import the composition module', () => {
  it('index.ts contains no import of composition.js', () => {
    expect(importsComposition(readCode(resolve(CONTEXT_DIR, 'public/index.ts')))).toBe(false);
  });

  it('the check itself fires on a planted re-export', () => {
    expect(importsComposition(`export * from './composition.js';\n`)).toBe(true);
  });
});

describe('generation holds no content or curriculum code (ADR-0025)', () => {
  it('the composition imports them as types from their barrels and nothing else', () => {
    const source = readFileSync(resolve(CONTEXT_DIR, 'public/composition.ts'), 'utf8');
    const imports = [...source.matchAll(/^import (type )?[^;]*from '(\.\.\/\.\.\/(?:content|curriculum)\/[^']+)';/gmu)];
    expect(imports.map((match) => match[2]).sort()).toEqual(['../../content/public/index.js', '../../curriculum/public/index.js']);
    expect(imports.every((match) => match[1] === 'type ')).toBe(true);
  });
});
