import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkGenerationIsDownstreamOnly,
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
