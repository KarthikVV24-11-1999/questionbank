import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * Two rules that keep the background jobs testable and the process in charge of its own timers (M6-38, M6-42).
 *
 *   - **A timer is started in one place.** `setInterval`, `setTimeout` and `setImmediate` appear in production source only in
 *     `platform/scheduling/system-timers.ts`, the port the process hands the scheduler. A module that starts its own timer is a job
 *     that runs whether or not anyone asked, and cannot be driven by a supplied moment.
 *   - **The relay and the scheduler read no clock.** `Date.now()` and `new Date()` with no argument do not appear in
 *     `platform/outbox/` or `platform/scheduling/scheduler.ts`: a lease expiring and a back-off elapsing are tested by passing a later
 *     `now`, which only works if nothing in them looks at the real one.
 *
 * Specs and fixtures are exempt: a test builds its own moments.
 */
export interface SchedulingViolation {
  readonly rule: 'M6_42_TIMER_STARTED_OUTSIDE_THE_PORT' | 'M6_38_CLOCK_READ_IN_THE_RELAY_OR_SCHEDULER';
  readonly file: string;
  readonly detail: string;
}

const TIMER = /\bset(?:Interval|Timeout|Immediate)\s*\(/gu;
const CLOCK_READ = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)/gu;

export const TIMER_PORT_FILES: readonly string[] = ['apps/api/src/platform/scheduling/system-timers.ts'];
export const CLOCK_FREE_PATHS: readonly string[] = ['apps/api/src/platform/outbox/', 'apps/api/src/platform/scheduling/scheduler.ts'];

const SKIPPED = ['node_modules', 'coverage', 'dist', 'fitness-fixtures', 'testing'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !/\.(spec|d)\.tsx?$/u.test(entry) ? [path] : [];
  });
}

export function checkSchedulingDiscipline(
  workspaceRoot: string,
  roots: readonly string[],
  options: { readonly timerPort?: readonly string[]; readonly clockFree?: readonly string[] } = {},
): SchedulingViolation[] {
  const timerPort = options.timerPort ?? TIMER_PORT_FILES;
  const clockFree = options.clockFree ?? CLOCK_FREE_PATHS;
  const violations: SchedulingViolation[] = [];
  for (const root of roots) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      const file = relative(workspaceRoot, path).replaceAll('\\', '/');
      const code = readCode(path);
      if (!timerPort.includes(file)) {
        for (const match of code.matchAll(TIMER)) violations.push({ rule: 'M6_42_TIMER_STARTED_OUTSIDE_THE_PORT', file, detail: match[0] });
      }
      if (clockFree.some((prefix) => file === prefix || file.startsWith(prefix))) {
        for (const match of code.matchAll(CLOCK_READ)) violations.push({ rule: 'M6_38_CLOCK_READ_IN_THE_RELAY_OR_SCHEDULER', file, detail: match[0] });
      }
    }
  }
  return violations;
}
