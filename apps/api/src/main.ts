import 'reflect-metadata';
import { loadConfigFromProcessEnv } from './platform/config/config.js';
import { createApplication } from './platform/composition/app-factory.js';
import { BACKGROUND, type Background } from './platform/composition/background.js';
import { SystemClock } from './platform/persistence/clock.js';
import { systemTimers } from './platform/scheduling/system-timers.js';

/**
 * The process (M0-13). Load config, exit non-zero with the config error's
 * own message on failure, create, listen, trap `SIGTERM`/`SIGINT` and drain.
 * No branch, no rule and no try/catch around business logic lives here —
 * every decision this file could make already belongs to `createApplication`
 * (M0-12) or to `loadConfigFromProcessEnv` (M0-02), which is the whole point
 * of a composition root existing.
 */
export async function main(): Promise<void> {
  const configResult = loadConfigFromProcessEnv();
  if (!configResult.ok) {
    process.stderr.write(`${configResult.error.message}\n`);
    process.exitCode = 1;
    return;
  }

  const config = configResult.value;
  const app = await createApplication(config);
  await app.listen(config.port);

  // The jobs that run beside the server — the outbox relay and the sweeps (M6-38, M6-42) — on real timers, here and nowhere else.
  const clock = new SystemClock();
  const stopJobs = config.backgroundJobsEnabled
    ? app.get<Background>(BACKGROUND).scheduler.start(systemTimers, () => clock.now(), 1_000, (report) => {
        for (const job of report.jobs.filter((outcome) => outcome.outcome === 'failed')) {
          process.stderr.write(`${JSON.stringify({ level: 'error', event: 'background-job-failed', job: job.name, error: job.error, at: report.at })}\n`);
        }
      })
    : (): void => undefined;

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    // Stopped before the application closes, so no job starts against a pool that is being ended.
    stopJobs();
    // `app.close()` drains in-flight requests before resolving (Nest's own
    // shutdown lifecycle) and, for the pool this application built itself,
    // closes it too (app-factory.ts).
    void app.close().then(
      () => process.exit(0),
      () => process.exit(1),
    );
  };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}

// Guards the entry point so a spec can `import { main } from './main.js'`
// and call it under a controlled config/signal without also triggering a
// real boot on import. Not an `import.meta.url` / `process.argv[1]`
// comparison: this repository's own path contains a space, which a bare
// `file://` prefix does not encode the way `import.meta.url` does (so the
// comparison never matched at all), and `vite-node` — the one way this file
// runs without a build step in an offline store with no `ts-node`/`tsx` —
// does not rewrite `argv[1]` to the target script either, so the comparison
// would still fail even path-corrected. `VITEST` is set by every vitest
// runner unconditionally and by nothing else this file's callers use.
if (process.env['VITEST'] === undefined) {
  void main();
}
