import { describe, expect, it } from 'vitest';
import type { Pool, QueryResult } from 'pg';
import { PostgresIdempotencyStore } from './idempotency-store.js';

/**
 * The one branch the integration spec cannot reach without real Postgres
 * lying to it: `@types/pg` types `rowCount` as `number | null`, and a real
 * DELETE never actually returns `null` for this driver — but the type says
 * it can, so the fallback earns a test rather than an unreachable-branch
 * deletion (§9's "an unreachable branch is deleted, not tested" does not
 * apply here, because the type system disagrees that it is unreachable).
 */
function fakePool(queryResult: Partial<QueryResult>): Pool {
  return { query: async () => queryResult } as unknown as Pool;
}

describe('PostgresIdempotencyStore.reapExpired — rowCount fallback', () => {
  it('returns the reported row count', async () => {
    const store = new PostgresIdempotencyStore(fakePool({ rowCount: 3 }));
    expect(await store.reapExpired()).toBe(3);
  });

  it('falls back to zero when the driver reports no row count', async () => {
    const store = new PostgresIdempotencyStore(fakePool({ rowCount: null }));
    expect(await store.reapExpired()).toBe(0);
  });
});
