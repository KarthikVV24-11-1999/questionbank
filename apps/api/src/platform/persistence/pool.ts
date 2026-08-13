import { Pool } from 'pg';

/**
 * One `pg.Pool` for the composed application (M0-12), built from the typed
 * config module rather than a bare connection string scattered across call
 * sites. `close` is what `main.ts`'s graceful shutdown (M0-13) calls before
 * exiting, so an in-flight query gets to finish rather than being cut off.
 */
export interface PoolConfig {
  readonly databaseUrl: string;
}

export function createPool(config: PoolConfig): Pool {
  return new Pool({
    connectionString: config.databaseUrl,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
}

export async function closePool(pool: Pool): Promise<void> {
  await pool.end();
}
