import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

/**
 * Tier 2 (ADR-0013): every assertion here is over the **parsed** workflow
 * file. This workflow has never been executed by a CI provider — nothing
 * here claims it has, or that a job would pass.
 */

export interface CiViolation {
  readonly rule: string;
  readonly detail: string;
}

interface WorkflowStep {
  run?: string;
  if?: string;
  ['continue-on-error']?: boolean;
  uses?: string;
  with?: Record<string, string>;
}

interface WorkflowJob {
  steps?: WorkflowStep[];
}

interface Workflow {
  jobs?: Record<string, WorkflowJob>;
}

export const REQUIRED_JOBS = ['typecheck', 'unit', 'integration', 'fitness', 'build'] as const;

/** A `run:` step containing an inline assertion — the shape DEC-M0-3 forbids. */
const INLINE_ASSERTION_PATTERN = /\bgrep\b.*&&\s*exit\s*1|\btest\s+-[a-z]\s|\[\[.*\]\]\s*\|\|\s*exit/u;

export function parseWorkflow(path: string): Workflow {
  return parse(readFileSync(path, 'utf8')) as Workflow;
}

export function checkWorkflow(workflow: Workflow): CiViolation[] {
  const violations: CiViolation[] = [];
  const jobs = workflow.jobs ?? {};
  const jobNames = Object.keys(jobs);

  for (const required of REQUIRED_JOBS) {
    if (!jobNames.includes(required)) {
      violations.push({ rule: 'MISSING_JOB', detail: required });
    }
  }

  for (const [name, job] of Object.entries(jobs)) {
    for (const step of job.steps ?? []) {
      if (step['continue-on-error'] === true) {
        violations.push({ rule: 'CONTINUE_ON_ERROR', detail: name });
      }
      if (step.if !== undefined) {
        violations.push({ rule: 'CONDITIONAL_STEP', detail: `${name}: if: ${step.if}` });
      }
      if (step.run !== undefined && INLINE_ASSERTION_PATTERN.test(step.run)) {
        violations.push({ rule: 'INLINE_ASSERTION', detail: `${name}: ${step.run}` });
      }
    }
  }

  const integrationSteps = (jobs['integration']?.steps ?? []).map((step) => step.run ?? '').join('\n');
  if (integrationSteps.length > 0 && !integrationSteps.includes('--workspace-concurrency=1')) {
    violations.push({ rule: 'MISSING_WORKSPACE_CONCURRENCY_1', detail: 'integration' });
  }

  const fitnessSteps = (jobs['fitness']?.steps ?? []).map((step) => step.run ?? '').join('\n');
  if (fitnessSteps.length > 0 && !fitnessSteps.includes('pnpm --filter @questionbank/api fitness')) {
    violations.push({ rule: 'FITNESS_NOT_INVOKED_BY_NAME', detail: 'fitness' });
  }

  const installSteps = Object.values(jobs).flatMap((job) => job.steps ?? []).map((step) => step.run ?? '');
  if (!installSteps.some((run) => run.includes('pnpm install --frozen-lockfile'))) {
    violations.push({ rule: 'MISSING_FROZEN_LOCKFILE_INSTALL', detail: 'no job installs with --frozen-lockfile' });
  }

  return violations;
}

/** Every declared Node version across the workflow's `setup-node` steps. */
export function nodeVersionsIn(workflow: Workflow): readonly string[] {
  const versions = new Set<string>();
  for (const job of Object.values(workflow.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      const withNodeVersion = step.with?.['node-version'];
      if (withNodeVersion !== undefined) versions.add(String(withNodeVersion));
    }
  }
  return [...versions];
}

/** `engines.node`'s minimum major version, e.g. `">=22"` -> `"22"`. */
export function minEnginesNode(rootPackageJsonPath: string): string {
  const pkg = JSON.parse(readFileSync(rootPackageJsonPath, 'utf8')) as { engines?: { node?: string } };
  const raw = pkg.engines?.node ?? '';
  const match = /(\d+)/u.exec(raw);
  if (match === null) throw new Error(`root package.json engines.node is not parseable: ${raw}`);
  return match[1]!;
}

/** Every workspace project's package name, resolved from pnpm-workspace.yaml's globs. */
export function workspaceProjectNames(repoRoot: string): readonly string[] {
  const workspace = parse(readFileSync(join(repoRoot, 'pnpm-workspace.yaml'), 'utf8')) as {
    readonly packages?: readonly string[];
  };
  const names: string[] = [];
  for (const pattern of workspace.packages ?? []) {
    const parent = pattern.replace(/\/\*$/u, '');
    let entries: string[];
    try {
      entries = readdirSync(join(repoRoot, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const entry of entries) {
      try {
        const pkg = JSON.parse(readFileSync(join(repoRoot, parent, entry, 'package.json'), 'utf8')) as {
          name?: string;
        };
        if (typeof pkg.name === 'string') names.push(pkg.name);
      } catch {
        continue;
      }
    }
  }
  return names;
}

/** Every project name that appears nowhere in the workflow, and no job runs a blanket `pnpm -r`. */
export function uncoveredProjects(workflowSource: string, projectNames: readonly string[]): readonly string[] {
  // A blanket `pnpm -r` invocation covers every project by definition;
  // otherwise each project must be named (e.g. via --filter) somewhere.
  const coveredByBlanket = /\bpnpm\s+-r\b/u.test(workflowSource);
  if (coveredByBlanket) return [];
  return projectNames.filter((name) => !workflowSource.includes(name));
}
