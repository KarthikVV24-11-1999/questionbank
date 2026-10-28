import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * D-002's thresholds have one source: the `learning.mastery_rule_set` table (M7-12). DECISIONS D-002 says they are tunable per exam and DOMAIN-MODEL
 * 12.2 says they are configuration, not code; a literal for one of them in production source is a second copy that will drift from the table, and a
 * transition decided under a value the table never held.
 *
 * The rule: no production file assigns a numeric literal to a threshold name (a property, a variable), or declares a constant named for one. There is no
 * allowed file, unlike the interval cap: the values are *data*, and the migration that seeds the platform default is SQL. Specs are not scanned, because a
 * spec must build a scenario with a threshold of its own; they state their numbers in `src/testing/learning-thresholds.ts`, which a spec holds to the
 * seeded row.
 */
export interface MasteryThresholdViolation {
  readonly rule: 'M7_12_THRESHOLD_LITERAL';
  readonly file: string;
  readonly detail: string;
}

/** Every value in `MasteryThresholds`. Derived from the type by `mastery-threshold-rules.spec.ts`, so a new one cannot escape the rule. */
export const THRESHOLD_NAMES = [
  'minResponses',
  'minDistinctItems',
  'minDistinctSessions',
  'recentWindow',
  'minRecentAccuracy',
  'minRecentAtDemonstratedBand',
  'minVerifyingResponses',
  'minGapHours',
  'idleGapMinutes',
  'weakBelowAccuracy',
  'halfLifeDays',
  'confidenceFloor',
  'slowAboveMs',
  'passAccuracy',
  'firstIntervalDays',
  'growthFactor',
  'lapseFactor',
  'minIntervalDays',
  'maxIntervalDays',
  'escalateAtLapses',
] as const;

const toConstantCase = (name: string): string => name.replace(/([a-z0-9])([A-Z])/gu, '$1_$2').toUpperCase();

const LITERAL_PROPERTY = new RegExp(`\\b(?:${THRESHOLD_NAMES.join('|')})\\s*[:=]\\s*-?\\d[\\d_.]*\\b`, 'gu');
const LITERAL_CONSTANT = new RegExp(`\\b[A-Z0-9_]*(?:${THRESHOLD_NAMES.map(toConstantCase).join('|')})\\s*=\\s*-?\\d[\\d_.]*\\b`, 'gu');

const SKIPPED = ['node_modules', 'coverage', 'dist', 'fitness-fixtures'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !entry.endsWith('.d.ts') && !/\.spec\.tsx?$/u.test(entry) ? [path] : [];
  });
}

export function checkNoThresholdLiteral(workspaceRoot: string, roots: readonly string[]): MasteryThresholdViolation[] {
  const violations: MasteryThresholdViolation[] = [];
  for (const root of roots) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      const file = relative(workspaceRoot, path).replaceAll('\\', '/');
      const code = readCode(path);
      for (const pattern of [LITERAL_PROPERTY, LITERAL_CONSTANT]) {
        for (const match of code.matchAll(pattern)) violations.push({ rule: 'M7_12_THRESHOLD_LITERAL', file, detail: match[0] });
      }
    }
  }
  return violations;
}
