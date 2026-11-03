import { randomUUID } from 'node:crypto';
import { bootstrapFirstAdmin } from './contexts/identity/public/composition.js';
import { loadConfigFromProcessEnv, type AppConfig, type ConfigResult } from './platform/config/config.js';
import { SystemClock } from './platform/persistence/clock.js';
import { PostgresAuditRecorder } from './platform/persistence/audit-recorder.js';
import { createPool } from './platform/persistence/pool.js';

/**
 * The first administrator (M8-12): `pnpm --filter @questionbank/api bootstrap-admin <email>`, run with the application's own environment, of which it reads the database address and nothing else (through the typed configuration, like `main.ts`).
 *
 * Roles are assigned by an administrator, so the first has to come from somewhere else. This is the somewhere: one command that makes a registered person with a verified address an
 * `admin`, and only while no enabled admin exists. It is audited as the system. Run again, or run on a live system, it refuses and changes nothing. A seeded migration would carry a
 * name into every environment, including ones nobody meant to have an administrator, and a hand-written UPDATE leaves no audit row; this does neither.
 *
 * Exit status: 0 when the person was made an administrator, 1 when the command refused (the reason is printed), 2 when it could not run.
 */
export async function run(argv: readonly string[], load: () => ConfigResult<Pick<AppConfig, 'databaseUrl'>>, write: (line: string) => void): Promise<number> {
  const email = argv[0];
  if (email === undefined || argv.length !== 1) {
    write('usage: bootstrap-admin <email>');
    return 2;
  }
  const config = load();
  if (!config.ok) {
    write(config.error.message);
    return 2;
  }
  const pool = createPool({ databaseUrl: config.value.databaseUrl });
  try {
    const result = await bootstrapFirstAdmin({ pool, clock: new SystemClock(), audit: new PostgresAuditRecorder(pool) }, email, randomUUID());
    if (result.ok) {
      write(`${email.trim().toLowerCase()} is now an administrator`);
      return 0;
    }
    write(result.error.message);
    return 1;
  } catch (error) {
    write(`could not run: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  } finally {
    await pool.end();
  }
}

if (process.env['VITEST'] === undefined) {
  void run(process.argv.slice(2), loadConfigFromProcessEnv, (line) => process.stdout.write(`${line}\n`)).then((code) => process.exit(code));
}
