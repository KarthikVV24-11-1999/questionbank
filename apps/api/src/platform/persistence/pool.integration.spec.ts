import { describe, expect, it } from 'vitest';
import { DATABASE_URL } from '../../testing/database.js';
import { closePool, createPool } from './pool.js';

describe('createPool/closePool — against real Postgres', () => {
  it('executes a query against the real database', async () => {
    const pool = createPool({ databaseUrl: DATABASE_URL });
    try {
      const { rows } = await pool.query<{ ok: number }>('SELECT 1 AS ok');
      expect(rows[0]?.ok).toBe(1);
    } finally {
      await closePool(pool);
    }
  });

  it('closes cleanly, and a query after close fails predictably', async () => {
    const pool = createPool({ databaseUrl: DATABASE_URL });
    await pool.query('SELECT 1');
    await closePool(pool);

    await expect(pool.query('SELECT 1')).rejects.toThrow();
  });
});
