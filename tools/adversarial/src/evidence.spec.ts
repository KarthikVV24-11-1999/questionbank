import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { freshChrome, newProfileDir, runScenario, type RunEnvironment } from './browser-run.js';
import { generateScenario } from './scenario.js';

/**
 * A run that times out keeps what a developer needs to read afterwards (D80). The page here is one that logs, asks the server for something and
 * never renders a question, so the wait for the question is the one that times out; what it left must say what the page did.
 */
const roots: string[] = [];
const dist = mkdtempSync(join(tmpdir(), 'qb-evidence-dist-'));
const evidenceDir = mkdtempSync(join(tmpdir(), 'qb-evidence-out-'));
roots.push(dist, evidenceDir);
writeFileSync(join(dist, 'index.html'), '<!doctype html><title>stuck</title><p>boot never finishes</p><script>console.error("planted-console-line"); fetch("/v1/planted-request");</script>');
const environment: RunEnvironment = { distDir: dist, chrome: { current: null, profileDir: newProfileDir() } };

beforeAll(async () => {
  process.env['QB_ADVERSARIAL_EVIDENCE_DIR'] = evidenceDir; // the default place, so that a run that should leave nothing is looked for where it would leave it
  await freshChrome(environment);
});
afterAll(async () => {
  await environment.chrome.current?.close();
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('a run that times out waiting for the question', () => {
  const SEED = 20_261_026;

  it('keeps the page console, the network log, a screenshot and what the page showed, under the seed', async () => {
    await expect(runScenario(generateScenario(SEED), environment, { waitMs: 3_000 })).rejects.toThrow(/Timeout|timed out/iu);
    const where = join(evidenceDir, `seed-${SEED}`);
    expect(readFileSync(join(where, 'console.log'), 'utf8')).toContain('planted-console-line');
    const network = readFileSync(join(where, 'network.log'), 'utf8');
    expect(network).toMatch(/-> GET http:\/\/127\.0\.0\.1:\d+\/v1\/planted-request/u);
    expect(network).toMatch(/<- 404 GET http:\/\/127\.0\.0\.1:\d+\/v1\/planted-request/u);
    expect(readFileSync(join(where, 'screenshot.png')).subarray(1, 4).toString('latin1')).toBe('PNG');
    const summary = JSON.parse(readFileSync(join(where, 'summary.json'), 'utf8')) as { seed: number; serverRequests: string[]; page: { text: string } };
    expect(summary.seed).toBe(SEED);
    expect(summary.serverRequests).toContain('GET /v1/planted-request');
    expect(summary.page.text).toContain('boot never finishes');
  });

  it('leaves nothing when the run is meant to fail', async () => {
    await expect(runScenario(generateScenario(SEED + 1), environment, { waitMs: 3_000, evidence: false })).rejects.toThrow();
    expect(existsSync(join(evidenceDir, `seed-${SEED + 1}`))).toBe(false);
  });
});
