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

  it('has never been executed by a CI provider — this spec proves the file parses, nothing more', () => {
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

  it('removing --workspace-concurrency=1 from the integration job is a violation', () => {
    const mutated = structuredClone(real) as typeof real;
    mutated.jobs!['integration']!.steps = (mutated.jobs!['integration']!.steps as unknown as { run?: string }[]).map(
      (step) =>
        step.run?.includes('--workspace-concurrency=1')
          ? { ...step, run: step.run.replace(' --workspace-concurrency=1', '') }
          : step,
    ) as never;
    expect(checkWorkflow(mutated).some((v) => v.rule === 'MISSING_WORKSPACE_CONCURRENCY_1')).toBe(true);
  });
});
