import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, DATABASE_URL, type TestDatabase } from './testing/database.js';
import { main, migrate, readUpMigrations } from './migrate.js';

/**
 * The migrator the stack runs before the server starts (M8-39), against a real database of its own: a scratch database made beside the test one, so that its record of what has been applied
 * (`public.schema_migration`) is not the test database's and the specs that migrate that one up and down are not disturbed.
 */
let admin: TestDatabase;
let pool: Pool;
let name: string;

beforeAll(async () => {
  admin = await connectTestDatabase();
  name = `migrate_${Date.now().toString(36)}`;
  await admin.pool.query(`CREATE DATABASE ${name}`);
  pool = new Pool({ connectionString: DATABASE_URL.replace(/\/[^/]+$/u, `/${name}`), max: 2 });
});
afterAll(async () => {
  await pool.end();
  await admin.pool.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.close();
});

function directory(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'migrations-'));
  for (const [file, contents] of Object.entries(files)) writeFileSync(join(dir, file), contents);
  return dir;
}
const section = (up: string) => `-- +migrate Up\n${up}\n-- +migrate Down\nSELECT 1;\n`;
const tables = async (): Promise<string[]> => (await pool.query<{ table_name: string }>("SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'mig\\_%' ORDER BY 1")).rows.map((row) => row.table_name);

describe('the migrator (M8-39)', () => {
  it('reads the up section of each file in filename order, and refuses a file that has none', () => {
    const dir = directory({ '002_b.sql': section('CREATE TABLE mig_b (id int);'), '001_a.sql': section('CREATE TABLE mig_a (id int);'), 'README.md': 'not a migration' });
    expect(readUpMigrations(dir).map((m) => [m.name, m.up.trim()])).toEqual([['001_a.sql', 'CREATE TABLE mig_a (id int);'], ['002_b.sql', 'CREATE TABLE mig_b (id int);']]);
    expect(() => readUpMigrations(directory({ '001_x.sql': 'CREATE TABLE nothing (id int);' }))).toThrow('001_x.sql has no "-- +migrate Up" section');
  });

  it('applies each once, in order, records them, and applies nothing the second time', async () => {
    const dir = directory({ '001_a.sql': section('CREATE TABLE mig_a (id int);'), '002_b.sql': section('CREATE TABLE mig_b (id int); INSERT INTO mig_a VALUES (1);') });
    expect(await migrate(pool, dir)).toEqual({ applied: ['001_a.sql', '002_b.sql'], alreadyApplied: 0 });
    expect(await tables()).toEqual(['mig_a', 'mig_b']);
    expect(await migrate(pool, dir)).toEqual({ applied: [], alreadyApplied: 2 });
    expect((await pool.query('SELECT name FROM public.schema_migration ORDER BY name')).rows.map((row) => row.name)).toEqual(['001_a.sql', '002_b.sql']);
  });

  it('applies only what is new when files are added', async () => {
    const dir = directory({ '001_a.sql': section('CREATE TABLE IF NOT EXISTS mig_a (id int);'), '002_b.sql': section('CREATE TABLE IF NOT EXISTS mig_b (id int);'), '003_c.sql': section('CREATE TABLE mig_c (id int);') });
    expect(await migrate(pool, dir)).toEqual({ applied: ['003_c.sql'], alreadyApplied: 2 });
    expect(await tables()).toEqual(['mig_a', 'mig_b', 'mig_c']);
  });

  it('leaves no trace of a migration that fails, names it, and tries it again on the next run', async () => {
    const dir = directory({ '001_a.sql': section('CREATE TABLE IF NOT EXISTS mig_a (id int);'), '004_bad.sql': section('CREATE TABLE mig_half (id int); SELECT * FROM mig_no_such_table;') });
    await expect(migrate(pool, dir)).rejects.toThrow(/migration 004_bad\.sql failed: .*mig_no_such_table/u);
    expect(await tables()).not.toContain('mig_half');
    expect((await pool.query("SELECT 1 FROM public.schema_migration WHERE name = '004_bad.sql'")).rowCount).toBe(0);
    writeFileSync(join(dir, '004_bad.sql'), section('CREATE TABLE mig_half (id int);'));
    expect((await migrate(pool, dir)).applied).toEqual(['004_bad.sql']);
  });

  it('does not run two migrators over one database at once: the second waits for the first', async () => {
    const dir = directory({ '001_a.sql': section('CREATE TABLE IF NOT EXISTS mig_a (id int);'), '005_slow.sql': section('SELECT pg_sleep(0.4); CREATE TABLE mig_slow (id int);') });
    const [first, second] = await Promise.all([migrate(pool, dir), migrate(pool, dir)]);
    expect([first.applied.length, second.applied.length].sort()).toEqual([0, 1]);
  });

  it('is the process the image runs: it reads DATABASE_URL and MIGRATIONS_DIR, says what it did, and sets a failing exit code on a bad migration or no database', async () => {
    const dir = directory({ '001_a.sql': section('CREATE TABLE IF NOT EXISTS mig_a (id int);') });
    const out: string[] = [];
    const err: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const writeErr = process.stderr.write.bind(process.stderr);
    process.stdout.write = ((chunk: string) => (out.push(chunk), true)) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string) => (err.push(chunk), true)) as typeof process.stderr.write;
    const was = { url: process.env['DATABASE_URL'], dir: process.env['MIGRATIONS_DIR'], code: process.exitCode };
    try {
      process.env['DATABASE_URL'] = DATABASE_URL.replace(/\/[^/]+$/u, `/${name}`);
      process.env['MIGRATIONS_DIR'] = dir;
      await main();
      expect(out.join('')).toMatch(/^migrated: \d+ applied, \d+ already applied/u);
      expect(process.exitCode).toBeUndefined();

      writeFileSync(join(dir, '009_bad.sql'), section('SELECT * FROM mig_never;'));
      await main();
      expect(err.join('')).toContain('migration 009_bad.sql failed');
      expect(process.exitCode).toBe(1);

      process.exitCode = undefined;
      delete process.env['DATABASE_URL'];
      await main();
      expect(err.join('')).toContain('DATABASE_URL is required');
      expect(process.exitCode).toBe(1);
    } finally {
      process.stdout.write = write;
      process.stderr.write = writeErr;
      if (was.url === undefined) delete process.env['DATABASE_URL'];
      else process.env['DATABASE_URL'] = was.url;
      if (was.dir === undefined) delete process.env['MIGRATIONS_DIR'];
      else process.env['MIGRATIONS_DIR'] = was.dir;
      process.exitCode = was.code;
    }
  });

  it('applies the repository\'s own migrations to an empty database, all of them, which is what the stack does first', async () => {
    const fresh = `${name}_real`;
    await admin.pool.query(`CREATE DATABASE ${fresh}`);
    const realPool = new Pool({ connectionString: DATABASE_URL.replace(/\/[^/]+$/u, `/${fresh}`), max: 1 });
    try {
      const outcome = await migrate(realPool, join(import.meta.dirname, '../../../infra/migrations'));
      expect(outcome.applied.length).toBeGreaterThan(50);
      expect((await realPool.query("SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'identity'")).rows[0].n).toBeGreaterThan(0);
      expect((await migrate(realPool, join(import.meta.dirname, '../../../infra/migrations'))).applied).toEqual([]);
    } finally {
      await realPool.end();
      await admin.pool.query(`DROP DATABASE IF EXISTS ${fresh} WITH (FORCE)`);
    }
  });
});

