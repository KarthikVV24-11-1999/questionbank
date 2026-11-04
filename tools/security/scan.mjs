// The security scan (M8-48): `node tools/security/scan.mjs`, run by the `security` job in .github/workflows/ci.yml, which holds no assertion of its own (DEC-M0-3).
//
// WHAT IT COVERS. Two things, and no more:
//   1. The dependency audit: `pnpm audit` over the lockfile, against the advisories the registry publishes. A finding at AUDIT_LEVEL (default `high`) or above fails the run. Lower
//      findings are printed and do not. An audit that cannot be made (no network, an answer that is not an audit) fails the run too, because a gate that could not look has not passed.
//   2. A scan of every tracked file for text shaped like a credential: a private key, an AWS access key id, a GitHub or Slack token. It reads the files, so it needs no network.
//
// WHAT IT DOES NOT COVER. A dependency audit sees published advisories about this lockfile and nothing about this code's own logic, authorization or data handling: a route that
// forgets to check who is asking passes it. It does not see an advisory not yet published, or a package that is malicious and unreported. The credential scan finds shapes, not secrets:
// a password in a variable called `x` passes it. Neither is a manual security review (an M8 acceptance line, not yet done) or an independent penetration test (M9's); D125 in docs/DEBT.md
// carries the gap. A green run of this script is the absence of those findings, and not the presence of security.
//
// Exit code 0: nothing at or above the level, no credential-shaped text, and both looks were made. 1: a finding, or a look that could not be made.
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SEVERITIES = ['low', 'moderate', 'high', 'critical'];

/** What an audit report says, as the findings at or above a level and the ones below it. `null` when the report is not an audit report at all. */
export function evaluateAudit(report, level = 'high') {
  if (!SEVERITIES.includes(level)) throw new Error(`AUDIT_LEVEL must be one of ${SEVERITIES.join(', ')}`);
  if (typeof report !== 'object' || report === null || typeof report.advisories !== 'object' || report.advisories === null) return null;
  const floor = SEVERITIES.indexOf(level);
  const findings = Object.values(report.advisories).map((advisory) => ({
    severity: String(advisory.severity),
    module: String(advisory.module_name),
    title: String(advisory.title),
    vulnerable: String(advisory.vulnerable_versions),
    patched: String(advisory.patched_versions),
    installed: [...new Set((advisory.findings ?? []).map((found) => String(found.version)))],
    url: String(advisory.url ?? ''),
  }));
  // a severity this script does not know is treated as the worst there is, not as nothing
  const rank = (finding) => (SEVERITIES.includes(finding.severity) ? SEVERITIES.indexOf(finding.severity) : SEVERITIES.length);
  return { failing: findings.filter((finding) => rank(finding) >= floor), below: findings.filter((finding) => rank(finding) < floor) };
}

/** Text shaped like a credential, each with what it is. A pattern excuses nothing: a file that has to contain one for a test builds it from parts. */
export const CREDENTIAL_SHAPES = [
  { name: 'a private key', pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/u },
  { name: 'an AWS access key id', pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u },
  { name: 'an AWS secret access key', pattern: /\bAWS_SECRET_ACCESS_KEY\s*[=:]\s*['"]?[A-Za-z0-9/+]{40}['"]?(?![A-Za-z0-9/+])/u },
  { name: 'a GitHub token', pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/u },
  { name: 'a Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}\b/u },
  { name: 'a provider API key', pattern: /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/u },
];

export function credentialsIn(path, text) {
  const found = [];
  text.split('\n').forEach((line, index) => {
    for (const shape of CREDENTIAL_SHAPES) if (shape.pattern.test(line)) found.push({ path, line: index + 1, what: shape.name });
  });
  return found;
}

/**
 * Files that are credential-shaped on purpose, each excused by exact path and for a stated reason, and counted in the output. The fitness rule F39 (`secret-rules.ts`) is tested by
 * planting a credential and seeing it found; the planted files cannot avoid looking like what they plant. A new entry is a reviewed diff.
 */
export const KNOWN_PLANTS = [
  { path: 'apps/api/src/fitness-fixtures/as-committed-secret/planted-aws-key.ts', reason: 'planted so secret-rules.spec.ts can see F39 find an AWS key id' },
  { path: 'apps/api/src/fitness-fixtures/as-committed-secret/planted-pem.ts', reason: 'planted so secret-rules.spec.ts can see F39 find a private key' },
];

const here = dirname(fileURLToPath(import.meta.url));
// SCAN_ROOT is for the script's own test, which scans a repository of its own making
const root = process.env.SCAN_ROOT ?? join(here, '../..');
const run = (command, args) => spawnSync(command, args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
/** A line a GitHub Actions runner turns into an annotation, readable without the job's log. */
const annotate = (level, title, message) => process.stdout.write(`::${level} title=${title}::${message.slice(-3500).replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')}\n`);

export function main(level = process.env.AUDIT_LEVEL ?? 'high') {
  let failed = false;

  const audit = run('corepack', ['pnpm', 'audit', '--json']);
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    report = undefined;
  }
  const verdict = evaluateAudit(report, level);
  if (verdict === null) {
    failed = true;
    annotate('error', 'dependency audit could not be made', `pnpm audit answered something that is not an audit report (exit ${audit.status}):\n${(audit.stdout || audit.stderr || '').slice(0, 800)}`);
  } else {
    const line = (finding) => `${finding.severity.padEnd(8)} ${finding.module}@${finding.installed.join(',')}  ${finding.title}  (patched in ${finding.patched})`;
    if (verdict.below.length > 0) annotate('warning', `dependency audit: ${verdict.below.length} below ${level}`, verdict.below.map(line).join('\n'));
    if (verdict.failing.length > 0) {
      failed = true;
      annotate('error', `dependency audit: ${verdict.failing.length} at ${level} or above`, verdict.failing.map(line).join('\n'));
    }
    process.stdout.write(`dependency audit: ${verdict.failing.length} at ${level} or above, ${verdict.below.length} below\n`);
  }

  const listed = run('git', ['ls-files', '-z']);
  if (listed.status !== 0) {
    failed = true;
    annotate('error', 'credential scan could not list the files', listed.stderr);
  } else {
    const hits = [];
    const planted = new Set(KNOWN_PLANTS.map((plant) => plant.path));
    let excused = 0;
    for (const path of listed.stdout.split('\0').filter((name) => name !== '')) {
      if (planted.has(path)) {
        excused += 1;
        continue;
      }
      let text;
      try {
        text = readFileSync(join(root, path), 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\0')) continue;
      hits.push(...credentialsIn(path, text));
    }
    if (hits.length > 0) {
      failed = true;
      annotate('error', `credential scan: ${hits.length} found`, hits.map((hit) => `${hit.path}:${hit.line} looks like ${hit.what}`).join('\n'));
    }
    process.stdout.write(`credential scan: ${hits.length} found in ${listed.stdout.split('\0').length - 1 - excused} tracked files (${excused} planted on purpose, excused by path)\n`);
  }
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
