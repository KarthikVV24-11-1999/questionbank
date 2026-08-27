import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Documentation drift is the one kind of gap this repository has no other
 * check for (M0-27). §11 quotes real commands; this asserts each one names
 * a script that actually exists in the package.json it claims to, and each
 * file it references is really there — the day either drifts, this fails
 * before a new developer's Day One does.
 */
export interface HandbookViolation {
  readonly rule: 'MISSING_SCRIPT' | 'MISSING_FILE';
  readonly detail: string;
}

export interface ScriptReference {
  readonly packageJsonPath: string;
  readonly script: string;
}

export const SECTION_11_SCRIPTS: readonly ScriptReference[] = [
  { packageJsonPath: 'package.json', script: 'test' },
  { packageJsonPath: 'tools/seed/package.json', script: 'seed' },
  { packageJsonPath: 'apps/api/package.json', script: 'start' },
];

export const SECTION_11_FILES: readonly string[] = [
  'infra/compose/docker-compose.yml',
  'docs/DECISIONS.md',
  'docs/DOMAIN-MODEL.md',
  'docs/adr/ADR-0004-local-postgres-pending-m0-compose.md',
];

export function checkHandbookReferences(
  root: string,
  options: {
    readonly scripts?: readonly ScriptReference[];
    readonly files?: readonly string[];
  } = {},
): readonly HandbookViolation[] {
  const scripts = options.scripts ?? SECTION_11_SCRIPTS;
  const files = options.files ?? SECTION_11_FILES;
  const violations: HandbookViolation[] = [];

  for (const ref of scripts) {
    let pkg: { scripts?: Record<string, string> };
    try {
      pkg = JSON.parse(readFileSync(join(root, ref.packageJsonPath), 'utf8')) as { scripts?: Record<string, string> };
    } catch {
      violations.push({ rule: 'MISSING_FILE', detail: ref.packageJsonPath });
      continue;
    }
    if (pkg.scripts?.[ref.script] === undefined) {
      violations.push({ rule: 'MISSING_SCRIPT', detail: `${ref.packageJsonPath}#${ref.script}` });
    }
  }

  for (const file of files) {
    if (!existsSync(join(root, file))) {
      violations.push({ rule: 'MISSING_FILE', detail: file });
    }
  }

  return violations;
}
