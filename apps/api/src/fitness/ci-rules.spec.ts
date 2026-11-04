import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkWorkflow,
  minEnginesNode,
  nodeVersionsIn,
  parseWorkflow,
  REQUIRED_JOBS,
  uncoveredProjects,
  workspaceProjectNames,
} from './ci-rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const WORKFLOW_PATH = resolve(REPO_ROOT, '.github/workflows/ci.yml');

describe('the real CI workflow', () => {
  const workflow = parseWorkflow(WORKFLOW_PATH);

  it('parses, which is all this spec proves — the run itself is evidence this spec cannot supply', () => {
    expect(Object.keys(workflow.jobs ?? {}).length).toBeGreaterThan(0);
  });

  it('names exactly the required jobs, at minimum', () => {
    for (const job of REQUIRED_JOBS) expect(Object.keys(workflow.jobs ?? {})).toContain(job);
  });

  it('passes every check', () => {
    expect(checkWorkflow(workflow)).toEqual([]);
  });

  it('the Node version matches engines.node, not a duplicated literal', () => {
    const expected = minEnginesNode(resolve(REPO_ROOT, 'package.json'));
    const declared = nodeVersionsIn(workflow);
    expect(declared.length).toBeGreaterThan(0);
    expect(declared.every((v) => v === expected)).toBe(true);
  });

  it('every workspace project is covered by at least one job', () => {
    const source = readFileSync(WORKFLOW_PATH, 'utf8');
    const names = workspaceProjectNames(REPO_ROOT);
    expect(names.length).toBeGreaterThan(0);
    expect(uncoveredProjects(source, names)).toEqual([]);
  });
});

describe('planted violations — one per assertion', () => {
  const real = parseWorkflow(WORKFLOW_PATH);

  it('continue-on-error is a violation', () => {
    const mutated = structuredClone(real) as typeof real;
    (mutated.jobs!['unit']!.steps as unknown as { ['continue-on-error']?: boolean }[])[0]!['continue-on-error'] = true;
    expect(checkWorkflow(mutated).some((v) => v.rule === 'CONTINUE_ON_ERROR')).toBe(true);
  });

  it('an inline grep-based gate is a violation', () => {
    const mutated = structuredClone(real) as typeof real;
    (mutated.jobs!['fitness']!.steps as unknown as { run?: string }[]).push({
      run: 'grep -q TODO src/x.ts && exit 1',
    });
    expect(checkWorkflow(mutated).some((v) => v.rule === 'INLINE_ASSERTION')).toBe(true);
  });

  it('a conditional step is a violation', () => {
    const mutated = structuredClone(real) as typeof real;
    (mutated.jobs!['unit']!.steps as unknown as { if?: string }[])[0]!.if = 'success()';
    expect(checkWorkflow(mutated).some((v) => v.rule === 'CONDITIONAL_STEP')).toBe(true);
  });

  it('an artifact upload that runs after a failure is not a violation', () => {
    const upload = (real.jobs!['adversarial']!.steps as unknown as { uses?: string; if?: string }[]).find((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(upload?.if).toBe('always()');
    expect(checkWorkflow(real).some((v) => v.rule === 'CONDITIONAL_STEP')).toBe(false);
  });

  it('an upload on any other condition, and any other step on always(), are violations', () => {
    const mutated = structuredClone(real) as typeof real;
    const steps = mutated.jobs!['adversarial']!.steps as unknown as { uses?: string; if?: string; run?: string }[];
    steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'))!.if = "github.ref == 'refs/heads/main'";
    expect(checkWorkflow(mutated).filter((v) => v.rule === 'CONDITIONAL_STEP')).toHaveLength(1);
    steps.push({ run: 'corepack pnpm --filter @questionbank/adversarial test', if: 'always()' });
    expect(checkWorkflow(mutated).filter((v) => v.rule === 'CONDITIONAL_STEP')).toHaveLength(2);
  });

  it('the stack\'s job is required, and runs the boot script by name, which holds the budget and the checks', () => {
    expect(REQUIRED_JOBS).toContain('compose');
    const dropped = JSON.parse(JSON.stringify(real));
    delete dropped.jobs!['compose'];
    expect(checkWorkflow(dropped).some((v) => v.rule === 'MISSING_JOB' && v.detail === 'compose')).toBe(true);
    const renamed = JSON.parse(JSON.stringify(real));
    (renamed.jobs!['compose']!.steps as unknown as { run?: string }[]).push({ run: 'docker compose up --wait' });
    renamed.jobs!['compose']!.steps = (renamed.jobs!['compose']!.steps as unknown as { run?: string }[]).filter((step) => !(step.run ?? '').includes('boot.mjs'));
    expect(checkWorkflow(renamed).some((v) => v.rule === 'COMPOSE_NOT_INVOKED_BY_NAME')).toBe(true);
    expect(checkWorkflow(real).filter((v) => v.rule === 'COMPOSE_NOT_INVOKED_BY_NAME')).toEqual([]);
  });

  it('a dropped required job is a violation', () => {
    const mutated = structuredClone(real) as typeof real;
    delete mutated.jobs!['integration'];
    expect(checkWorkflow(mutated).some((v) => v.rule === 'MISSING_JOB')).toBe(true);
  });

  it('a Node version diverging from engines.node is a violation', () => {
    const mutated = structuredClone(real);
    const declared = nodeVersionsIn(mutated).map(() => '18');
    expect(declared.every((v) => v === minEnginesNode(resolve(REPO_ROOT, 'package.json')))).toBe(false);
  });

  it('a recursive run in the integration job without --workspace-concurrency=1 is a violation', () => {
    const mutated = structuredClone(real) as typeof real;
    (mutated.jobs!['integration']!.steps as unknown as { run?: string }[]).push({ run: 'corepack pnpm -r test' });
    expect(checkWorkflow(mutated).some((v) => v.rule === 'MISSING_WORKSPACE_CONCURRENCY_1')).toBe(true);
  });

  it('a recursive run in the integration job that is serialised is not', () => {
    const mutated = structuredClone(real) as typeof real;
    (mutated.jobs!['integration']!.steps as unknown as { run?: string }[]).push({ run: 'corepack pnpm -r --workspace-concurrency=1 test' });
    expect(checkWorkflow(mutated).some((v) => v.rule === 'MISSING_WORKSPACE_CONCURRENCY_1')).toBe(false);
  });
});

describe('the security job (M8-48)', () => {
  const real = parseWorkflow(WORKFLOW_PATH);
  const steps = (workflow: typeof real) => workflow.jobs!['security']!.steps as unknown as { run?: string }[];

  it('is required, and runs the scan by name', () => {
    expect(REQUIRED_JOBS).toContain('security');
    expect(steps(real).some((step) => (step.run ?? '').includes('node tools/security/scan.mjs'))).toBe(true);
    expect(checkWorkflow(real)).toEqual([]);
  });

  it('a workflow without it is refused', () => {
    const dropped = structuredClone(real) as typeof real;
    delete dropped.jobs!['security'];
    expect(checkWorkflow(dropped)).toContainEqual({ rule: 'MISSING_JOB', detail: 'security' });
  });

  it('a job that does not run the script is refused', () => {
    const renamed = structuredClone(real) as typeof real;
    renamed.jobs!['security']!.steps = steps(renamed).filter((step) => !(step.run ?? '').includes('scan.mjs')) as never;
    expect(checkWorkflow(renamed).map((v) => v.rule)).toContain('SECURITY_NOT_INVOKED_BY_NAME');
  });

  it('a job that audits on its own, or throws a failure away, is refused: that is a report and not a gate', () => {
    for (const run of ['corepack pnpm audit', 'node tools/security/scan.mjs || true']) {
      const swallowed = structuredClone(real) as typeof real;
      steps(swallowed).push({ run });
      expect(checkWorkflow(swallowed).map((v) => v.rule), run).toContain('SECURITY_GATE_SWALLOWED');
    }
  });
});

