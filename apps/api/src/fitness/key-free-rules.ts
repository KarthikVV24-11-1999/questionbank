import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locateTest } from './test-locator.js';

/**
 * The key-free argument is one table in `docs/KEY-FREE.md` (M6-59), and a table of claims is only worth reading while it still points at
 * something. This reads it: every surface the argument must cover is a row, and each row names two tests — one that shows the key
 * absent and one that shows the scan able to find a key — by file and by title. A file that is gone, a test renamed away, a surface
 * dropped, or a row that points its two claims at one and the same test with nothing about vacuity in it, is a violation.
 *
 * **A test that is named must be a test that runs** (M7-17). The first version checked that the title was *in the file*, and `describe.skip` leaves every
 * title where it was: the gate passed on the attempt-responses row while neither of its two tests ran (D73). The file is now parsed (`test-locator.ts`) and a
 * title under a skip, a todo, a conditional, or silenced by a `.only` elsewhere is its own violation, with the form that stopped it.
 */
export interface KeyFreeViolation {
  readonly rule: 'KEY_FREE_SURFACE_MISSING' | 'KEY_FREE_EVIDENCE_FILE_MISSING' | 'KEY_FREE_EVIDENCE_TEST_MISSING' | 'KEY_FREE_EVIDENCE_TEST_SKIPPED' | 'KEY_FREE_SURFACE_UNKNOWN';
  readonly surface: string;
  readonly detail: string;
}

/** Every surface a learner can receive something from. Adding a surface to the product adds it here, and the document fails until it has a row. */
export const KEY_FREE_SURFACES = [
  'code-boundary',
  'package-code',
  'catalogue-responses',
  'contract',
  'form-package',
  'form-routes',
  'attempt-responses',
  'practice-feedback',
  'result',
  'relay-payloads',
  'learner-screens',
  'learner-device',
] as const;

export interface KeyFreeRow {
  readonly surface: string;
  readonly absent: { readonly file: string; readonly title: string };
  readonly scan: { readonly file: string; readonly title: string };
}

const CELL = /^`?([^`]+?)`?\s*::\s*(.+)$/u;

export function parseKeyFreeTable(document: string): KeyFreeRow[] {
  const rows: KeyFreeRow[] = [];
  for (const line of document.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length !== 5 || !cells[1]!.startsWith('`')) continue;
    const surface = /^`([^`]+)`/u.exec(cells[1]!)?.[1];
    const absent = CELL.exec(cells[2]!);
    const scan = CELL.exec(cells[3]!);
    if (surface === undefined || absent === null || scan === null) continue;
    rows.push({ surface, absent: { file: absent[1]!.trim(), title: absent[2]!.trim() }, scan: { file: scan[1]!.trim(), title: scan[2]!.trim() } });
  }
  return rows;
}

export function checkKeyFreeIndex(repoRoot: string, document: string, surfaces: readonly string[] = KEY_FREE_SURFACES): KeyFreeViolation[] {
  const rows = parseKeyFreeTable(document);
  const violations: KeyFreeViolation[] = [];
  for (const surface of surfaces) {
    if (!rows.some((row) => row.surface === surface)) violations.push({ rule: 'KEY_FREE_SURFACE_MISSING', surface, detail: 'no row' });
  }
  for (const row of rows) {
    if (!surfaces.includes(row.surface)) violations.push({ rule: 'KEY_FREE_SURFACE_UNKNOWN', surface: row.surface, detail: 'a row for a surface that is not on the list' });
    for (const evidence of [row.absent, row.scan]) {
      const path = join(repoRoot, evidence.file);
      if (!existsSync(path)) {
        violations.push({ rule: 'KEY_FREE_EVIDENCE_FILE_MISSING', surface: row.surface, detail: evidence.file });
        continue;
      }
      const located = locateTest(readFileSync(path, 'utf8'), evidence.title, evidence.file);
      if (!located.found) violations.push({ rule: 'KEY_FREE_EVIDENCE_TEST_MISSING', surface: row.surface, detail: `${evidence.file} :: ${evidence.title}` });
      else if (!located.runs) violations.push({ rule: 'KEY_FREE_EVIDENCE_TEST_SKIPPED', surface: row.surface, detail: `${evidence.file} :: ${evidence.title} does not run: ${located.because}` });
    }
  }
  return violations;
}
