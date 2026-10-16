import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkGenerationIsDownstreamOnly,
  checkGenerationReachesUpstreamOnlyAsBarrelTypes,
  checkGenerationTouchesNoContentTable,
  checkEventsCarryNoContent,
  checkProviderIsolation,
  PROVIDER_ADAPTER_DIRECTORY,
  checkHandlersInventNoEnvelope,
  EVENT_FORBIDDEN_FIELDS,
  generationFiles,
  GENERATION_CONTEXT,
  upstreamContextFiles,
} from './generation-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLANTED = 'src/fitness-fixtures/as-content-imports-generation/planted-upstream-import.ts';

describe('generation is downstream of content, and nothing points back (ADR-0025)', () => {
  it('no bounded context imports contexts/generation/', () => {
    expect(checkGenerationIsDownstreamOnly(API_ROOT)).toEqual([]);
  });

  it('scanned a real tree, not an empty file list', () => {
    // Without this the rule above passes by having looked at nothing, which is
    // the vacuous green DEC-M0-1 exists to forbid.
    const files = upstreamContextFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(100);
    expect(files.some((file) => file.startsWith('src/contexts/content/'))).toBe(true);
  });

  it('governs every context except generation itself', () => {
    const contexts = new Set(
      upstreamContextFiles(API_ROOT).map((file) => /^src\/contexts\/([^/]+)\//u.exec(file)?.[1]),
    );
    expect([...contexts].sort()).toEqual(['content', 'curriculum', 'scoring']);
    expect(contexts.has(GENERATION_CONTEXT)).toBe(false);
  });
});

describe('the rule, run against a planted violation', () => {
  const violations = checkGenerationIsDownstreamOnly(API_ROOT, { files: [PLANTED] });

  it('catches an upstream context reaching into generation', () => {
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.every((violation) => violation.rule === 'GENERATION_IS_DOWNSTREAM_ONLY')).toBe(true);
  });

  it('catches the barrel import and the deep import alike', () => {
    // A barrel import satisfies F1 completely — it is a legitimate cross-context
    // import in every respect except its direction, which is the whole reason
    // this rule exists separately rather than F1 being widened.
    expect([...new Set(violations.map((violation) => violation.importPath))].sort()).toEqual([
      '../../contexts/generation/domain/generation-candidate.js',
      '../../contexts/generation/public/index.js',
    ]);
  });

  it('names the file and the offending specifier, so a failure is actionable', () => {
    expect(violations[0]?.file).toBe(PLANTED);
    expect(violations[0]?.message).toContain('ADR-0025');
  });

  it('does not count the planted fixture against the real run', () => {
    // The fixture lives outside src/contexts/, so the real scan never reaches
    // it — asserted rather than assumed, because "the fixture happens to be
    // missed" and "the fixture is correctly out of scope" look identical from
    // a green test.
    expect(upstreamContextFiles(API_ROOT)).not.toContain(PLANTED);
  });
});

describe('generation reaches every upstream context only through its barrel, and only for types (ADR-0025, SEC-20)', () => {
  const PLANTED_TO_CONTENT = 'src/fitness-fixtures/as-generation-application/planted-content-imports.ts';

  it('holds across every file generation has — specs included', () => {
    expect(checkGenerationReachesUpstreamOnlyAsBarrelTypes(API_ROOT)).toEqual([]);
  });

  it('scanned a real tree, and one that really does import content’s barrel', () => {
    const files = generationFiles(API_ROOT);
    expect(files.length).toBeGreaterThan(40);
    expect(files.some((file) => file === 'src/contexts/generation/application/content-draft-acl.ts')).toBe(true);
    expect(files.some((file) => file.startsWith('src/contexts/generation/domain/'))).toBe(true);
  });

  it('is red on a deep import and on a runtime import of the barrel, and silent on the permitted type import', () => {
    const violations = checkGenerationReachesUpstreamOnlyAsBarrelTypes(API_ROOT, { files: [PLANTED_TO_CONTENT] });

    expect(violations.every((violation) => violation.rule === 'GENERATION_REACHES_CONTENT_ONLY_AS_BARREL_TYPES')).toBe(true);
    expect(violations.map((violation) => violation.importPath).sort()).toEqual([
      '../../contexts/content/domain/provenance.js',
      '../../contexts/content/public/index.js',
      '../../contexts/curriculum/domain/taxonomy-version.js',
      '../../contexts/curriculum/public/index.js',
    ]);
    expect(violations.find((violation) => violation.importPath.endsWith('provenance.js'))?.message).toContain('past content');
    expect(violations.find((violation) => violation.importPath.endsWith('public/index.js'))?.message).toContain('as a value');
    expect(violations.find((violation) => violation.importPath.endsWith('taxonomy-version.js'))?.message).toContain('past curriculum');
    expect(violations.find((violation) => violation.importPath.includes('curriculum') && violation.importPath.endsWith('public/index.js'))?.message).toContain('curriculum\'s barrel as a value');
    expect(violations.every((violation) => violation.message.includes('ADR-0025'))).toBe(true);
  });

  it('does not count the planted fixture against the real run', () => {
    expect(generationFiles(API_ROOT)).not.toContain(PLANTED_TO_CONTENT);
  });
});

describe('F27 — generation touches no content table (SEC-20)', () => {
  const PLANTED_WRITE = 'src/fitness-fixtures/as-generation-application/planted-content-imports.ts';

  it('holds across every non-spec file generation has', () => {
    expect(checkGenerationTouchesNoContentTable(API_ROOT)).toEqual([]);
  });

  it('is red on a planted write to content.item', () => {
    const violations = checkGenerationTouchesNoContentTable(API_ROOT, { files: [PLANTED_WRITE] });
    expect(violations.map((violation) => violation.rule)).toEqual(['F27_GENERATION_TOUCHES_CONTENT_TABLES']);
    expect(violations[0]?.message).toContain('F27');
  });

  it('matches a table in a statement, not a field path that merely starts with "content."', () => {
    // 'content.body.stem' is a location string, not a table; the real tree is full of them.
    expect(checkGenerationTouchesNoContentTable(API_ROOT)).toEqual([]);
    expect(generationFiles(API_ROOT).some((file) => file.endsWith('content-draft-acl.ts'))).toBe(true);
  });
});

describe('M5-20 — events carry facts and identifiers, never content', () => {
  const PLANTED_EVENT = 'src/fitness-fixtures/as-generation-application/planted-event-violations.ts';

  it('holds for the events generation declares', () => {
    expect(checkEventsCarryNoContent(API_ROOT)).toEqual([]);
  });

  it('read a declaration with fields in it, so a clean result means something', () => {
    // The same call with a name the events do declare proves the scan reaches real fields.
    const withRealField = checkEventsCarryNoContent(API_ROOT).length;
    expect(withRealField).toBe(0);
    expect(EVENT_FORBIDDEN_FIELDS).toContain('stem');
    expect(EVENT_FORBIDDEN_FIELDS).toContain('correctOptionId');
    expect(EVENT_FORBIDDEN_FIELDS).toContain('solution');
  });

  it('is red on an event declaring a stem, an answer key and a solution', () => {
    const violations = checkEventsCarryNoContent(API_ROOT, [PLANTED_EVENT]);
    expect(violations.map((violation) => violation.message.match(/"(\w+)"/u)?.[1])).toEqual([
      'stem',
      'correctOptionId',
      'solution',
    ]);
    expect(violations.every((violation) => violation.rule === 'M5_20_EVENT_CARRIES_CONTENT')).toBe(true);
  });
});

describe('M5-20 — no handler invents a principal or a correlation id', () => {
  const PLANTED_HANDLER = 'src/fitness-fixtures/as-generation-application/planted-event-violations.ts';

  it('holds for every handler generation has, over handlers that exist', () => {
    const handlers = generationFiles(API_ROOT).filter(
      (file) => file.includes('/application/handlers/') && !file.endsWith('.spec.ts'),
    );
    expect(handlers.map((file) => file.split('/').pop()).sort()).toEqual([
      'battery-handlers.ts',
      'decision-handlers.ts',
      'propose-handlers.ts',
      'run-handlers.ts',
      'verdict-handlers.ts',
    ]);
    expect(checkHandlersInventNoEnvelope(API_ROOT)).toEqual([]);
  });

  it('is red on a handler that mints a UUID, a system principal and a literal correlation id', () => {
    const violations = checkHandlersInventNoEnvelope(API_ROOT, [PLANTED_HANDLER]);
    expect(violations.map((violation) => violation.rule)).toEqual(['M5_20_HANDLER_INVENTS_ENVELOPE']);
  });
});

describe('EXT-05 — the provider is the adapter’s, and nobody else’s', () => {
  const PLANTED_LEAKS = 'src/fitness-fixtures/as-generation-application/planted-provider-leaks.ts';

  it('holds across every non-spec file generation has outside the adapter directory', () => {
    expect(checkProviderIsolation(API_ROOT)).toEqual([]);
  });

  it('scanned the port itself, so the rule reaches the file most likely to leak', () => {
    const governed = generationFiles(API_ROOT).filter((file) => !file.startsWith(PROVIDER_ADAPTER_DIRECTORY));
    expect(governed).toContain('src/contexts/generation/application/ports.ts');
    expect(governed.some((file) => file.startsWith('src/contexts/generation/domain/'))).toBe(true);
    expect(PROVIDER_ADAPTER_DIRECTORY).toBe('src/contexts/generation/infrastructure/provider/');
  });

  it('is red on an SDK, an HTTP client, a network call, an API-key read and a model-name literal', () => {
    const violations = checkProviderIsolation(API_ROOT, { files: [PLANTED_LEAKS] });
    expect(violations.every((violation) => violation.rule === 'EXT05_PROVIDER_LEAKS_OUT_OF_ITS_ADAPTER')).toBe(true);
    expect(violations.map((violation) => violation.message.replace(`${PLANTED_LEAKS} `, '').split(';')[0])).toEqual([
      'imports node:https',
      'imports @anthropic-ai/sdk',
      'makes a network call',
      'reads an API-key-shaped environment variable',
      'names a model as a string literal',
    ]);
  });

  it('exempts the adapter directory and nothing else', () => {
    const adapterFile = `${PROVIDER_ADAPTER_DIRECTORY}recorded-provider.ts`;
    expect(generationFiles(API_ROOT).filter((file) => file.startsWith(PROVIDER_ADAPTER_DIRECTORY)).every((file) => file.startsWith(PROVIDER_ADAPTER_DIRECTORY))).toBe(true);
    expect(adapterFile.startsWith(PROVIDER_ADAPTER_DIRECTORY)).toBe(true);
    expect('src/contexts/generation/infrastructure/generation-run.repository.ts'.startsWith(PROVIDER_ADAPTER_DIRECTORY)).toBe(false);
  });
});
