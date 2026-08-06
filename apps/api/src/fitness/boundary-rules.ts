import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

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

const IMPORT_PATTERN = /(?:^|\n)\s*(?:import|export)[\s\S]*?from\s+['"]([^'"]+)['"]/gu;
const DEFAULT_EXCLUDES = [/\.spec\.ts$/u, /^src\/testing\//u, /^src\/fitness-fixtures\//u, /^src\/fitness\//u];

/** Every module the file imports, as written. */
export function importsOf(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(IMPORT_PATTERN)) {
    const specifier = match[1];
    if (specifier !== undefined) found.push(specifier);
  }
  return found;
}

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

/** Resolves a relative import to a repo-relative path, without extensions. */
function resolveImport(fromFile: string, importPath: string, root: string): string | null {
  if (!importPath.startsWith('.')) return null;
  const absolute = resolve(join(root, fromFile), '..', importPath);
  return relative(root, absolute).replaceAll('\\', '/');
}

export function checkBoundaries(root: string, options: BoundaryCheckOptions = {}): BoundaryViolation[] {
  const includes = options.include ?? ['src'];
  const excludes = options.excludePatterns ?? DEFAULT_EXCLUDES;
  const domainPattern = options.domainPattern ?? /^src\/contexts\/curriculum\/domain\//u;
  const violations: BoundaryViolation[] = [];

  const files = includes
    .flatMap((directory) => walk(join(root, directory)))
    .map((file) => relative(root, file).replaceAll('\\', '/'))
    .filter((file) => !excludes.some((pattern) => pattern.test(file)));

  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8');
    const insideCurriculum = file.startsWith('src/contexts/curriculum/');
    const insideDomain = domainPattern.test(file);

    for (const importPath of importsOf(source)) {
      const resolved = resolveImport(file, importPath, root);

      if (!insideCurriculum && resolved?.startsWith('src/contexts/curriculum/') === true) {
        const throughBarrel = resolved.startsWith('src/contexts/curriculum/public/');
        if (!throughBarrel) {
          violations.push({
            rule: 'F1_CONTEXT_BOUNDARY',
            file,
            importPath,
            message: `${file} imports ${importPath} directly; use the curriculum public/ barrel`,
          });
        }
      }

      if (insideDomain) {
        const staysInDomain = resolved?.startsWith('src/contexts/curriculum/domain/') === true;
        if (!staysInDomain && !isSharedKernel(importPath) && !isNodeBuiltin(importPath)) {
          violations.push({
            rule: 'F2_DOMAIN_IMPORTS_NOTHING',
            file,
            importPath,
            message: `${file} imports ${importPath}; domain/ imports nothing but itself and the shared kernel`,
          });
        }

        if (
          resolved?.startsWith('src/contexts/curriculum/infrastructure/') === true ||
          resolved?.startsWith('src/contexts/curriculum/application/') === true ||
          resolved?.startsWith('src/contexts/curriculum/api/') === true
        ) {
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
