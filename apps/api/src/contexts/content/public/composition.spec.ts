import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { parse } from 'yaml';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { readCode } from '../../../fitness/source-scan.js';
import { CONTENT_REGISTRY } from '../api/http-runner.js';
import type { HandlerRegistry } from '../application/handler-registry.js';
import { contentForAssessment, register, type ContentCompositionDeps } from './composition.js';

const CONTEXT_DIR = fileURLToPath(new URL('../', import.meta.url));

/** A `Pool`-shaped stand-in — composition never queries during `register`, only when a handler runs. */
const fakePool = {} as Pool;

function validDeps(overrides: Partial<ContentCompositionDeps> = {}): ContentCompositionDeps {
  return {
    pool: fakePool,
    mediaStore: { put: async () => ({ storageKey: 'k', checksum: 'k', contentType: 't', byteLength: 0 }), head: async () => undefined },
    idempotency: { seen: async () => false, remember: async () => undefined },
    clock: { now: () => new Date('2026-08-13T00:00:00.000Z') },
    identifiers: { next: () => 'id-1' },
    audit: { record: async () => undefined },
    principals: { resolve: () => null },
    reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
    ...overrides,
  };
}

const SPEC = parse(
  readFileSync(resolve(CONTEXT_DIR, '../../../../../packages/contracts/openapi/content.yaml'), 'utf8'),
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

describe('content composition — register resolves every handler', () => {
  it('builds a module whose registry resolves every handler the OpenAPI document names', async () => {
    expect(DOCUMENT_HANDLER_NAMES.length).toBeGreaterThan(30);

    const moduleRef = await Test.createTestingModule({ imports: [register(validDeps())] }).compile();
    const registry = moduleRef.get<HandlerRegistry>(CONTENT_REGISTRY);

    const missing = DOCUMENT_HANDLER_NAMES.filter((name) => registry.get(name) === undefined);
    expect(missing).toEqual([]);
  });
});

describe('content composition — what the generation pipeline is admitted to (M5-40, ADR-0029)', () => {
  // Asserted as the set, against literals: a loop over the registry cannot notice a role being
  // admitted to one more handler. The pipeline may create a draft and put it into review, and
  // read the duplicate candidates for a proposal; every other content act stays a human's.
  it('admits generation_pipeline to exactly these handlers, and no others', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [register(validDeps())] }).compile();
    const registry = moduleRef.get<HandlerRegistry>(CONTENT_REGISTRY);

    const admitting = [...registry.names].filter((name) => registry.get(name)?.policy.allowedRoles.includes('generation_pipeline')).sort();
    expect(admitting).toEqual(['CreateItemDraft', 'GetDuplicateCandidatesForProposal', 'SubmitItemForReview']);
  });
});

describe('content composition — what the assessment context is admitted to (M6-14, M6-17)', () => {
  // The set, against literals: assessment may enumerate the published catalogue and read duplicate
  // candidates, and every other content act stays someone else's.
  it('admits system to exactly these handlers, and no others', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [register(validDeps())] }).compile();
    const registry = moduleRef.get<HandlerRegistry>(CONTENT_REGISTRY);
    const admitting = [...registry.names].filter((name) => registry.get(name)?.policy.allowedRoles.includes('system')).sort();
    expect(admitting).toEqual([
      'GetDuplicateCandidates',
      'GetPublishedItem',
      'GetPublishedSolution',
      'GetPublishedStimulus',
      'ListPublishedCatalogue',
    ]);
  });

  it('hands assessment the two handlers and nothing else', () => {
    const seam = contentForAssessment(validDeps());
    expect(Object.keys(seam).sort()).toEqual(['duplicates', 'listCatalogue']);
    expect(seam.listCatalogue.name).toBe('ListPublishedCatalogue');
    expect(seam.duplicates.name).toBe('GetDuplicateCandidates');
  });

  it('refuses a seam built from incomplete wiring, as register does', () => {
    const broken: { -readonly [K in keyof ContentCompositionDeps]?: ContentCompositionDeps[K] } = { ...validDeps() };
    delete broken.pool;
    expect(() => contentForAssessment(broken as ContentCompositionDeps)).toThrow(/pool/);
  });
});

/** Mutable, optional mirror of `ContentCompositionDeps` — for deleting a key to simulate a bypassed type check. */
type MutableDeps = { -readonly [K in keyof ContentCompositionDeps]?: ContentCompositionDeps[K] };

describe('content composition — missing a required dependency is refused, at the type level and at runtime', () => {
  it('refuses at runtime when a required key is absent, even reached through a cast', () => {
    const broken: MutableDeps = { ...validDeps() };
    delete broken.mediaStore;
    expect(() => register(broken as ContentCompositionDeps)).toThrow(/mediaStore/);
  });

  it('refuses at runtime for each required key, one at a time', () => {
    for (const key of ['pool', 'mediaStore', 'idempotency', 'clock', 'identifiers', 'audit', 'principals'] as const) {
      const broken: MutableDeps = { ...validDeps() };
      delete broken[key];
      expect(() => register(broken as ContentCompositionDeps), key).toThrow(key);
    }
  });

  it('does not reject a fully-supplied deps object', () => {
    expect(() => register(validDeps())).not.toThrow();
  });

  it('rejects a deps object missing MediaStore at the type level (compile-time check)', () => {
    // @ts-expect-error mediaStore is required by ContentCompositionDeps
    const incomplete: ContentCompositionDeps = { ...validDeps(), mediaStore: undefined };
    expect(incomplete).toBeDefined();
  });
});

describe('content composition — RenderValidator is the real production adapter, constructed inside the context', () => {
  it('register() constructs a real RenderValidatorAdapter rather than leaving renderer undefined', () => {
    // deps has nowhere to carry a renderer (it cannot, without a deep
    // cross-context import from platform/composition/ — DEC-M0-5). The
    // only way a lifecycle handler's `renderer` field is populated at all
    // is if this file constructs the real adapter itself.
    const code = readCode(resolve(CONTEXT_DIR, 'public/composition.ts'));
    expect(code).toContain('new RenderValidatorAdapter()');
    expect(code).toContain("from '../infrastructure/render-validator.adapter.js'");
  });

  it('a handler that needs RenderValidator resolves through the composed registry without deps naming it', async () => {
    const moduleRef = await Test.createTestingModule({ imports: [register(validDeps())] }).compile();
    const registry = moduleRef.get<HandlerRegistry>(CONTENT_REGISTRY);
    expect(registry.get('PublishItemVersion')).toBeDefined();
  });
});

/** The check M4-seam and every other barrel consumer depends on staying true. */
function importsComposition(source: string): boolean {
  return /from\s+['"]\.\/composition(\.js)?['"]/u.test(source);
}

describe('the public barrel does not import the composition module', () => {
  it('index.ts contains no import of composition.js', () => {
    const code = readCode(resolve(CONTEXT_DIR, 'public/index.ts'));
    expect(importsComposition(code)).toBe(false);
  });

  it('the check itself fires on a planted re-export, so a false pass is not silently possible', () => {
    const planted = `export * from './composition.js';\nexport type { Foo } from '../application/x.js';\n`;
    expect(importsComposition(planted)).toBe(true);
  });

  it('does not false-positive on an unrelated import mentioning "composition" in a comment', () => {
    const benign = `// this module has nothing to do with composition.js\nexport type { Foo } from '../application/x.js';\n`;
    expect(importsComposition(readCode(resolve(CONTEXT_DIR, 'public/index.ts')) + benign)).toBe(false);
  });
});
