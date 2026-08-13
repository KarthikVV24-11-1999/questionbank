import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  checkEveryPackageHasRequiredScripts,
  checkWorkspaceGlobsCoverAllPackages,
  findPackageDirectories,
  readPackageJsonScripts,
  resolveRepoRoot,
  topLevelDirsFromWorkspaceYaml,
} from './workspace-rules.js';

const REPO_ROOT = resolveRepoRoot(import.meta.url);

function readWorkspaceYaml(): string {
  return readFileSync(join(REPO_ROOT, 'pnpm-workspace.yaml'), 'utf-8');
}

describe('WORKSPACE_GLOB_MISS — every on-disk package is reachable by a workspace glob', () => {
  it('finds no violation against the real tree', () => {
    expect(checkWorkspaceGlobsCoverAllPackages(REPO_ROOT, readWorkspaceYaml())).toEqual([]);
  });

  it('rejects an unsupported glob shape rather than silently passing it', () => {
    expect(() => topLevelDirsFromWorkspaceYaml('packages:\n  - apps/foo\n')).toThrow(/unsupported workspace glob/);
  });

  it('rejects an empty globs list', () => {
    expect(() => topLevelDirsFromWorkspaceYaml('packages: []\n')).toThrow(/declares no packages globs/);
  });

  describe('planted violation — a package directory the glob list does not cover', () => {
    let sandbox: string;

    beforeEach(() => {
      sandbox = mkdtempSync(join(tmpdir(), 'workspace-rules-'));
      mkdirSync(join(sandbox, 'apps', 'covered'), { recursive: true });
      writeFileSync(join(sandbox, 'apps', 'covered', 'package.json'), '{}');
      mkdirSync(join(sandbox, 'services', 'orphan'), { recursive: true });
      writeFileSync(join(sandbox, 'services', 'orphan', 'package.json'), '{}');
    });

    afterEach(() => {
      rmSync(sandbox, { recursive: true, force: true });
    });

    it('fires on the directory no glob names', () => {
      const yaml = "packages:\n  - 'apps/*'\n  - 'packages/*'\n  - 'tools/*'\n";
      const violations = checkWorkspaceGlobsCoverAllPackages(sandbox, yaml);
      expect(violations).toEqual([
        {
          rule: 'WORKSPACE_GLOB_MISS',
          path: 'services/orphan',
          message: 'no workspace glob covers services/orphan',
        },
      ]);
    });
  });
});

describe('WORKSPACE_MISSING_SCRIPT — every workspace package declares test and typecheck', () => {
  it('finds no violation against the real tree', () => {
    const dirs = findPackageDirectories(REPO_ROOT, ['apps', 'packages', 'tools']);
    expect(dirs.length).toBeGreaterThan(0);
    expect(checkEveryPackageHasRequiredScripts(dirs, readPackageJsonScripts)).toEqual([]);
  });

  it('fires on a package missing typecheck, and separately on one missing both', () => {
    const violations = checkEveryPackageHasRequiredScripts(['/pkg/a', '/pkg/b'], (dir) => {
      if (dir === '/pkg/a') return { scripts: { test: 'vitest run' } };
      return { scripts: {} };
    });
    expect(violations).toEqual([
      { rule: 'WORKSPACE_MISSING_SCRIPT', path: '/pkg/a', script: 'typecheck' },
      { rule: 'WORKSPACE_MISSING_SCRIPT', path: '/pkg/b', script: 'test' },
      { rule: 'WORKSPACE_MISSING_SCRIPT', path: '/pkg/b', script: 'typecheck' },
    ]);
  });

  it('does not object to a package with an unrelated extra script', () => {
    const violations = checkEveryPackageHasRequiredScripts(['/pkg/c'], () => ({
      scripts: { test: 'vitest run', typecheck: 'tsc --noEmit', lint: 'eslint .' },
    }));
    expect(violations).toEqual([]);
  });
});
