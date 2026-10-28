import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { THRESHOLD_NAMES, checkNoThresholdLiteral } from './mastery-threshold-rules.js';
import { PLATFORM_THRESHOLDS_V2 } from '../testing/learning-thresholds.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = resolve(API_ROOT, '../..');

describe('M7-12 — D-002\'s thresholds have one source, the table', () => {
  it('finds no threshold literal in the shipped source of the learning context or the composition root', () => {
    expect(checkNoThresholdLiteral(WORKSPACE, ['apps/api/src/contexts/learning', 'apps/api/src/platform'])).toEqual([]);
  });

  it('names every value in the thresholds type: the set, so a value added without a name here fails', () => {
    const leaves = Object.values(PLATFORM_THRESHOLDS_V2).flatMap((group) => Object.keys(group));
    expect([...THRESHOLD_NAMES].sort()).toEqual([...leaves].sort());
  });

  it('reads the real tree: the learning context\'s own source is among what it scans', () => {
    const source = readFileSync(join(WORKSPACE, 'apps/api/src/contexts/learning/domain/mastery-rule-set.ts'), 'utf8');
    expect(source).toContain('minResponses');
  });

  describe('is red on a planted literal', () => {
    const fixtures = join(API_ROOT, 'src/fitness-fixtures');
    const scan = () => {
      // the fixtures directory is skipped by a real scan; point the scan at a root whose files are the fixtures
      return checkNoThresholdLiteral(join(fixtures, 'as-mastery-threshold', '..'), ['as-mastery-threshold']);
    };

    it('written as a property', () => {
      const found = checkNoThresholdLiteral(fixtures, ['as-mastery-threshold']);
      expect(found.filter((v) => v.file.endsWith('planted-property.ts')).map((v) => v.detail).sort()).toEqual(['minResponses: 8', 'recentWindow: 8']);
    });

    it('declared as a constant, with a fraction and in constant case', () => {
      const found = checkNoThresholdLiteral(fixtures, ['as-mastery-threshold']);
      expect(found.filter((v) => v.file.endsWith('planted-constant.ts')).map((v) => v.detail).sort()).toEqual(['IDLE_GAP_MINUTES = 30', 'MIN_RECENT_ACCURACY = 0.8']);
    });

    it('written for the pace and review values, which have names of their own', () => {
      const found = checkNoThresholdLiteral(fixtures, ['as-mastery-threshold']);
      expect(found.filter((v) => v.file.endsWith('planted-pace-and-review.ts')).map((v) => v.detail).sort()).toEqual(['escalateAtLapses: 3', 'passAccuracy: 0.8', 'slowAboveMs: 90000']);
    });

    it('but not when the value is read from a rule set', () => {
      expect(checkNoThresholdLiteral(fixtures, ['as-mastery-threshold']).filter((v) => v.file.endsWith('permitted-read.ts'))).toEqual([]);
    });

    it('and every violation is this rule\'s, naming the file', () => {
      const found = scan();
      expect(found.length).toBeGreaterThan(0);
      expect(found.every((v) => v.rule === 'M7_12_THRESHOLD_LITERAL')).toBe(true);
    });
  });
});
