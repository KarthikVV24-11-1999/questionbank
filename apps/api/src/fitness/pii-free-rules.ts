import { checkEvidence, parseEvidenceCell, type EvidenceRef, type EvidenceViolation } from './evidence-table.js';

/**
 * The PII-free argument is one table in `docs/PII-FREE.md` (M7-61), read the way `KEY-FREE.md` is: every surface an analytics event can carry personal data on is a row,
 * and each row names a test that shows it absent and a test that shows the scan able to find some. A surface dropped, a test renamed away or skipped, or a row that
 * points both claims at one test is a violation.
 */
export const PII_FREE_SURFACES = ['catalog-fields', 'envelope', 'server-events', 'learner-events', 'edge-accepted', 'quarantine'] as const;

export interface PiiFreeViolation {
  readonly rule: 'PII_FREE_SURFACE_MISSING' | 'PII_FREE_SURFACE_UNKNOWN' | 'PII_FREE_ONE_TEST_FOR_BOTH' | EvidenceViolation['rule'];
  readonly surface: string;
  readonly detail: string;
}

export interface PiiFreeRow {
  readonly surface: string;
  readonly absent: EvidenceRef;
  readonly scan: EvidenceRef;
}

export function parsePiiFreeTable(document: string): PiiFreeRow[] {
  const rows: PiiFreeRow[] = [];
  for (const line of document.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length !== 5 || !cells[1]!.startsWith('`')) continue;
    const surface = /^`([^`]+)`/u.exec(cells[1]!)?.[1];
    const absent = parseEvidenceCell(cells[2]!);
    const scan = parseEvidenceCell(cells[3]!);
    if (surface !== undefined && absent !== null && scan !== null) rows.push({ surface, absent, scan });
  }
  return rows;
}

export function checkPiiFreeIndex(repoRoot: string, document: string, surfaces: readonly string[] = PII_FREE_SURFACES): PiiFreeViolation[] {
  const rows = parsePiiFreeTable(document);
  const violations: PiiFreeViolation[] = [];
  for (const surface of surfaces) if (!rows.some((row) => row.surface === surface)) violations.push({ rule: 'PII_FREE_SURFACE_MISSING', surface, detail: 'no row' });
  for (const row of rows) {
    if (!surfaces.includes(row.surface)) violations.push({ rule: 'PII_FREE_SURFACE_UNKNOWN', surface: row.surface, detail: 'a row for a surface that is not on the list' });
    if (row.absent.file === row.scan.file && row.absent.title === row.scan.title) violations.push({ rule: 'PII_FREE_ONE_TEST_FOR_BOTH', surface: row.surface, detail: row.absent.title });
    for (const found of checkEvidence(repoRoot, row.surface, [row.absent, row.scan])) violations.push({ rule: found.rule, surface: row.surface, detail: found.detail });
  }
  return violations;
}
