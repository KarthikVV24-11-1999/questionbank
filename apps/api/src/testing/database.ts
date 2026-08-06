import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Pool } from 'pg';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import { sql } from 'drizzle-orm';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../../../infra/migrations');

/**
 * Defaults to the port the Compose stack publishes. A machine running Postgres
 * elsewhere sets DATABASE_URL; nothing here depends on a particular port.
 */
export const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://postgres@127.0.0.1:5432/questionbank_test';

export interface MigrationFile {
  readonly name: string;
  readonly up: string;
  readonly down: string;
}

/** Reads `-- +migrate Up` / `-- +migrate Down` sections, in filename order. */
export function readMigrations(): MigrationFile[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => {
      const contents = readFileSync(join(MIGRATIONS_DIR, name), 'utf8');
      const [, up = '', down = ''] = /-- \+migrate Up([\s\S]*?)-- \+migrate Down([\s\S]*)/u.exec(contents) ?? [];
      return { name, up, down };
    });
}

export interface TestDatabase {
  readonly db: NodePgDatabase;
  readonly pool: Pool;
  applyMigrations(): Promise<void>;
  revertMigrations(): Promise<void>;
  truncateAll(): Promise<void>;
  close(): Promise<void>;
}

export async function connectTestDatabase(): Promise<TestDatabase> {
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  const db = drizzle(pool);

  return {
    db,
    pool,
    async applyMigrations() {
      for (const migration of readMigrations()) {
        await pool.query(migration.up);
      }
    },
    async revertMigrations() {
      for (const migration of [...readMigrations()].reverse()) {
        await pool.query(migration.down);
      }
    },
    async truncateAll() {
      // The outbox is truncated with the aggregates it belongs to, so no spec
      // depends on the order the spec files happen to run in.
      await db.execute(sql`
        TRUNCATE curriculum.taxonomy_mapping, curriculum.taxonomy_migration,
                 curriculum.exam_section_spec, curriculum.exam_profile_version, curriculum.exam,
                 curriculum.prerequisite_edge, curriculum.concept_node,
                 curriculum.concept_identity, curriculum.taxonomy_version,
                 platform.outbox_message
        RESTART IDENTITY CASCADE
      `);
    },
    async close() {
      await pool.end();
    },
  };
}

/** A clean, fully migrated database for one test file. */
export async function withMigratedDatabase(): Promise<TestDatabase> {
  const database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  return database;
}
