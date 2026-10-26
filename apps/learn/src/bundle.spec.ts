// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterAll, describe, expect, it } from 'vitest';
import { checkBudget, type BundleBudget, type Measured } from './bundle-budget.js';

/**
 * M6-58: the weight of what a learner downloads, held to a stated budget. The build is the real one — `vite build` with
 * `NODE_ENV=production`, into a directory of its own — because a test runner sets `NODE_ENV=test`, and a build under that name bundles
 * the development copy of React and weighs half as much again.
 */
const APP_ROOT = resolve(import.meta.dirname, '..');
const SPEC: BundleBudget = JSON.parse(readFileSync(join(APP_ROOT, 'bundle-budget.json'), 'utf8'));
const out = mkdtempSync(join(tmpdir(), 'learn-bundle-'));
afterAll(() => rmSync(out, { recursive: true, force: true }));

function filesIn(directory: string): string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    return statSync(path).isDirectory() ? filesIn(path) : [path];
  });
}

function measure(directory: string): Measured & { readonly files: number } {
  const files = filesIn(directory);
  const contents = files.map((file) => readFileSync(file));
  return { rawBytes: contents.reduce((sum, bytes) => sum + bytes.length, 0), gzipBytes: contents.reduce((sum, bytes) => sum + gzipSync(bytes).length, 0), files: files.length };
}

describe('the learner bundle is within its budget (M6-58)', () => {
  const built = (() => {
    execFileSync(join(APP_ROOT, 'node_modules/.bin/vite'), ['build', '--outDir', out, '--emptyOutDir'], { cwd: APP_ROOT, stdio: 'pipe', env: { ...process.env, NODE_ENV: 'production' } });
    return measure(out);
  })();

  it('builds the page, the script and the service worker, and weighs no more than the budget, raw or gzipped', () => {
    expect(built.files).toBe(3);
    expect(built.rawBytes).toBeGreaterThan(100_000); // a build of the real app, not an empty one
    expect(checkBudget(built, SPEC)).toEqual([]);
    console.log(`LEARN BUNDLE raw=${built.rawBytes} gzip=${built.gzipBytes} budget=${SPEC.budget.rawBytes}/${SPEC.budget.gzipBytes}`);
  });

  it('ships no source map', () => {
    expect(filesIn(out).filter((file) => file.endsWith('.map'))).toEqual([]);
  });
});

describe('the gate is red on a planted overrun', () => {
  const ok: Measured = { rawBytes: SPEC.baseline.rawBytes, gzipBytes: SPEC.baseline.gzipBytes };

  it('a build over the raw budget, over the gzip budget, or both', () => {
    expect(checkBudget({ ...ok, rawBytes: SPEC.budget.rawBytes + 1 }, SPEC)).toEqual(['RAW_OVER_BUDGET']);
    expect(checkBudget({ ...ok, gzipBytes: SPEC.budget.gzipBytes + 1 }, SPEC)).toEqual(['GZIP_OVER_BUDGET']);
    expect(checkBudget({ rawBytes: SPEC.budget.rawBytes + 1, gzipBytes: SPEC.budget.gzipBytes + 1 }, SPEC)).toEqual(['RAW_OVER_BUDGET', 'GZIP_OVER_BUDGET']);
  });

  it('a budget loosened past the headroom, without the baseline moving with it', () => {
    const loose: BundleBudget = { ...SPEC, budget: { rawBytes: SPEC.baseline.rawBytes * 2, gzipBytes: SPEC.budget.gzipBytes } };
    expect(checkBudget(ok, loose)).toEqual(['BUDGET_LOOSER_THAN_THE_HEADROOM_ALLOWS']);
  });

  it('a baseline recorded above its own budget', () => {
    const upside: BundleBudget = { ...SPEC, baseline: { rawBytes: SPEC.budget.rawBytes + 1, gzipBytes: SPEC.baseline.gzipBytes } };
    expect(checkBudget(ok, upside)).toContain('BASELINE_ABOVE_BUDGET');
  });

  it('and the real budget itself is inside its own headroom, and above what is measured today', () => {
    expect(checkBudget(ok, SPEC)).toEqual([]);
    expect(SPEC.budget.rawBytes).toBeGreaterThan(SPEC.baseline.rawBytes);
  });
});
