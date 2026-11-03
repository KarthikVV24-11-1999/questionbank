import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SCOPE_READERS, assessmentFiles, checkScopeReaders } from './scope-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PLANTED = 'src/fitness-fixtures/as-assessment-reads-scope/planted-mock-reads-scope.ts';

describe('a declared scope is read by practice and nothing else in Assessment (M8-21, ADR-0060)', () => {
  it('the real tree has no other reader', () => {
    expect(checkScopeReaders(API_ROOT)).toEqual([]);
  });

  it('scanned a real tree, and every allowed reader exists and does name the scope', () => {
    const files = assessmentFiles(API_ROOT);
    expect(files.filter((file) => file.includes('attempt-handlers')).length).toBeGreaterThan(0);
    expect(files.length).toBeGreaterThan(30);
    for (const reader of SCOPE_READERS) expect(files, reader).toContain(reader);
    expect(files).not.toContain(PLANTED);
    // with nobody allowed, the five that carry the scope are found: the allowlist is not hiding an empty scan
    const unallowed = checkScopeReaders(API_ROOT, { allowed: [] });
    expect(new Set(unallowed.map((v) => v.file))).toEqual(new Set(SCOPE_READERS));
  });

  it('a file on the mock\'s path that takes the scope source fails', () => {
    const found = checkScopeReaders(API_ROOT, { files: [PLANTED] });
    expect(found.map((v) => [v.rule, v.name]).sort()).toEqual([['SCOPE_OUTSIDE_PRACTICE', 'LearnerScopeSource'], ['SCOPE_OUTSIDE_PRACTICE', 'conceptsInScope']].sort());
    expect(found[0]?.file).toBe(PLANTED);
    expect(found[0]?.message).toContain('ADR-0060');
  });
});
