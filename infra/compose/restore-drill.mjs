// The restore drill (M8-50): `node infra/compose/restore-drill.mjs`, run by boot.mjs after the journeys, against the stack it has just booted and used.
//
// It takes the stack's database as the journeys left it, backs it up with backup.sh, DESTROYS it, restores it with restore.sh, and then shows two things: that every table holds the rows
// it held (an exact count of each, compared as one text), and that a learner who registered, sat the diagnostic and was named a weakness before the backup is still all of that after: they
// sign in with their own password, their exam is chosen, and the map holds what they answered (tools/stack-journey/returning.mjs). Then the stack is started again and the HTTP journey is run
// once more, with a new learner, against the restored database.
//
// What is not proved is registered as D128 in docs/DEBT.md.
//
// What this proves: that these two scripts bring back what this stack's journeys made, on this stack's volume. What it does not: a drill on a host (the owner's, DEPLOYMENT.md), a backup
// kept anywhere but the disk it protects, a point-in-time recovery, or a restore of a database larger than a few hundred kilobytes.
//
// Needs: the stack up; MAIL_DIR (for the second journey); JOURNEY_LEARNER_FILE (who the first journey made). QB_DOCKER names the docker binary, for a test that stands in for it.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '../..');
const docker = process.env.QB_DOCKER ?? 'docker';
const compose = ['compose', '-f', join(here, 'docker-compose.yml')];
const BASE = process.env.STACK_URL ?? 'http://localhost:8080';

/** Every table's exact row count, as one text, in a fixed order: two databases with the same text hold the same number of rows in every table. */
export const FINGERPRINT_SQL = `SELECT string_agg(table_schema || '.' || table_name || '=' || (xpath('/row/c/text()', query_to_xml(format('select count(*) as c from %I.%I', table_schema, table_name), false, true, '')))[1]::text, E'\\n' ORDER BY table_schema, table_name)
  FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema') AND table_type = 'BASE TABLE'`;

const sh = (command, args, env = {}) => spawnSync(command, args, { cwd: root, env: { ...process.env, ...env }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const step = (name, fn) => {
  const began = performance.now();
  process.stdout.write(`--- ${name}\n`);
  const value = fn();
  const seconds = Math.round((performance.now() - began) / 100) / 10;
  process.stdout.write(`--- ${name}: ${seconds} s\n`);
  timings.push(`${name}: ${seconds} s`);
  return value;
};
const timings = [];
function must(result, what) {
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`${what} exited ${result.status}\n${(result.stderr ?? '').trim().split('\n').slice(-8).join('\n')}`);
  return result.stdout ?? '';
}
const psql = (sql, database = 'questionbank') => sh(docker, [...compose, 'exec', '-T', 'postgres', 'psql', '-U', 'postgres', '-d', database, '-At', '-c', sql]);
const fingerprint = () => must(psql(FINGERPRINT_SQL), 'the fingerprint query').trim();

export function drill() {
  const dir = mkdtempSync(join(tmpdir(), 'qb-backup-'));
  const file = join(dir, 'questionbank.dump');

  step('stop the services that write', () => must(sh(docker, [...compose, 'stop', 'api', 'learn', 'studio']), 'docker compose stop'));
  const before = step('count every table', fingerprint);
  const tables = before.split('\n').length;
  const rows = before.split('\n').reduce((sum, line) => sum + Number(line.split('=')[1]), 0);

  step('back up', () => must(sh('sh', [join(here, 'backup.sh'), file], { QB_DOCKER: docker }), 'backup.sh'));
  const bytes = statSync(file).size;
  if (bytes < 10_000) throw new Error(`the backup is ${bytes} bytes`);

  step('destroy the database', () => {
    must(psql('DROP DATABASE questionbank WITH (FORCE)', 'postgres'), 'dropping the database');
    // destroyed means it cannot be connected to, not that the command said so
    if (psql('select 1').status === 0) throw new Error('the database is still there after it was dropped');
  });

  step('restore', () => must(sh('sh', [join(here, 'restore.sh'), file], { QB_DOCKER: docker }), 'restore.sh'));
  const after = step('count every table again', fingerprint);
  if (after !== before) {
    const was = new Map(before.split('\n').map((line) => line.split('=')));
    const differs = after.split('\n').filter((line) => was.get(line.split('=')[0]) !== line.split('=')[1]);
    throw new Error(`the restored database differs from the one backed up:\n${differs.slice(0, 10).join('\n') || '(tables missing)'}`);
  }

  step('start the stack again', () => must(sh(docker, [...compose, 'up', '-d', '--wait']), 'docker compose up'));
  step('the learner from before signs in and finds their own data', () => must(sh('node', [join(root, 'tools/stack-journey/returning.mjs')], { STACK_URL: BASE }), 'returning.mjs'));
  step('the journey over HTTP, with a new learner, on the restored database', () => must(sh('node', [join(root, 'tools/stack-journey/journey.mjs')], { STACK_URL: BASE }), 'journey.mjs'));

  const summary = `RESTORE DRILL: ${tables} tables, ${rows} rows backed up (${bytes} bytes), the database dropped, restored, every table counted the same, the learner from before signed in and found their answers, a new learner ran the journey.\n${timings.map((line) => `  ${line}`).join('\n')}`;
  process.stdout.write(`\n${summary}\n`);
  return summary;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    drill();
  } catch (error) {
    process.stdout.write(`\nRESTORE DRILL FAILED: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}
