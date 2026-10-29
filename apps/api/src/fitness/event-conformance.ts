import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AnalyticsEdge, type QuarantineReason } from '../platform/analytics/edge.js';
import { MemorySink } from '../platform/analytics/sink.js';
import { checkEvidence, parseEvidenceCell, type EvidenceRef, type EvidenceViolation } from './evidence-table.js';
import type { CatalogEvent } from './event-catalog.js';

/**
 * Envelope conformance (M7-63): of the events emitted, the fraction the real ingestion edge admits — a complete valid envelope, a catalog name, no personal data.
 * The events are the caller's: in the measurement they are what a run of the suites emitted (the log `event-log.ts` describes), replayed here through a fresh edge, so the denominator is
 * a count of events that happened and not a count of emitters. A duplicate is the same fact sent twice and is not a failure (DEC-M7-38).
 *
 * What the table cannot be made of: events owned by no milestone (D89), by a milestone that is past and emitted nothing (D91), and the events M7 owns with no call site (D92).
 */
export interface Conformance {
  readonly total: number;
  readonly conforming: number;
  readonly byReason: Readonly<Record<QuarantineReason, number>>;
  readonly byEvent: Readonly<Record<string, { readonly emitted: number; readonly conforming: number }>>;
}

export async function measureConformance(events: readonly unknown[]): Promise<Conformance> {
  const edge = new AnalyticsEdge(new MemorySink(), () => new Date('2026-10-29T12:00:00.000Z'));
  const byEvent: Record<string, { emitted: number; conforming: number }> = {};
  let conforming = 0;
  for (const event of events) {
    const name = typeof event === 'object' && event !== null && typeof (event as { event_name?: unknown }).event_name === 'string' ? (event as { event_name: string }).event_name : '(no name)';
    const tally = (byEvent[name] ??= { emitted: 0, conforming: 0 });
    tally.emitted += 1;
    const admission = await edge.admit(event);
    if (admission.outcome === 'accepted' || admission.outcome === 'duplicate') {
      conforming += 1;
      tally.conforming += 1;
    }
  }
  return { total: events.length, conforming, byReason: edge.stats().quarantined, byEvent };
}

export function readEventLog(contents: string): Array<{ source: string; event: unknown }> {
  return contents.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as { source: string; event: unknown });
}

const SKIPPED_DIRECTORIES = ['node_modules', 'coverage', 'dist', 'testing', 'fitness', 'fitness-fixtures'];

/**
 * The catalog names that appear in an emit position (`emit('…'` or `name: '…'`) in the shipped source of the given roots — where an event is emitted from. Specs, test support and the fitness
 * functions are not source that emits anything, and the contracts package (which lists every name) is not a root.
 */
export function emittedNamesIn(roots: readonly string[], catalog: readonly CatalogEvent[]): string[] {
  const names = new Set(catalog.map((event) => event.name));
  const found = new Set<string>();
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory)) {
      if (SKIPPED_DIRECTORIES.includes(entry)) continue;
      const path = join(directory, entry);
      if (statSync(path).isDirectory()) visit(path);
      else if (/\.tsx?$/u.test(entry) && !/\.(spec|d)\.tsx?$/u.test(entry)) for (const match of readFileSync(path, 'utf8').matchAll(/(?:\bemit\(\s*|\bname:\s*)'([a-z_]+\.[a-z_]+)'/gu)) if (names.has(match[1]!)) found.add(match[1]!);
    }
  };
  for (const root of roots) visit(root);
  return [...found].sort();
}

export interface ConformanceRow {
  readonly event: string;
  readonly wired: boolean;
  readonly emitted: EvidenceRef | null;
  readonly canFail: EvidenceRef | null;
  readonly reason: string;
}

/** `| \`event\` | wired | file :: title | file :: title | — |` or `| \`event\` | not wired | — | — | why, and who owns it |`. */
export function parseConformanceTable(document: string): ConformanceRow[] {
  const rows: ConformanceRow[] = [];
  for (const line of document.split('\n')) {
    const cells = line.split('|').map((cell) => cell.trim());
    if (cells.length !== 7 || !cells[1]!.startsWith('`')) continue;
    const event = /^`([^`]+)`/u.exec(cells[1]!)?.[1];
    if (event === undefined) continue;
    rows.push({ event, wired: cells[2] === 'wired', emitted: parseEvidenceCell(cells[3]!), canFail: parseEvidenceCell(cells[4]!), reason: cells[5]! });
  }
  return rows;
}

export interface ConformanceViolation {
  readonly rule: 'EVENT_ROW_MISSING' | 'EVENT_ROW_UNKNOWN' | 'WIRED_WITHOUT_BOTH_TESTS' | 'NOT_WIRED_WITHOUT_REASON' | 'EMITTED_BUT_NOT_WIRED_IN_TABLE' | 'WIRED_IN_TABLE_BUT_NOT_EMITTED' | 'ONE_TEST_FOR_BOTH' | EvidenceViolation['rule'];
  readonly event: string;
  readonly detail: string;
}

/**
 * The table has a row for every event M7 owns and no other; a wired row names the test that shows it emitted with a conforming envelope and the test that shows the
 * check able to fail, both of which exist and run; a row that is not wired says why. And the table is held to the code: an event whose name is emitted from shipped
 * source is a wired row, and a wired row is an event that is emitted.
 */
export function checkConformanceIndex(repoRoot: string, document: string, owned: readonly string[], emitted: readonly string[]): ConformanceViolation[] {
  const rows = parseConformanceTable(document);
  const violations: ConformanceViolation[] = [];
  for (const event of owned) if (!rows.some((row) => row.event === event)) violations.push({ rule: 'EVENT_ROW_MISSING', event, detail: 'M7 owns it and no row says what became of it' });
  for (const row of rows) {
    if (!owned.includes(row.event)) violations.push({ rule: 'EVENT_ROW_UNKNOWN', event: row.event, detail: 'a row for an event M7 does not own' });
    if (row.wired) {
      if (row.emitted === null || row.canFail === null) {
        violations.push({ rule: 'WIRED_WITHOUT_BOTH_TESTS', event: row.event, detail: 'a wired event names the test that shows it emitted and the test that shows the check able to fail' });
        continue;
      }
      if (row.emitted.file === row.canFail.file && row.emitted.title === row.canFail.title) violations.push({ rule: 'ONE_TEST_FOR_BOTH', event: row.event, detail: row.emitted.title });
      for (const found of checkEvidence(repoRoot, row.event, [row.emitted, row.canFail])) violations.push({ rule: found.rule, event: row.event, detail: found.detail });
      if (!emitted.includes(row.event)) violations.push({ rule: 'WIRED_IN_TABLE_BUT_NOT_EMITTED', event: row.event, detail: 'no shipped source emits this name' });
    } else {
      if (row.reason === '' || row.reason === '—') violations.push({ rule: 'NOT_WIRED_WITHOUT_REASON', event: row.event, detail: 'say why, and which milestone or debt holds it' });
      if (emitted.includes(row.event)) violations.push({ rule: 'EMITTED_BUT_NOT_WIRED_IN_TABLE', event: row.event, detail: 'shipped source emits this name and the row says it is not wired' });
    }
  }
  return violations;
}
