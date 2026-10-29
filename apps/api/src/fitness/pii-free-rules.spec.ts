import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { PII_FREE_SURFACES, checkPiiFreeIndex, parsePiiFreeTable } from './pii-free-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOCUMENT = readFileSync(resolve(ROOT, 'docs/PII-FREE.md'), 'utf8');
const FILE = 'apps/api/src/fitness/pii-free-rules.spec.ts';
const row = (surface: string, file: string, absent: string, scan: string) => `| \`${surface}\` | \`${file}\` :: ${absent} | \`${file}\` :: ${scan} |`;

describe('the PII-free argument (EVENT-TAXONOMY §1 rule 1)', () => {
  it('has a row for every surface, and every row points at tests that exist and run', () => {
    expect(parsePiiFreeTable(DOCUMENT).map((r) => r.surface)).toEqual([...PII_FREE_SURFACES]);
    expect(checkPiiFreeIndex(ROOT, DOCUMENT)).toEqual([]);
  });

  describe('is red on a planted violation', () => {
    it('a surface with no row', () => {
      const without = DOCUMENT.split('\n').filter((line) => !line.startsWith('| `quarantine`')).join('\n');
      expect(checkPiiFreeIndex(ROOT, without).map((v) => [v.rule, v.surface])).toEqual([['PII_FREE_SURFACE_MISSING', 'quarantine']]);
    });

    it('a test renamed away, and a file that is gone', () => {
      const document = [row('envelope', FILE, `a test that is ${'not'} there`, `another that is ${'not'} there`), row('quarantine', 'apps/api/src/no-such-file.spec.ts', 'x', 'y')].join('\n');
      expect(checkPiiFreeIndex(ROOT, document, ['envelope', 'quarantine']).map((v) => v.rule).sort()).toEqual(['EVIDENCE_FILE_MISSING', 'EVIDENCE_FILE_MISSING', 'EVIDENCE_TEST_MISSING', 'EVIDENCE_TEST_MISSING']);
    });

    it('a named test that is skipped', () => {
      const document = row('envelope', 'apps/api/src/fitness-fixtures/as-skipped-test/it-skip.ts', 'planted: serves nothing it should not', 'planted: serves nothing it should not');
      expect(checkPiiFreeIndex(ROOT, document, ['envelope']).map((v) => v.rule).filter((rule) => rule.startsWith('EVIDENCE'))).toEqual(['EVIDENCE_TEST_SKIPPED', 'EVIDENCE_TEST_SKIPPED']);
    });

    it('a row for a surface nobody listed', () => {
      expect(checkPiiFreeIndex(ROOT, row('somewhere-new', FILE, 'a surface with no row', 'a test renamed away, and a file that is gone'), []).map((v) => v.rule)).toEqual(['PII_FREE_SURFACE_UNKNOWN']);
    });

    it('one test claimed for both halves of a row', () => {
      expect(checkPiiFreeIndex(ROOT, row('envelope', FILE, 'a surface with no row', 'a surface with no row'), ['envelope']).map((v) => v.rule)).toEqual(['PII_FREE_ONE_TEST_FOR_BOTH']);
    });

    it('and a row whose evidence is real passes', () => {
      expect(checkPiiFreeIndex(ROOT, row('envelope', FILE, 'a surface with no row', 'a test renamed away, and a file that is gone'), ['envelope'])).toEqual([]);
    });
  });
});
