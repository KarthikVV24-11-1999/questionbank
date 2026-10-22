import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { AMBIENT_EFFECT_PATTERN, FRAMEWORK_IMPORT_PATTERN } from './frontend-rules.js';
import { importsOf, readCode } from './source-scan.js';

/**
 * The admission criterion for a workspace package a context's `domain/` may import
 * (ADR-0035), stated as a property rather than as a name so the next package of the
 * kind is governed rather than argued about.
 *
 * A package is **pure** — and so may be imported by a `domain/` — when all three hold:
 *
 *   1. it declares no runtime dependency (`dependencies`, `peerDependencies`,
 *      `optionalDependencies`); only dev tooling;
 *   2. none of its non-test source (under `src/`) imports anything that is not a relative module — no
 *      bare specifier, no `node:` builtin — so nothing it reaches is outside the package;
 *   3. none of its non-test source reads a clock, randomness, storage, the network or the
 *      host process, or touches a framework or the DOM (the patterns F26 holds the attempt
 *      engine to — one definition, imported, not restated).
 *
 * `domain/` imports nothing because the rule keeps it free of coupling, I/O, a clock and
 * randomness. A package meeting all three carries none of those in, which is why it earns
 * the place the shared kernel has.
 */
export interface Admission {
  readonly name: string;
  readonly directory: string;
  readonly admitted: boolean;
  /** Why not, one entry per criterion broken; empty when admitted. */
  readonly reasons: readonly string[];
}

const RUNTIME_DEPENDENCY_FIELDS = ['dependencies', 'peerDependencies', 'optionalDependencies'] as const;
const NOT_PRODUCTION_SOURCE = [/\.spec\.tsx?$/u, /(^|\/)testing\//u, /\.d\.ts$/u];
const SKIPPED_DIRECTORIES = ['node_modules', 'coverage', 'dist'];

function sourceFiles(directory: string, prefix = ''): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED_DIRECTORIES.includes(entry)) return [];
    const path = join(directory, entry);
    const relative = `${prefix}${entry}`;
    if (statSync(path).isDirectory()) return sourceFiles(path, `${relative}/`);
    return /\.tsx?$/u.test(entry) && !NOT_PRODUCTION_SOURCE.some((pattern) => pattern.test(relative)) ? [path] : [];
  });
}

/** Assesses one package directory against the criterion. */
export function assessPackage(directory: string): Admission {
  const manifest = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8')) as Record<string, unknown>;
  const name = typeof manifest['name'] === 'string' ? manifest['name'] : directory;
  const reasons: string[] = [];

  for (const field of RUNTIME_DEPENDENCY_FIELDS) {
    const declared = manifest[field];
    if (typeof declared === 'object' && declared !== null && Object.keys(declared).length > 0) {
      reasons.push(`declares runtime dependencies in ${field}: ${Object.keys(declared).join(', ')}`);
    }
  }

  // A package's source is what ships; tooling configuration at its root (a test runner's config) does not.
  const source = join(directory, 'src');
  for (const file of existsSync(source) ? sourceFiles(source) : []) {
    const outward = importsOf(readFileSync(file, 'utf8')).filter((specifier) => !specifier.startsWith('.'));
    if (outward.length > 0) reasons.push(`${file} imports ${outward.join(', ')}`);
    const code = readCode(file);
    const ambient = AMBIENT_EFFECT_PATTERN.exec(code) ?? FRAMEWORK_IMPORT_PATTERN.exec(code);
    if (ambient !== null) reasons.push(`${file} reaches ${ambient[0].trim()}`);
  }

  return { name, directory, admitted: reasons.length === 0, reasons };
}

/**
 * Every workspace package under `<workspaceRoot>/packages` that meets the criterion,
 * by the name a `domain/` would import it under. Computed from the tree each time: a
 * package that stops being pure stops being admitted in the same run.
 */
export function assessWorkspace(workspaceRoot: string): readonly Admission[] {
  const packagesDir = join(workspaceRoot, 'packages');
  if (!existsSync(packagesDir)) return [];
  return readdirSync(packagesDir)
    .filter((entry) => existsSync(join(packagesDir, entry, 'package.json')))
    .map((entry) => assessPackage(join(packagesDir, entry)));
}

export function admittedPackages(workspaceRoot: string): ReadonlySet<string> {
  return new Set(assessWorkspace(workspaceRoot).filter((admission) => admission.admitted).map((admission) => admission.name));
}
