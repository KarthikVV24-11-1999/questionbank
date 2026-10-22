import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * REL-06 — set union by `event_id` — has exactly one home (ADR-0035): `packages/attempt-engine/src/merge.ts`,
 * with the log it unions in `response-log.ts` beside it.
 *
 * The rule has two halves, because a name check alone is beaten by a rename:
 *
 *   - **by name** — only the engine's `merge.ts` and `response-log.ts` may declare `mergeLogs` or
 *     `logFromEvents`;
 *   - **by what it does** — no other production source may *both* walk events by their `eventId` *and* keep a
 *     set or map to drop the ones it has seen. That is what a union by id is, whatever it is called. The few
 *     modules that legitimately touch an event id (the engine's own log and queue, the server's mapping
 *     module that hands the engine its work, and the repositories' identity comparison) are listed, each with its reason.
 *
 * Specs and the planted fixtures are exempt: a test builds its own expectation, and a fixture exists to be found.
 */
export interface Rel06Violation {
  readonly rule: 'REL06_SECOND_UNION_IMPLEMENTATION';
  readonly file: string;
  readonly detail: string;
}

const DECLARES_THE_ENGINES_MERGE = /\b(?:function|const)\s+(mergeLogs|logFromEvents)\b/u;
const WALKS_BY_EVENT_ID = /\.eventId\b|\beventId\b\s*[:=]/u;
const KEEPS_WHAT_IT_SAW = /new\s+(?:Set|Map)\s*(?:<[^>]*>)?\s*\(/u;

/** Production source that may hold a set or map keyed by event id, and why. */
export const EVENT_ID_BOOKKEEPING_ALLOWED: Readonly<Record<string, string>> = {
  'packages/attempt-engine/src/response-log.ts': 'the engine\'s log: where de-duplication by event id is defined',
  'packages/attempt-engine/src/merge.ts': 'the engine\'s union: REL-06 itself',
  'packages/attempt-engine/src/sync-queue.ts': 'the device\'s queue of unacknowledged ids; it unions nothing',
  'packages/attempt-engine/src/attempt.ts': 'the engine\'s attempt: the ids that existed at submission',
  'packages/attempt-engine/src/projection.ts': 'projection filters by the ids it is told to include',
  'apps/api/src/contexts/assessment/domain/response-log.ts': 'hands the engine the two sets and reads which ids are new from its answer',
  'apps/api/src/contexts/assessment/application/handlers/attempt-handlers.ts': 'answers each event of a batch in order, from the merge\'s classification',
};

const SKIPPED = ['node_modules', 'coverage', 'dist', 'fitness-fixtures', 'testing'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !/\.(spec|d)\.tsx?$/u.test(entry) ? [path] : [];
  });
}

/**
 * Scans `roots` (relative to `workspaceRoot`) for a second union by event id.
 * `allowed` is overridden only to prove the scan against a planted fixture.
 */
export function checkRel06HasOneHome(
  workspaceRoot: string,
  roots: readonly string[],
  allowed: Readonly<Record<string, string>> = EVENT_ID_BOOKKEEPING_ALLOWED,
): Rel06Violation[] {
  const violations: Rel06Violation[] = [];
  for (const root of roots) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      const file = relative(workspaceRoot, path).replaceAll('\\', '/');
      const code = readCode(path);
      const declared = DECLARES_THE_ENGINES_MERGE.exec(code);
      const engineOwned = file === 'packages/attempt-engine/src/merge.ts' || file === 'packages/attempt-engine/src/response-log.ts';
      if (declared !== null && !engineOwned) {
        violations.push({ rule: 'REL06_SECOND_UNION_IMPLEMENTATION', file, detail: `declares ${declared[1]}` });
        continue;
      }
      if (allowed[file] === undefined && WALKS_BY_EVENT_ID.test(code) && KEEPS_WHAT_IT_SAW.test(code)) {
        violations.push({ rule: 'REL06_SECOND_UNION_IMPLEMENTATION', file, detail: 'walks events by eventId and keeps a set or map of what it has seen' });
      }
    }
  }
  return violations;
}
