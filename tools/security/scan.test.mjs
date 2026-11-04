import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { CREDENTIAL_SHAPES, KNOWN_PLANTS, credentialsIn, evaluateAudit } from './scan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const advisory = (severity, over = {}) => ({ severity, module_name: 'left-pad', title: 'a title', vulnerable_versions: '<1.0.1', patched_versions: '>=1.0.1', url: 'https://example.test/x', findings: [{ version: '1.0.0' }, { version: '1.0.0' }], ...over });
const report = (...severities) => ({ advisories: Object.fromEntries(severities.map((severity, index) => [String(index), advisory(severity)])) });

describe('what an audit report is worth', () => {
  it('fails on high and on critical, and not on what is below', () => {
    for (const severity of ['high', 'critical']) assert.equal(evaluateAudit(report(severity)).failing.length, 1, severity);
    for (const severity of ['low', 'moderate']) {
      const verdict = evaluateAudit(report(severity));
      assert.deepEqual([verdict.failing.length, verdict.below.length], [0, 1], severity);
    }
  });

  it('sorts a mixed report by the level asked for', () => {
    const mixed = report('low', 'moderate', 'high', 'critical');
    assert.deepEqual(evaluateAudit(mixed, 'high').failing.map((f) => f.severity), ['high', 'critical']);
    assert.deepEqual(evaluateAudit(mixed, 'critical').failing.map((f) => f.severity), ['critical']);
    assert.deepEqual(evaluateAudit(mixed, 'low').failing.length, 4);
  });

  it('treats a severity it does not know as the worst, and refuses a level it does not know', () => {
    assert.equal(evaluateAudit(report('catastrophic')).failing.length, 1);
    assert.throws(() => evaluateAudit(report('high'), 'severe'), /AUDIT_LEVEL/u);
  });

  it('is nothing for an answer that is not an audit report, so that it cannot read as a clean one', () => {
    for (const answer of [undefined, null, 'ok', 3, {}, { advisories: null }, { error: { code: 'ENOTFOUND' } }]) assert.equal(evaluateAudit(answer), null, JSON.stringify(answer));
  });

  it('says what is installed once, and what would fix it', () => {
    const [finding] = evaluateAudit(report('high')).failing;
    assert.deepEqual(finding.installed, ['1.0.0']);
    assert.equal(finding.patched, '>=1.0.1');
  });

  it('an empty report is a clean one', () => {
    assert.deepEqual(evaluateAudit({ advisories: {} }), { failing: [], below: [] });
  });
});

describe('text shaped like a credential', () => {
  const planted = {
    'a private key': `${'-----BEGIN '}RSA PRIVATE KEY-----`,
    'an AWS access key id': `const id = '${'AK' + 'IA'}ABCDEFGHIJKLMNOP';`,
    'an AWS secret access key': `AWS_SECRET_ACCESS_KEY=${'a1B2c3D4e5'.repeat(4)}`,
    'a GitHub token': `token: ${'gh' + 'p_'}${'a'.repeat(36)}`,
    'a Slack token': `${'xo' + 'xb-'}1234567890-abcdefghij`,
    'a provider API key': `key = "${'s' + 'k-'}${'a'.repeat(40)}"`,
  };

  it('is found, for each shape, with the file, the line and what it looks like', () => {
    assert.deepEqual(Object.keys(planted).sort(), CREDENTIAL_SHAPES.map((shape) => shape.name).sort());
    for (const [what, text] of Object.entries(planted)) assert.deepEqual(credentialsIn('a.ts', `first\n${text}\nthird`), [{ path: 'a.ts', line: 2, what }], what);
  });

  it('is not found in what only looks like a placeholder or a name', () => {
    for (const text of ['AWS_ACCESS_KEY_ID=', 'AWS_SECRET_ACCESS_KEY=', 'AKIDEXAMPLE0000000', "accessKeyId: 'AKIDEXAMPLE0000000'", 'sk-short', 'the word PRIVATE KEY alone', 'ghp_short', 'AWS_SECRET_ACCESS_KEY: ${AWS_SECRET_ACCESS_KEY:-}']) {
      assert.deepEqual(credentialsIn('a.ts', text), [], text);
    }
  });
});

describe('the files excused for looking like credentials', () => {
  it('each exists and still looks like one, so an excuse that has gone stale is seen', () => {
    for (const plant of KNOWN_PLANTS) {
      assert.ok(existsSync(join(root, plant.path)), plant.path);
      assert.notDeepEqual(credentialsIn(plant.path, readFileSync(join(root, plant.path), 'utf8')), [], plant.path);
      assert.ok(plant.reason.length > 10, plant.path);
    }
  });
});

describe('the script, run as the job runs it', () => {
  /** A `corepack` that answers `pnpm audit --json` with a file, so the run needs no network and the answer is the test's. */
  function runWith(answer, level, scanRoot) {
    const dir = mkdtempSync(join(tmpdir(), 'qb-scan-'));
    writeFileSync(join(dir, 'answer.json'), answer);
    writeFileSync(join(dir, 'corepack'), `#!/bin/sh\ncat "${join(dir, 'answer.json')}"\n`);
    chmodSync(join(dir, 'corepack'), 0o755);
    return spawnSync(process.execPath, [join(here, 'scan.mjs')], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, ...(level === undefined ? {} : { AUDIT_LEVEL: level }), ...(scanRoot === undefined ? {} : { SCAN_ROOT: scanRoot }) } });
  }

  it('exits 0 for a clean report, and says so', () => {
    const run = runWith(JSON.stringify({ advisories: {} }));
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /dependency audit: 0 at high or above, 0 below/u);
  });

  it('exits 1 for a finding at high, naming it, and exits 0 for one below it', () => {
    const failing = runWith(JSON.stringify(report('high')));
    assert.equal(failing.status, 1);
    assert.match(failing.stdout, /::error title=dependency audit: 1 at high or above::high\s+left-pad@1\.0\.0/u);
    const below = runWith(JSON.stringify(report('moderate')));
    assert.equal(below.status, 0);
    assert.match(below.stdout, /::warning title=dependency audit: 1 below high/u);
  });

  it('exits 1 when the audit cannot be made: an answer that is not an audit, and nothing at all', () => {
    for (const answer of ['', 'not json', JSON.stringify({ error: { code: 'ENOTFOUND' } })]) {
      const run = runWith(answer);
      assert.equal(run.status, 1, answer);
      assert.match(run.stdout, /dependency audit could not be made/u);
    }
  });

  it('takes the level from the environment', () => {
    assert.equal(runWith(JSON.stringify(report('moderate')), 'moderate').status, 1);
  });

  /** A repository of its own: one tracked file, and one that is present but not tracked. */
  function repository(tracked, untracked) {
    const dir = mkdtempSync(join(tmpdir(), 'qb-repo-'));
    const git = (...args) => spawnSync('git', args, { cwd: dir, encoding: 'utf8' });
    git('init', '-q');
    writeFileSync(join(dir, 'tracked.txt'), tracked);
    git('add', 'tracked.txt');
    if (untracked !== undefined) writeFileSync(join(dir, 'untracked.txt'), untracked);
    return dir;
  }
  const key = `${'AK' + 'IA'}ABCDEFGHIJKLMNOP`;

  it('exits 1 for a credential-shaped line in a tracked file, naming the file and the line, and not the credential', () => {
    const run = runWith(JSON.stringify({ advisories: {} }), undefined, repository(`one\nid = ${key}\n`));
    assert.equal(run.status, 1);
    assert.match(run.stdout, /::error title=credential scan: 1 found::tracked\.txt:2 looks like an AWS access key id/u);
    assert.ok(!run.stdout.includes(key));
  });

  it('exits 0 for a repository with nothing in it, and does not read a file that is not tracked', () => {
    const run = runWith(JSON.stringify({ advisories: {} }), undefined, repository('nothing here\n', `id = ${key}\n`));
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /credential scan: 0 found in 1 tracked files/u);
  });
});

