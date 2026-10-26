import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { KEY_FREE_SURFACES, checkKeyFreeIndex, parseKeyFreeTable } from './key-free-rules.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const DOCUMENT = readFileSync(resolve(ROOT, 'docs/KEY-FREE.md'), 'utf8');

/**
 * M6-59: the key-free argument has one home, and the home is read. The two halves of it — the key is absent, and the scan could have seen
 * it — are named by file and by test title for every surface a learner can receive something from.
 */
describe('the key-free argument (M6-59, F6/F35)', () => {
  it('has a row for every surface, and every row points at a test that exists', () => {
    const rows = parseKeyFreeTable(DOCUMENT);
    expect(rows.map((row) => row.surface)).toEqual([...KEY_FREE_SURFACES]); // the set, in the order the argument is told
    expect(checkKeyFreeIndex(ROOT, DOCUMENT)).toEqual([]);
  });

  it('names a different test for absence and for vacuity on every row but the ones whose one test is both', () => {
    const same = parseKeyFreeTable(DOCUMENT).filter((row) => row.absent.file === row.scan.file && row.absent.title === row.scan.title);
    expect(same).toEqual([]);
  });

  describe('is red on a planted violation', () => {
    const row = (surface: string, file: string, title: string, scanTitle = title) => `| \`${surface}\` | \`${file}\` :: ${title} | \`${file}\` :: ${scanTitle} |`;
    const FILE = 'apps/api/src/fitness/key-free-rules.spec.ts';

    it('a surface with no row', () => {
      const without = DOCUMENT.split('\n').filter((line) => !line.startsWith('| `relay-payloads`')).join('\n');
      expect(checkKeyFreeIndex(ROOT, without).map((violation) => [violation.rule, violation.surface])).toEqual([['KEY_FREE_SURFACE_MISSING', 'relay-payloads']]);
    });

    it('a test renamed away, and a file that is gone', () => {
      const document = [row('result', FILE, `a test that is ${'not'} there`), row('contract', 'apps/api/src/no-such-file.spec.ts', 'x')].join('\n');
      const violations = checkKeyFreeIndex(ROOT, document, ['result', 'contract']);
      expect(violations.map((violation) => violation.rule).sort()).toEqual(['KEY_FREE_EVIDENCE_FILE_MISSING', 'KEY_FREE_EVIDENCE_FILE_MISSING', 'KEY_FREE_EVIDENCE_TEST_MISSING', 'KEY_FREE_EVIDENCE_TEST_MISSING']);
    });

    it('a row for a surface nobody listed', () => {
      expect(checkKeyFreeIndex(ROOT, row('somewhere-new', FILE, 'is red on a planted violation'), []).map((violation) => violation.rule)).toEqual(['KEY_FREE_SURFACE_UNKNOWN']);
    });

    it('and a row whose evidence is real passes', () => {
      expect(checkKeyFreeIndex(ROOT, row('result', FILE, 'a surface with no row', 'a test renamed away, and a file that is gone'), ['result'])).toEqual([]);
    });
  });
});
