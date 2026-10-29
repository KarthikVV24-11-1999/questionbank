#!/usr/bin/env node
// Measures envelope conformance (M7-63): runs the suites that emit analytics events with a log marker made, then replays what they emitted through the real edge.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const log = join(mkdtempSync(join(tmpdir(), 'qb-events-')), 'events.ndjson');
writeFileSync(log, '');
// the suites find the log through this marker, not the environment (see `event-log.ts`)
const marker = join(tmpdir(), 'qb-event-log.path');
writeFileSync(marker, log);
const root = resolve(import.meta.dirname, '../../..');
const run = (cwd, args, env = {}) => {
  const result = spawnSync('npx', ['vitest', 'run', ...args], { cwd: join(root, cwd), stdio: 'inherit', env: { ...process.env, ...env } });
  if (result.status !== 0) {
    rmSync(marker, { force: true });
    process.exit(result.status ?? 1);
  }
};
run('apps/learn', ['src/ui', 'src/analytics']);
run('apps/api', ['--project', 'unit', 'src/platform/composition/learning-consumer.spec.ts']);
run('apps/api', ['--project', 'unit', 'src/fitness/event-conformance-run.spec.ts'], { QB_EVENT_LOG_REPLAY: log });
rmSync(marker, { force: true });
