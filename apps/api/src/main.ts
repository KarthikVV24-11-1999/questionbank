import 'reflect-metadata';
import { loadConfigFromProcessEnv } from './platform/config/config.js';
import { createApplication } from './platform/composition/app-factory.js';

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

  let shuttingDown = false;
  const shutdown = (): void => {
    if (shuttingDown) return;
    shuttingDown = true;
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
// real boot on import — `node dist/main.js` is the only caller for which
// this condition is true.
if (import.meta.url === `file://${process.argv[1]}`) {
  void main();
}
