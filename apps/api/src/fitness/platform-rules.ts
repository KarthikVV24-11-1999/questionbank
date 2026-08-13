import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { stripComments } from './source-scan.js';

/**
 * Fitness functions for `apps/api/src/platform/` and the process-boundary
 * rules M0 adds. Populated task by task across M0 — M0-24 through M0-26
 * collect the full gate register with planted fixtures; this file is the one
 * home the checks accumulate in, the way `content-rules.ts` did for M3.
 *
 *   F16 — no configuration read outside the typed config module
 *   API_NO_TSX — the API authors no JSX (ADR-0016)
 */
export interface EnvReadViolation {
  readonly rule: 'F16_UNTYPED_CONFIG_READ';
  readonly file: string;
}

/**
 * The closed, enumerated set of files permitted to read `process.env`
 * directly, relative to the API project root. `config.ts` reads it exactly
 * once, through `loadConfigFromProcessEnv` — `loadConfig` itself is pure and
 * takes `env` as a parameter. `src/testing/database.ts` is test/tool support
 * and not shipped runtime (ADR-0004); it defaults `DATABASE_URL`
 * independently of the running application's config (DEC-M0-8). A file added
 * to this list is a reviewed diff; a file reading `process.env` without
 * being added here fails the check instead.
 */
export const ENV_READ_ALLOWLIST = ['src/platform/config/config.ts', 'src/testing/database.ts'] as const;

const ENV_READ_PATTERN = /\bprocess\s*\.\s*env\b/u;
const DEFAULT_EXCLUDES = [/\.spec\.ts$/u, /^src\/fitness-fixtures\//u, /^src\/fitness\//u];

function walk(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

/**
 * `root` is the API project root (absolute). Returns violations with
 * `file` relative to `root`, matching the shape `boundary-rules.ts` uses.
 * `include`/`allowlist` are overridable so a test can point this at a
 * fixture tree instead of the real source.
 */
export function checkNoUntypedConfigReads(
  root: string,
  options: {
    readonly include?: readonly string[];
    readonly allowlist?: readonly string[];
    readonly excludePatterns?: readonly RegExp[];
  } = {},
): EnvReadViolation[] {
  const includes = options.include ?? ['src'];
  const allowlist = options.allowlist ?? ENV_READ_ALLOWLIST;
  const excludes = options.excludePatterns ?? DEFAULT_EXCLUDES;

  const files = includes
    .flatMap((directory) => walk(join(root, directory)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)))
    .filter((file) => !allowlist.includes(file));

  const violations: EnvReadViolation[] = [];
  for (const file of files) {
    const code = stripComments(readFileSync(join(root, file), 'utf8'));
    if (ENV_READ_PATTERN.test(code)) {
      violations.push({ rule: 'F16_UNTYPED_CONFIG_READ', file });
    }
  }
  return violations;
}

export interface TsxViolation {
  readonly rule: 'API_NO_TSX';
  readonly file: string;
}

/** Every file under `directory`, any extension — unlike `walk`, not narrowed to `.ts`. */
function walkAllFiles(directory: string): string[] {
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    return statSync(path).isDirectory() ? walkAllFiles(path) : [path];
  });
}

/**
 * The API type-checks the renderer package (ADR-0016, M0-09) — it does not
 * author components of its own. `jsx: "react-jsx"` in `apps/api/tsconfig.json`
 * exists to check an *imported* package, never to compile JSX authored here;
 * this is the guard that keeps that boundary from drifting quietly. A file
 * ending `.tsx` under `src/` is the violation, regardless of what it contains.
 */
const DEFAULT_TSX_EXCLUDES = [/^src\/fitness-fixtures\//u];

export function checkNoTsxFiles(
  root: string,
  options: { readonly include?: readonly string[]; readonly excludePatterns?: readonly RegExp[] } = {},
): TsxViolation[] {
  const includes = options.include ?? ['src'];
  const excludes = options.excludePatterns ?? DEFAULT_TSX_EXCLUDES;
  const files = includes
    .flatMap((directory) => walkAllFiles(join(root, directory)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)));

  return files.filter((file) => file.endsWith('.tsx')).map((file) => ({ rule: 'API_NO_TSX' as const, file }));
}
