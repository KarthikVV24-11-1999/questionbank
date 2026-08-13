import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';

/**
 * The workspace as it stands (M0-01, DEC-M0-2). Not a boundary rule — a
 * check that the pnpm workspace nobody configured a monorepo tool for is
 * still internally consistent: every package the globs could reach has a
 * `package.json`, and every one of those declares the two scripts every
 * other gate in this repository assumes exist.
 */

export interface WorkspaceCoverageViolation {
  readonly rule: 'WORKSPACE_GLOB_MISS';
  readonly path: string;
  readonly message: string;
}

export interface RequiredScriptViolation {
  readonly rule: 'WORKSPACE_MISSING_SCRIPT';
  readonly path: string;
  readonly script: string;
}

const REQUIRED_SCRIPTS = ['test', 'typecheck'] as const;

/** Not a workspace container and never will be — walking into it finds nothing a glob could cover. */
const NEVER_A_WORKSPACE_DIR = new Set(['node_modules', '.git', '.claude', 'docs', 'infra']);

/**
 * Finds every directory under `root` containing a `package.json`, one level
 * below one of `topLevelDirs` — the same shape `pnpm-workspace.yaml`'s globs
 * describe. Does not walk into `node_modules` or other non-package roots.
 */
export function findPackageDirectories(root: string, topLevelDirs: readonly string[]): string[] {
  const found: string[] = [];
  for (const top of topLevelDirs) {
    const topPath = join(root, top);
    let entries: string[];
    try {
      entries = readdirSync(topPath);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry === 'node_modules') continue;
      const candidate = join(topPath, entry);
      if (!statSync(candidate).isDirectory()) continue;
      try {
        statSync(join(candidate, 'package.json'));
        found.push(candidate);
      } catch {
        continue;
      }
    }
  }
  return found;
}

/**
 * Every top-level directory in `root` that is not a dotfile and not a known
 * non-workspace directory — the set a rogue project could appear under
 * without being named by any glob at all (`services/orphan`, not just an
 * unglobbed subdirectory of `apps/`).
 */
function allCandidateTopLevelDirs(root: string): string[] {
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => !name.startsWith('.') && !NEVER_A_WORKSPACE_DIR.has(name));
}

/**
 * Parses `pnpm-workspace.yaml`'s `packages` globs — each is `<dir>/*`, the
 * only form this repository uses — into the top-level directories they name.
 * A glob shaped any other way (`apps/foo`, `apps/**`) is rejected rather
 * than silently ignored, because a check that cannot parse a glob and says
 * nothing is a vacuous check (DEC-M0-1).
 */
export function topLevelDirsFromWorkspaceYaml(yamlContents: string): string[] {
  const parsed = parseYaml(yamlContents) as { packages?: unknown };
  const globs = parsed.packages;
  if (!Array.isArray(globs) || globs.length === 0) {
    throw new Error('pnpm-workspace.yaml declares no packages globs');
  }
  return globs.map((glob) => {
    if (typeof glob !== 'string' || !glob.endsWith('/*') || glob.split('/').length !== 2) {
      throw new Error(`unsupported workspace glob shape: ${JSON.stringify(glob)}`);
    }
    return glob.slice(0, -2);
  });
}

/**
 * Every directory containing a `package.json` under `apps/`, `packages/` and
 * `tools/` must be reachable by one of the workspace globs. A project added
 * outside them is invisible to `pnpm -r` and fails silently — this is where
 * that failure becomes loud instead.
 */
export function checkWorkspaceGlobsCoverAllPackages(
  root: string,
  workspaceYamlContents: string,
): WorkspaceCoverageViolation[] {
  const globDirs = topLevelDirsFromWorkspaceYaml(workspaceYamlContents);
  const onDiskTopLevel = allCandidateTopLevelDirs(root);
  const found = findPackageDirectories(root, onDiskTopLevel);
  const violations: WorkspaceCoverageViolation[] = [];
  for (const dir of found) {
    const top = relative(root, dir).split('/')[0];
    if (top === undefined || !globDirs.includes(top)) {
      violations.push({
        rule: 'WORKSPACE_GLOB_MISS',
        path: relative(root, dir),
        message: `no workspace glob covers ${relative(root, dir)}`,
      });
    }
  }
  return violations;
}

/**
 * Every workspace package declares `test` and `typecheck` — the two scripts
 * `package.json`'s root `pnpm -r` invocations and the CI workflow (M0-21)
 * assume exist on every project without checking first.
 */
export function checkEveryPackageHasRequiredScripts(
  packageDirs: readonly string[],
  readPackageJson: (dir: string) => { scripts?: Record<string, string> },
): RequiredScriptViolation[] {
  const violations: RequiredScriptViolation[] = [];
  for (const dir of packageDirs) {
    const pkg = readPackageJson(dir);
    for (const script of REQUIRED_SCRIPTS) {
      if (pkg.scripts?.[script] === undefined) {
        violations.push({ rule: 'WORKSPACE_MISSING_SCRIPT', path: dir, script });
      }
    }
  }
  return violations;
}

export function readPackageJsonScripts(dir: string): { scripts?: Record<string, string> } {
  const contents = readFileSync(join(dir, 'package.json'), 'utf-8');
  return JSON.parse(contents) as { scripts?: Record<string, string> };
}

/** `fromFileUrl` is `import.meta.url`, not a path — `pathname` alone leaves spaces `%20`-encoded. */
export function resolveRepoRoot(fromFileUrl: string): string {
  // apps/api/src/fitness/workspace-rules.ts -> repo root is four levels up.
  return resolve(dirname(fileURLToPath(fromFileUrl)), '..', '..', '..', '..');
}
