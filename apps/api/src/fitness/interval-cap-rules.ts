import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * The time-on-item interval cap has one source (M6-37): `timeOnItemIntervalCapMs` in configuration, pinned onto each
 * attempt when it is created and told to the device. A device and the server that each carry a guess project one log to two
 * answers, and `timeOnItemMs` is psychometric data — so a literal value for the cap, written anywhere a cap is passed, is
 * the defect coming back.
 *
 * The rule: no source file assigns a numeric literal to a name ending `intervalCapMs` (a property, a variable), or declares
 * a `*INTERVAL_CAP_MS` constant, outside the two places allowed to — configuration, which defines the value, and the
 * attempt engine, whose own tests exercise the cap as the parameter it is. Specs are scanned: the four literals the tree
 * carried before this rule were all in specs.
 */
export interface IntervalCapViolation {
  readonly rule: 'M6_37_INTERVAL_CAP_LITERAL';
  readonly file: string;
  readonly detail: string;
}

const LITERAL_CAP = /\b\w*[iI]ntervalCapMs\s*[:=]\s*-?\d[\d_.]*\b/gu;
const LITERAL_CONSTANT = /\b[A-Z0-9_]*INTERVAL_CAP_MS\s*=\s*-?\d[\d_.]*\b/gu;

/** Where a literal cap may be written, and why. */
export const INTERVAL_CAP_LITERAL_ALLOWED: Readonly<Record<string, string>> = {
  'apps/api/src/platform/config/config.ts': 'defines the one value',
};
/** Directory prefixes exempt as a whole. */
export const INTERVAL_CAP_EXEMPT_PREFIXES: readonly string[] = ['packages/attempt-engine/'];

const SKIPPED = ['node_modules', 'coverage', 'dist', 'fitness-fixtures'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

export function checkNoIntervalCapLiteral(
  workspaceRoot: string,
  roots: readonly string[],
  options: { readonly allowed?: Readonly<Record<string, string>>; readonly exemptPrefixes?: readonly string[] } = {},
): IntervalCapViolation[] {
  const allowed = options.allowed ?? INTERVAL_CAP_LITERAL_ALLOWED;
  const exempt = options.exemptPrefixes ?? INTERVAL_CAP_EXEMPT_PREFIXES;
  const violations: IntervalCapViolation[] = [];
  for (const root of roots) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      const file = relative(workspaceRoot, path).replaceAll('\\', '/');
      if (allowed[file] !== undefined || exempt.some((prefix) => file.startsWith(prefix))) continue;
      const code = readCode(path);
      for (const pattern of [LITERAL_CAP, LITERAL_CONSTANT]) {
        for (const match of code.matchAll(pattern)) violations.push({ rule: 'M6_37_INTERVAL_CAP_LITERAL', file, detail: match[0] });
      }
    }
  }
  return violations;
}
