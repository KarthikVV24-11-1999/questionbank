import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { importsOf } from './source-scan.js';

/**
 * Architecture rules enforced as a fitness function (ENGINEERING-HANDBOOK §9).
 *
 *   F1 — cross-module imports go through `public/` barrels only
 *   F2 — `domain/` imports nothing but itself and the shared kernel
 *
 * dependency-cruiser is the tool the task names, but it refuses to run on the
 * Node version in use here, so the rules are evaluated directly instead. The
 * check is the source of truth either way: one implementation, run in CI.
 */
export interface BoundaryViolation {
  readonly rule: 'F1_CONTEXT_BOUNDARY' | 'F2_DOMAIN_IMPORTS_NOTHING' | 'DOMAIN_REACHES_OUTWARD';
  readonly file: string;
  readonly importPath: string;
  readonly message: string;
}

export interface BoundaryCheckOptions {
  /** Directories to scan, relative to the root. */
  readonly include?: readonly string[];
  /** Files whose violations are expected — the planted fixtures. */
  readonly excludePatterns?: readonly RegExp[];
  /** What counts as the domain layer. Overridden only to test the rule itself. */
  readonly domainPattern?: RegExp;
}

const DEFAULT_EXCLUDES = [/\.spec\.ts$/u, /^src\/testing\//u, /^src\/fitness-fixtures\//u, /^src\/fitness\//u];

/**
 * Every module the file reaches, however it reaches it — re-exported from
 * `source-scan.ts`, which owns the one implementation.
 *
 * It used to be a second copy of the same patterns here. That is exactly how
 * the string-literal defect survived its own fix: `source-scan.ts` was
 * tightened and this file, which is what F1 and F2 actually run, kept matching
 * the loose pattern. Two implementations of one rule means the gate and the
 * test of the gate can disagree, which is the worst possible arrangement.
 */
export { importsOf } from './source-scan.js';

function walk(directory: string): string[] {
  const entries = readdirSync(directory);
  return entries.flatMap((entry) => {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return walk(path);
    return path.endsWith('.ts') ? [path] : [];
  });
}

function isSharedKernel(importPath: string): boolean {
  return importPath === '@questionbank/domain-types';
}

function isNodeBuiltin(importPath: string): boolean {
  return importPath.startsWith('node:');
}

/** The bounded context a path belongs to, or null for anything outside contexts/. */
function contextOf(path: string): string | null {
  return /^src\/contexts\/([^/]+)\//u.exec(path)?.[1] ?? null;
}

/** Resolves a relative import to a repo-relative path, without extensions. */
function resolveImport(fromFile: string, importPath: string, root: string): string | null {
  if (!importPath.startsWith('.')) return null;
  const absolute = resolve(join(root, fromFile), '..', importPath);
  return relative(root, absolute).replaceAll('\\', '/');
}

export function checkBoundaries(root: string, options: BoundaryCheckOptions = {}): BoundaryViolation[] {
  const includes = options.include ?? ['src'];
  const excludes = options.excludePatterns ?? DEFAULT_EXCLUDES;
  const domainPattern = options.domainPattern ?? /^src\/contexts\/[^/]+\/domain\//u;
  const violations: BoundaryViolation[] = [];

  const files = includes
    .flatMap((directory) => walk(join(root, directory)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)));

  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    const owningContext = contextOf(file);
    const insideDomain = domainPattern.test(file);

    for (const importPath of importsOf(source)) {
      const resolved = resolveImport(file, importPath, root);
      const targetContext = resolved === null ? null : contextOf(resolved);

      // F1: reaching into another context is permitted only through its barrel.
      if (targetContext !== null && targetContext !== owningContext) {
        const throughBarrel = resolved?.startsWith(`src/contexts/${targetContext}/public/`) === true;
        if (!throughBarrel) {
          violations.push({
            rule: 'F1_CONTEXT_BOUNDARY',
            file,
            importPath,
            message: `${file} imports ${importPath} directly; use the ${targetContext} public/ barrel`,
          });
        }
      }

      if (insideDomain) {
        const staysInDomain =
          owningContext !== null && resolved?.startsWith(`src/contexts/${owningContext}/domain/`) === true;
        if (!staysInDomain && !isSharedKernel(importPath) && !isNodeBuiltin(importPath)) {
          violations.push({
            rule: 'F2_DOMAIN_IMPORTS_NOTHING',
            file,
            importPath,
            message: `${file} imports ${importPath}; domain/ imports nothing but itself and the shared kernel`,
          });
        }

        // Any outward layer, in any context: a domain module reaching into
        // someone else's infrastructure is no better than reaching into its own.
        if (resolved !== null && /^src\/contexts\/[^/]+\/(infrastructure|application|api)\//u.test(resolved)) {
          violations.push({
            rule: 'DOMAIN_REACHES_OUTWARD',
            file,
            importPath,
            message: `${file} reaches outward to ${importPath}`,
          });
        }
      }
    }
  }

  return violations;
}
