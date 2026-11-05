// Brings the Compose stack up from nothing, times it, loads the seed, and runs the journey against it (M8-39, M8-40). This is the claim F8 makes, and the `compose` job in .github/workflows/ci.yml
// runs exactly this and nothing else: the workflow holds no assertion of its own (DEC-M0-3), so the budget and the checks are here.
//
//   node infra/compose/boot.mjs
//
// The phases, each timed: build the images; start the database; apply the migrations; start everything else and wait for every healthcheck; load the syllabus and the exam profiles; load the
// demonstration questions. F8 is the sum of those, against a budget of ten minutes (BOOT_BUDGET_SECONDS). Then the journey from sign-up to a first named weakness is run over HTTP against the stack
// (tools/stack-journey/journey.mjs) and its time is reported on its own, since it is not part of getting the stack to boot. Then the same journey is run in a real Chrome, through the learner app's
// own screens (tools/adversarial/src/stack-journey.ts, M8-44), and reported on its own as well. The stack runs in development mode, where mail is a file the browser run reads: a green run says nothing
// about mail through SES, which no run here can try (docs/M8-ACCEPTANCE.md, D120). Last, the database is backed up, dropped and restored, and the first journey's learner signs in again
// to find their own data (infra/compose/restore-drill.mjs, M8-50). Then the load test at 3x the beta's projected peak and a soak of the same profile (tools/load/load.mjs, M8-51, M8-52); a breach of the NFR
// table's targets, a drift past a threshold or a failed operation fails the run.
//
// Nothing here is a secret: the three keys the API needs are generated for this run and discarded with it, unless the caller already supplied them. The stack is taken down at the end
// (and its volumes removed) unless KEEP_STACK=1. Exit code 0 means every phase ran, the journey passed, and the boot was inside its budget; the time it took is printed either way.
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync } from 'node:fs';
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
  // hex, so it is safe in a URL
  QB_DB_PASSWORD: process.env.QB_DB_PASSWORD ?? randomBytes(18).toString('hex'),
  QB_MAIL_DIR: mailDir,
};
// the database publishes on 127.0.0.1 only (D123), and asks for the password above
const DATABASE_URL = `postgres://postgres:${env.QB_DB_PASSWORD}@127.0.0.1:5432/questionbank`;

const learnerFile = join(mailDir, 'learner.json');
const phases = [];
/** (GitHub shows ten notices a step and drops the rest without a word, so a step's results are few annotations of many lines and not many of one: the boot phases are one.) A line a GitHub Actions runner turns into an annotation on the run, readable without the job's log: the failure's cause, and each phase's time. */
const annotate = (level, title, message) => process.stdout.write(`::${level} title=${title}::${message.slice(-3500).replace(/%/gu, '%25').replace(/\r/gu, '%0D').replace(/\n/gu, '%0A')}\n`);
function run(command, args, extraEnv = {}) {
  const result = spawnSync(command, args, { cwd: root, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) {
    const tail = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.trim().split('\n').slice(-60).join('\n');
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
}
const docker = (...args) => run('docker', [...compose, ...args]);

let failure;
let journey;
let browserJourney;
let restoreDrill;
let loadRun;
let soakRun;
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
  annotate('notice', 'boot phases', phases.map((entry) => `${entry.name}: ${entry.seconds} s`).join('\n'));

  const began = performance.now();
  const steps = run('node', [join(root, 'tools/stack-journey/journey.mjs')], { STACK_URL: 'http://localhost:8080', MAIL_DIR: mailDir, JOURNEY_LEARNER_FILE: learnerFile });
  journey = Math.round((performance.now() - began) / 100) / 10;
  annotate('notice', 'journey over HTTP', steps);

  const reportFile = join(mailDir, 'browser-journey.json');
  const browserBegan = performance.now();
  run('corepack', ['pnpm', '--filter', '@questionbank/adversarial', 'exec', 'vitest', 'run', '--config', 'vitest.stack.config.ts'], { STACK_URL: 'http://localhost:8080', MAIL_DIR: mailDir, STACK_BROWSER_REPORT: reportFile });
  browserJourney = Math.round((performance.now() - browserBegan) / 100) / 10;
  annotate('notice', 'journey in a real browser', JSON.parse(readFileSync(reportFile, 'utf8')).text);

  // the database is backed up, destroyed and restored, and the learner the first journey made signs in to find their own data (M8-50)
  const drillBegan = performance.now();
  const drill = run('node', [join(root, 'infra/compose/restore-drill.mjs')], { STACK_URL: 'http://localhost:8080', MAIL_DIR: mailDir, JOURNEY_LEARNER_FILE: learnerFile });
  restoreDrill = Math.round((performance.now() - drillBegan) / 100) / 10;
  annotate('notice', 'restore drill', drill.slice(drill.indexOf('RESTORE DRILL:')));

  // the load test and the soak (M8-51, M8-52). One source stands in for two hundred, so the SOURCE tiers of three limits are raised for these runs and the subject tiers are not (tools/load/load.mjs).
  const raised = {
    RATE_LIMIT_LOGIN: 'source=100000/10s,1000000/1h;subject=5/1m,30/15m',
    RATE_LIMIT_REGISTER: 'source=100000/10s,1000000/1h;subject=3/1m,10/1h',
    RATE_LIMIT_PROFILE: 'source=100000/1m,1000000/1h;subject=30/1m,300/1h',
  };
  run('docker', [...compose, 'up', '-d', '--force-recreate', '--wait', 'api'], raised);
  const loadBegan = performance.now();
  const loaded = run('node', [join(root, 'tools/load/load.mjs'), 'load'], { STACK_URL: 'http://localhost:8080', METRICS_URL: 'http://127.0.0.1:3000/metrics' });
  loadRun = Math.round((performance.now() - loadBegan) / 100) / 10;
  annotate('notice', 'load test', loaded.slice(loaded.indexOf('RESULTS')));
  const soakBegan = performance.now();
  const soaked = run('node', [join(root, 'tools/load/load.mjs'), 'soak'], { STACK_URL: 'http://localhost:8080', METRICS_URL: 'http://127.0.0.1:3000/metrics', LOAD_SECONDS: '180' });
  soakRun = Math.round((performance.now() - soakBegan) / 100) / 10;
  annotate('notice', 'soak', soaked.slice(soaked.indexOf('SOAK:')));
  if (boot > BUDGET_SECONDS) throw new Error(`F8 fails: the boot took ${boot} s and the budget is ${BUDGET_SECONDS} s`);
} catch (error) {
  failure = error;
  const message = error instanceof Error ? error.message : String(error);
  process.stdout.write(`\nFAILED: ${message}\n`);
  const logs = spawnSync('docker', [...compose, 'logs', '--no-color', '--tail', '40'], { cwd: root, env, encoding: 'utf8' });
  process.stdout.write(`${logs.stdout ?? ''}${logs.stderr ?? ''}`);
  // the failure first and the containers' last lines after it, because an annotation keeps the end of what it is given and what failed is in the middle; a long failure keeps its start (the command and the table) and its end (the verdict, which a soak prints last)
  annotate('error', 'compose boot failed', `${message.length > 2900 ? `${message.slice(0, 1200)}\n...\n${message.slice(-1700)}` : message}\n--- container logs ---\n${`${logs.stdout ?? ''}${logs.stderr ?? ''}`.trim().split('\n').slice(-6).join('\n').slice(-500)}`);
} finally {
  if (process.env.KEEP_STACK !== '1') spawnSync('docker', [...compose, 'down', '-v', '--remove-orphans'], { cwd: root, env, stdio: 'inherit' });
}

const total = Math.round(phases.reduce((sum, entry) => sum + entry.seconds, 0) * 10) / 10;
process.stdout.write(`\nBOOT PHASES\n${phases.map((entry) => `  ${entry.name.padEnd(62)} ${String(entry.seconds).padStart(7)} s`).join('\n')}\n  ${'total'.padEnd(62)} ${String(total).padStart(7)} s${journey === undefined ? '' : `\n  journey over HTTP (not part of the boot): ${journey} s`}${browserJourney === undefined ? '' : `\n  journey in a real browser, with Chrome starting (not part of the boot): ${browserJourney} s`}${restoreDrill === undefined ? '' : `\n  backup, destroy, restore and journey again (not part of the boot): ${restoreDrill} s`}${loadRun === undefined ? '' : `\n  load test (not part of the boot): ${loadRun} s`}${soakRun === undefined ? '' : `\n  soak (not part of the boot): ${soakRun} s`}\n`);
if (failure !== undefined) process.exit(1);
