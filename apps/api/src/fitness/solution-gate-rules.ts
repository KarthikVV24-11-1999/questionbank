import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * The effort gate cannot be walked around (FRS 277, M7-36). A solution is fetched with a `ReleasedSlot`, a branded type that only the repository over the database's
 * `solution_release` view makes. The type stops a caller from passing an id it has; this rule stops the other two ways round: making a `ReleasedSlot` anywhere else, and
 * calling the solution source anywhere but the handler that has asked the gate first.
 *
 *  - `SOLUTION_RELEASE_FORGED` — a production file other than the definition and the repository calls `makeReleasedSlot(`.
 *  - `SOLUTION_FETCHED_OUTSIDE_THE_GATE` — a production file other than the solution handler calls `.solutionFor(`.
 *
 * Production means not a spec and not under `testing/`: the in-memory release source tests use is where a test makes a `ReleasedSlot`, and it is a fake of the gate and not a second gate.
 */
export interface SolutionGateViolation {
  readonly rule: 'SOLUTION_RELEASE_FORGED' | 'SOLUTION_FETCHED_OUTSIDE_THE_GATE';
  readonly file: string;
  readonly detail: string;
}

export const RELEASE_MAKERS: readonly string[] = [
  'apps/api/src/contexts/assessment/domain/solution-release.ts',
  'apps/api/src/contexts/assessment/infrastructure/solution-release.repository.ts',
];
export const SOLUTION_FETCHERS: readonly string[] = ['apps/api/src/contexts/assessment/application/handlers/slot-solution-handler.ts'];

const MAKE = /\bmakeReleasedSlot\s*\(/gu;
const FETCH = /\.solutionFor\s*\(/gu;
const SKIPPED = ['node_modules', 'coverage', 'dist', 'fitness-fixtures'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !entry.endsWith('.d.ts') ? [path] : [];
  });
}

export function checkSolutionGate(
  workspaceRoot: string,
  roots: readonly string[],
  options: { readonly makers?: readonly string[]; readonly fetchers?: readonly string[]; readonly production?: (file: string) => boolean } = {},
): SolutionGateViolation[] {
  const makers = options.makers ?? RELEASE_MAKERS;
  const fetchers = options.fetchers ?? SOLUTION_FETCHERS;
  const production = options.production ?? ((file: string) => !/\.spec\.tsx?$/u.test(file) && !file.includes('/testing/'));
  const violations: SolutionGateViolation[] = [];
  for (const root of roots) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      const file = relative(workspaceRoot, path).replaceAll('\\', '/');
      if (!production(file)) continue;
      const code = readCode(path);
      if (!makers.includes(file)) {
        for (const match of code.matchAll(MAKE)) violations.push({ rule: 'SOLUTION_RELEASE_FORGED', file, detail: match[0] });
      }
      if (!fetchers.includes(file)) {
        for (const match of code.matchAll(FETCH)) violations.push({ rule: 'SOLUTION_FETCHED_OUTSIDE_THE_GATE', file, detail: match[0] });
      }
    }
  }
  return violations;
}
