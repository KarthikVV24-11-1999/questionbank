// Brings the Compose stack up from nothing, times it, loads the seed, and runs the journey against it (M8-39, M8-40). This is the claim F8 makes, and the `compose` job in .github/workflows/ci.yml
// runs exactly this and nothing else: the workflow holds no assertion of its own (DEC-M0-3), so the budget and the checks are here.
//
//   node infra/compose/boot.mjs
//
// The phases, each timed: build the images; start the database; apply the migrations; start everything else and wait for every healthcheck; load the syllabus and the exam profiles; load the
// demonstration questions. F8 is the sum of those, against a budget of ten minutes (BOOT_BUDGET_SECONDS). Then the journey from sign-up to a first named weakness is run over HTTP against the stack
// (tools/stack-journey/journey.mjs) and its time is reported on its own, since it is not part of getting the stack to boot.
//
// Nothing here is a secret: the three keys the API needs are generated for this run and discarded with it, unless the caller already supplied them. The stack is taken down at the end
// (and its volumes removed) unless KEEP_STACK=1. Exit code 0 means every phase ran, the journey passed, and the boot was inside its budget; the time it took is printed either way.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '../..');
const compose = ['compose', '-f', join(root, 'infra/compose/docker-compose.yml')];
const BUDGET_SECONDS = Number(process.env.BOOT_BUDGET_SECONDS ?? 600);

const mailDir = process.env.QB_MAIL_DIR ?? mkdtempSync(join(tmpdir(), 'qb-mail-'));
// the API runs as an unprivileged user in the container and writes its mail here
chmodSync(mailDir, 0o777);
const env = {
  ...process.env,
  AUTH_SIGNING_KEY: process.env.AUTH_SIGNING_KEY ?? randomBytes(32).toString('base64'),
  AUDIT_ANCHOR_KEY: process.env.AUDIT_ANCHOR_KEY ?? randomBytes(32).toString('base64'),
  FORM_PACKAGE_SIGNING_KEY: process.env.FORM_PACKAGE_SIGNING_KEY ?? randomBytes(32).toString('base64'),
  QB_MAIL_DIR: mailDir,
};
const DATABASE_URL = 'postgres://postgres@localhost:5432/questionbank';

const phases = [];
/** A line a GitHub Actions runner turns into an annotation on the run, readable without the job's log: the failure's cause, and each phase's time. */
const annotate = (level, title, message) => process.stdout.write(`::${level} title=${title}::${message.slice(-3500).replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')}\n`);
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-30).join('\n');
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${tail}`);
  }
  return result.stdout ?? '';
}
function phase(name, fn) {
  const began = performance.now();
  process.stdout.write(`\n=== ${name}\n`);
  fn();
  const seconds = Math.round((performance.now() - began) / 100) / 10;
  phases.push({ name, seconds });
  process.stdout.write(`=== ${name}: ${seconds} s\n`);
  annotate('notice', 'boot phase', `${name}: ${seconds} s`);
}
const docker = (...args) => run('docker', [...compose, ...args]);

let failure;
let journey;
try {
  phase('build the images', () => docker('build'));
  phase('start the database', () => docker('up', '-d', '--wait', 'postgres'));
  phase('apply the migrations', () => docker('run', '--rm', '--no-deps', 'api', 'node', 'migrate.js'));
  phase('start the stack and wait for every healthcheck', () => docker('up', '-d', '--wait'));
  phase('load the syllabus and the exam profiles (pnpm seed)', () => run('corepack', ['pnpm', '--filter', '@questionbank/seed', 'run', 'seed'], { DATABASE_URL }));
  phase('load the demonstration questions (pnpm seed:items)', () => run('corepack', ['pnpm', '--filter', '@questionbank/seed', 'run', 'seed:items'], { DATABASE_URL }));
  const boot = phases.reduce((sum, entry) => sum + entry.seconds, 0);
  process.stdout.write(`\nF8: the stack booted, migrated and seeded in ${Math.round(boot * 10) / 10} s (budget ${BUDGET_SECONDS} s)\n`);
  annotate('notice', 'F8', `the stack booted, migrated and seeded in ${Math.round(boot * 10) / 10} s (budget ${BUDGET_SECONDS} s)`);

  const began = performance.now();
  const steps = run('node', [join(root, 'tools/stack-journey/journey.mjs')], { STACK_URL: 'http://localhost:8080', MAIL_DIR: mailDir });
  journey = Math.round((performance.now() - began) / 100) / 10;
  annotate('notice', 'journey over HTTP', steps);
  if (boot > BUDGET_SECONDS) throw new Error(`F8 fails: the boot took ${boot} s and the budget is ${BUDGET_SECONDS} s`);
} catch (error) {
  failure = error;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`\nFAILED: ${message}\n`);
  const logs = spawnSync('docker', [...compose, 'logs', '--no-color', '--tail', '40'], { cwd: root, env, encoding: 'utf8' });
  process.stdout.write(`${logs.stdout ?? ''}${logs.stderr ?? ''}`);
  annotate('error', 'compose boot failed', `${message}\n--- container logs ---\n${`${logs.stdout ?? ''}${logs.stderr ?? ''}`.trim().split('\n').slice(-25).join('\n')}`);
} finally {
  if (process.env.KEEP_STACK !== '1') spawnSync('docker', [...compose, 'down', '-v', '--remove-orphans'], { cwd: root, env, stdio: 'inherit' });
}

const total = Math.round(phases.reduce((sum, entry) => sum + entry.seconds, 0) * 10) / 10;
process.stdout.write(`\nBOOT PHASES\n${phases.map((entry) => `  ${entry.name.padEnd(62)} ${String(entry.seconds).padStart(7)} s`).join('\n')}\n  ${'total'.padEnd(62)} ${String(total).padStart(7)} s${journey === undefined ? '' : `\n  journey over HTTP (not part of the boot): ${journey} s`}\n`);
if (failure !== undefined) process.exit(1);
