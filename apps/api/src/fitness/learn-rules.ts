import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * What keeps `apps/learn` a view of the attempt engine and not a second owner of the attempt (M6-47, M6-49, M6-50).
 *
 * The learner shell is the code most likely to grow its own copy of the attempt under UI work: a `useState` for "which option is
 * picked", a `useRef` holding the queue, a banner that asks the browser whether it is online. Each is a second source for something
 * the engine already answers, and the two drift on exactly the day a learner loses connection. So the shell's source is held to:
 *
 *   - **No component state beyond a short, named list** (`M6_47_STATE_OUTSIDE_THE_ALLOWLIST`). `useState`, `useReducer`, `useRef`,
 *     `createContext` and a state-library import appear only in the files listed, and
 *   - **even there, not under an attempt's name** (`M6_47_ATTEMPT_NAMED_STATE`): a listed file may hold whether a dialog is open or how
 *     booting went, never an answer, a flag, a visit, a deadline, a queue or a sync state.
 *   - **No browser storage outside the host file** (`M6_47_STORAGE_OUTSIDE_THE_HOST`): what is kept on the device is the engine's log, written by
 *     `session/persistence.ts` through a port the host hands in.
 *   - **No value import of the engine outside `session/`** (`M6_47_ENGINE_VALUE_IMPORT_OUTSIDE_THE_SESSION`). A component may name an
 *     engine type; only the session calls the engine.
 *   - **No second notion of connectivity** (`M6_49_CONNECTIVITY_OUTSIDE_THE_HOST`): `navigator.onLine` and the `online`/`offline`
 *     events are read in the host file only, where they do one thing — ask the session to try the queue now.
 *   - **No ambient clock or timer** (`M6_50_AMBIENT_TIME_OUTSIDE_THE_HOST`): the deadline is the engine's, over a clock the host hands in.
 *
 * Specs and the test support directory are exempt: a test builds its own world.
 */
export type LearnRule =
  | 'M6_47_STATE_OUTSIDE_THE_ALLOWLIST'
  | 'M6_47_ATTEMPT_NAMED_STATE'
  | 'M6_47_STORAGE_OUTSIDE_THE_HOST'
  | 'M6_47_ENGINE_VALUE_IMPORT_OUTSIDE_THE_SESSION'
  | 'M6_49_CONNECTIVITY_OUTSIDE_THE_HOST'
  | 'M6_50_AMBIENT_TIME_OUTSIDE_THE_HOST';

export interface LearnViolation {
  readonly rule: LearnRule;
  readonly file: string;
  readonly detail: string;
}

/** The files that may hold component state, and what for. Anything else holding any is the invariant eroding. */
export const STATE_ALLOWLIST: Readonly<Record<string, string>> = {
  'apps/learn/src/ui/LearnApp.tsx': 'whether the submit confirmation is open',
  'apps/learn/src/ui/Root.tsx': 'how booting went (loading, refused, failed, ready)',
  'apps/learn/src/ui/use-remote.ts': 'how a request is going (loading, loaded, failed), for the screens that read Learning; never the learner\'s own state',
};
/** The one file that touches the browser's own storage, connectivity, clock and timers, and wires them to the session as ports. */
export const HOST_FILES: readonly string[] = ['apps/learn/src/main.tsx'];
/** Where the engine may be called. */
export const ENGINE_CALLERS: readonly string[] = ['apps/learn/src/session/'];

const STATE_PRIMITIVE = /\b(?:useState|useReducer|useRef|createContext)\b|from\s+['"](?:zustand|redux|@reduxjs\/toolkit|jotai|recoil|mobx|valtio)[^'"]*['"]/gu;
const STATE_DECLARATION = /const\s*\[\s*(\w+)\s*,\s*\w+\s*\]\s*=\s*use(?:State|Reducer)\b|const\s+(\w+)\s*=\s*useRef\b/gu;
const ATTEMPT_NAME = /answer|respon|select|pick|choice|flag|visit|event|log|attempt|queue|sync|deadline|remain|elapsed|timer|score|result|palette|current|slot/iu;
const STORAGE = /\b(?:localStorage|sessionStorage|indexedDB|caches)\b/gu;
const ENGINE_VALUE_IMPORT = /^\s*import\s+(?!type\b)[^;]*?from\s+['"]@questionbank\/attempt-engine['"]/gmu;
const CONNECTIVITY = /\bnavigator\s*\.\s*onLine\b|addEventListener\s*\(\s*['"](?:online|offline)['"]|\bonline\s*:|\bisOnline\b/gu;
const AMBIENT_TIME = /\bDate\s*\.\s*now\s*\(|\bnew\s+Date\s*\(\s*\)|\bperformance\s*\.\s*now\s*\(|\bset(?:Interval|Timeout|Immediate)\s*\(|\brequestAnimationFrame\s*\(/gu;

const SKIPPED = ['node_modules', 'coverage', 'dist', 'fitness-fixtures', 'testing', 'public'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !/\.(spec|d)\.tsx?$/u.test(entry) ? [path] : [];
  });
}

export function checkLearnShell(
  workspaceRoot: string,
  roots: readonly string[],
  options: { readonly stateAllowlist?: readonly string[]; readonly hostFiles?: readonly string[]; readonly engineCallers?: readonly string[] } = {},
): { readonly violations: LearnViolation[]; readonly scannedFiles: number } {
  const stateAllowed = options.stateAllowlist ?? Object.keys(STATE_ALLOWLIST);
  const hosts = options.hostFiles ?? HOST_FILES;
  const callers = options.engineCallers ?? ENGINE_CALLERS;
  const violations: LearnViolation[] = [];
  let scannedFiles = 0;
  for (const root of roots) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      scannedFiles += 1;
      const file = relative(workspaceRoot, path).replaceAll('\\', '/');
      const code = readCode(path);
      const add = (rule: LearnRule, pattern: RegExp) => {
        for (const detail of new Set([...code.matchAll(pattern)].map((match) => match[0].trim()))) violations.push({ rule, file, detail });
      };
      if (!stateAllowed.includes(file)) add('M6_47_STATE_OUTSIDE_THE_ALLOWLIST', STATE_PRIMITIVE);
      for (const match of code.matchAll(STATE_DECLARATION)) {
        const name = match[1] ?? match[2] ?? '';
        if (ATTEMPT_NAME.test(name)) violations.push({ rule: 'M6_47_ATTEMPT_NAMED_STATE', file, detail: name });
      }
      if (!callers.some((prefix) => file.startsWith(prefix))) add('M6_47_ENGINE_VALUE_IMPORT_OUTSIDE_THE_SESSION', ENGINE_VALUE_IMPORT);
      if (!hosts.includes(file)) {
        add('M6_47_STORAGE_OUTSIDE_THE_HOST', STORAGE);
        add('M6_49_CONNECTIVITY_OUTSIDE_THE_HOST', CONNECTIVITY);
        add('M6_50_AMBIENT_TIME_OUTSIDE_THE_HOST', AMBIENT_TIME);
      }
    }
  }
  return { violations, scannedFiles };
}
