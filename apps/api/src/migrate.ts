import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

/**
 * Applies the migrations to the database the process is pointed at (M8-39), once each and in filename order, and says what it did. It is what the Compose stack and a deployment run before the server starts; the tests apply the same files with
 * their own helper (`testing/database.ts`), which keeps no record because every test file starts from nothing.
 *
 * What is applied is recorded in `public.schema_migration`, so running it twice applies nothing the second time, and a migration's `up` and its record are one transaction: a migration that fails leaves no trace, and
 * the next run tries it again. A lock held for the run keeps two migrators from applying the same file together. Only the `up` section of a file is run; there is no way from here to run a `down`.
 */
export interface MigrationOutcome {
  readonly applied: readonly string[];
  readonly alreadyApplied: number;
}

const UP = /-- \+migrate Up([\s\S]*?)-- \+migrate Down/u;
/** An arbitrary constant: the number the lock is taken under. */
const LOCK = 7_204_103;

export function readUpMigrations(directory: string): Array<{ readonly name: string; readonly up: string }> {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const found = UP.exec(readFileSync(join(directory, name), 'utf8'));
      if (found === null) throw new Error(`${name} has no "-- +migrate Up" section followed by a "-- +migrate Down" one`);
      return { name, up: found[1] as string };
    });
}

export async function migrate(pool: Pool, directory: string): Promise<MigrationOutcome> {
  const client = await pool.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [LOCK]);
    await client.query('CREATE TABLE IF NOT EXISTS public.schema_migration (name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())');
    const done = new Set((await client.query<{ name: string }>('SELECT name FROM public.schema_migration')).rows.map((row) => row.name));
    const applied: string[] = [];
    for (const migration of readUpMigrations(directory)) {
      if (done.has(migration.name)) continue;
      try {
        await client.query('BEGIN');
        await client.query(migration.up);
        await client.query('INSERT INTO public.schema_migration (name) VALUES ($1)', [migration.name]);
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${migration.name} failed: ${error instanceof Error ? error.message : String(error)}`);
      }
      applied.push(migration.name);
    }
    return Object.freeze({ applied: Object.freeze(applied), alreadyApplied: done.size });
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [LOCK]).catch(() => undefined);
    client.release();
  }
}

/** The process: `DATABASE_URL` and, optionally, `MIGRATIONS_DIR` (the image puts the files at `/app/migrations`). */
export async function main(): Promise<void> {
  const url = process.env['DATABASE_URL'];
  if (url === undefined || url === '') {
    process.stderr.write('DATABASE_URL is required and was not set\n');
    process.exitCode = 1;
    return;
  }
  const directory = process.env['MIGRATIONS_DIR'] ?? join(process.cwd(), 'migrations');
  const pool = new Pool({ connectionString: url, max: 1 });
  try {
    const outcome = await migrate(pool, directory);
    process.stdout.write(`migrated: ${outcome.applied.length} applied, ${outcome.alreadyApplied} already applied\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  } finally {
    await pool.end();
  }
}

// the same guard as `main.ts`, for the same reason: a spec imports `migrate` without running the process
if (process.env['VITEST'] === undefined) {
  void main();
}
