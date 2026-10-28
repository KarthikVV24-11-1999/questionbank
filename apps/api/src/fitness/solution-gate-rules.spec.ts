import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { RELEASE_MAKERS, SOLUTION_FETCHERS, checkSolutionGate } from './solution-gate-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = resolve(API_ROOT, '../..');

describe('M7-36 — the effort gate cannot be walked around', () => {
  it('finds a ReleasedSlot made only where the gate makes it and a solution fetched only by the handler that asked', () => {
    expect(checkSolutionGate(WORKSPACE, ['apps/api/src'])).toEqual([]);
  });

  it('names files that exist, as sets, so a rename cannot leave the rule guarding nothing', () => {
    expect([...RELEASE_MAKERS].sort()).toEqual([
      'apps/api/src/contexts/assessment/domain/solution-release.ts',
      'apps/api/src/contexts/assessment/infrastructure/solution-release.repository.ts',
    ]);
    expect([...SOLUTION_FETCHERS]).toEqual(['apps/api/src/contexts/assessment/application/handlers/slot-solution-handler.ts']);
    for (const file of [...RELEASE_MAKERS, ...SOLUTION_FETCHERS]) expect(existsSync(join(WORKSPACE, file)), file).toBe(true);
  });

  describe('is red on a planted violation', () => {
    const fixtures = join(API_ROOT, 'src/fitness-fixtures');
    const run = (file: string) => checkSolutionGate(fixtures, ['as-solution-gate'], { makers: [], fetchers: [], production: () => true }).filter((v) => v.file.endsWith(file));

    it('a second place that makes a ReleasedSlot', () => {
      expect(run('planted-forged-release.ts')).toEqual([expect.objectContaining({ rule: 'SOLUTION_RELEASE_FORGED' })]);
    });

    it('a caller that fetches a solution without the handler', () => {
      expect(run('planted-ungated-fetch.ts')).toEqual([expect.objectContaining({ rule: 'SOLUTION_FETCHED_OUTSIDE_THE_GATE' })]);
    });

    it('but not a file that only names them in a comment or a string', () => {
      expect(run('permitted-gated-fetch.ts')).toEqual([]);
    });
  });
});
