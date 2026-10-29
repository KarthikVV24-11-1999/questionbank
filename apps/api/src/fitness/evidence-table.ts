import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { locateTest } from './test-locator.js';

/**
 * What the argument documents that are tables a test reads have in common (`KEY-FREE.md`, `PII-FREE.md`, `EVENT-CONFORMANCE.md`): a cell that names a test by file and
 * by title, and a check that the test is there and **runs** (`test-locator.ts`). A file that is gone, a test renamed away, or one under a skip is a violation.
 */
export interface EvidenceRef {
  readonly file: string;
  readonly title: string;
}

export interface EvidenceViolation {
  readonly rule: 'EVIDENCE_FILE_MISSING' | 'EVIDENCE_TEST_MISSING' | 'EVIDENCE_TEST_SKIPPED';
  readonly row: string;
  readonly detail: string;
}

const CELL = /^`?([^`]+?)`?\s*::\s*(.+)$/u;

/** `file :: title`, with the file optionally in backticks; `null` for a cell that names no test. */
export function parseEvidenceCell(cell: string): EvidenceRef | null {
  const match = CELL.exec(cell.trim());
  return match === null ? null : { file: match[1]!.trim(), title: match[2]!.trim() };
}

export function checkEvidence(repoRoot: string, row: string, refs: readonly EvidenceRef[]): EvidenceViolation[] {
  const violations: EvidenceViolation[] = [];
  for (const ref of refs) {
    const path = join(repoRoot, ref.file);
    if (!existsSync(path)) {
      violations.push({ rule: 'EVIDENCE_FILE_MISSING', row, detail: ref.file });
      continue;
    }
    const located = locateTest(readFileSync(path, 'utf8'), ref.title, ref.file);
    if (!located.found) violations.push({ rule: 'EVIDENCE_TEST_MISSING', row, detail: `${ref.file} :: ${ref.title}` });
    else if (!located.runs) violations.push({ rule: 'EVIDENCE_TEST_SKIPPED', row, detail: `${ref.file} :: ${ref.title} does not run: ${located.because}` });
  }
  return violations;
}
