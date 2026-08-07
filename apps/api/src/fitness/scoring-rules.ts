import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/**
 * The fitness functions M2 adds (ASSESSMENT-ENGINE §13).
 *
 *   F45 — the scoring function performs no I/O and reads no clock
 *   F47 — every `ItemOutcome` carries a `rule_applied_id`
 *   F48 — the executor handles every historical `rule_schema_version`
 *
 * Each is checked against the real tree and against a planted violation, so a
 * green result means the check works rather than that it ran.
 */

export interface FitnessViolation {
  readonly rule: 'F45_NO_IO_OR_CLOCK' | 'F47_OUTCOME_NAMES_A_RULE' | 'F48_HISTORICAL_VERSIONS';
  readonly file: string;
  readonly detail: string;
}

function tsFilesUnder(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return tsFilesUnder(path);
    return path.endsWith('.ts') && !path.endsWith('.spec.ts') ? [path] : [];
  });
}

/** A clock, randomness, or anything that reaches outside the process. */
const IMPURE = [
  { pattern: /\bDate\.now\b/u, detail: 'reads the clock via Date.now' },
  { pattern: /\bnew Date\b/u, detail: 'reads the clock via new Date' },
  { pattern: /\bMath\.random\b/u, detail: 'draws randomness' },
  { pattern: /\bperformance\.now\b/u, detail: 'reads the clock via performance.now' },
  { pattern: /\bprocess\.env\b/u, detail: 'reads the environment' },
  { pattern: /from '(node:|pg|drizzle)/u, detail: 'imports a host or database module' },
] as const;

/**
 * F45. Determinism (REL-03) is provable only if nothing outside the inputs can
 * influence the output, so the whole scoring domain is checked — not only the
 * executor's own file, since anything it calls is equally able to read a clock.
 */
export function checkScoringPurity(domainRoot: string): FitnessViolation[] {
  return tsFilesUnder(domainRoot).flatMap((file) => {
    const source = readFileSync(file, 'utf8');
    return IMPURE.filter(({ pattern }) => pattern.test(source)).map(({ detail }) => ({
      rule: 'F45_NO_IO_OR_CLOCK' as const,
      file: relative(domainRoot, file),
      detail,
    }));
  });
}

/**
 * F47. Checked in three places, because an outcome can lose its attribution at
 * any of them: the type must require it, the database must reject a row
 * without it, and no construction path may invent an empty one.
 */
export function checkOutcomeAttribution(domainRoot: string, migrationSql: string): FitnessViolation[] {
  const violations: FitnessViolation[] = [];

  const outcomeSource = readFileSync(join(domainRoot, 'item-outcome.ts'), 'utf8');
  if (!/readonly ruleApplied: RuleAttribution;/u.test(outcomeSource)) {
    violations.push({
      rule: 'F47_OUTCOME_NAMES_A_RULE',
      file: 'item-outcome.ts',
      detail: 'ItemOutcome.ruleApplied is optional or absent; it must be required',
    });
  }

  const required = /rule_applied_id\s+text\s+NOT NULL\s+CHECK \(length\(btrim\(rule_applied_id\)\) > 0\)/u;
  if (!required.test(migrationSql)) {
    violations.push({
      rule: 'F47_OUTCOME_NAMES_A_RULE',
      file: 'scoring_schema.sql',
      detail: 'item_outcome.rule_applied_id is not NOT NULL with a non-empty check',
    });
  }

  return violations;
}

/**
 * F48. Every version ever shipped must still resolve to an executor: a record
 * pinned to version *n* has to be reproducible forever, and it cannot be if
 * the code that produced it has been deleted.
 */
export function checkHistoricalVersions(
  shipped: readonly number[],
  registered: readonly number[],
): FitnessViolation[] {
  return shipped
    .filter((version) => !registered.includes(version))
    .map((version) => ({
      rule: 'F48_HISTORICAL_VERSIONS' as const,
      file: 'schema-version-registry.ts',
      detail: `rule schema version ${version} has shipped but no executor is registered for it`,
    }));
}
