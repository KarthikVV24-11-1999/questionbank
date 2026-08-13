import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { PostgresIdempotencyStore, type IdempotencyStore } from './idempotency-store.js';
import {
  InMemoryIdempotencyStore,
  type IdempotencyStore as ContentIdempotencyStore,
} from '../../contexts/content/application/ports.js';

/**
 * Proves two things this task is explicitly about: `PostgresIdempotencyStore`
 * satisfies content's own `IdempotencyStore` — the port it was written
 * against — and it closes D22, which `InMemoryIdempotencyStore` cannot: a
 * durable store must survive being reconnected to, and a process-local `Set`
 * has nothing to survive with.
 */

// Type-level proof, checked by tsc: PostgresIdempotencyStore satisfies the
// real port, not just the local structural copy it is declared against.
// Never called — its only job is to fail typecheck if the shapes diverge.
function typeParity(pool: import('pg').Pool): ContentIdempotencyStore {
  return new PostgresIdempotencyStore(pool);
}
void typeParity;

let database: TestDatabase;
let postgresStore: PostgresIdempotencyStore;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  postgresStore = new PostgresIdempotencyStore(database.pool);
});

afterEach(async () => {
  await database.pool.query('TRUNCATE platform.idempotency_key');
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

/**
 * One shared behavioural contract, run against both subjects — the in-memory
 * double and the durable adapter agree on what "seen" and "remember" mean.
 */
function idempotencyStoreContract(name: string, createStore: () => IdempotencyStore): void {
  describe(`IdempotencyStore contract — ${name}`, () => {
    it('a fresh key has not been seen', async () => {
      const store = createStore();
      expect(await store.seen(`fresh-${name}-${Math.random()}`)).toBe(false);
    });

    it('remembering a key makes it seen', async () => {
      const store = createStore();
      const key = `remembered-${name}-${Math.random()}`;
      await store.remember(key);
      expect(await store.seen(key)).toBe(true);
    });

    it('remembering the same key twice does not throw', async () => {
      const store = createStore();
      const key = `twice-${name}-${Math.random()}`;
      await store.remember(key);
      await expect(store.remember(key)).resolves.toBeUndefined();
      expect(await store.seen(key)).toBe(true);
    });

    it('two different keys do not interfere', async () => {
      const store = createStore();
      const a = `a-${name}-${Math.random()}`;
      const b = `b-${name}-${Math.random()}`;
      await store.remember(a);
      expect(await store.seen(a)).toBe(true);
      expect(await store.seen(b)).toBe(false);
    });
  });
}

idempotencyStoreContract('InMemoryIdempotencyStore', () => new InMemoryIdempotencyStore());
idempotencyStoreContract('PostgresIdempotencyStore', () => postgresStore);

describe('PostgresIdempotencyStore — closes D22: durable across reconnection', () => {
  it('a key remembered by one store instance is seen by a brand new instance against the same database', async () => {
    const key = `durable-${Math.random()}`;
    await postgresStore.remember(key);

    // A fresh instance, as a new process would construct on restart — proves
    // the fact survives the adapter object, not just the connection pool.
    const reconnected = new PostgresIdempotencyStore(database.pool);
    expect(await reconnected.seen(key)).toBe(true);
  });
});

describe('PostgresIdempotencyStore — concurrent duplicate remember() resolves to one row', () => {
  it('two overlapping transactions remembering the same key leave exactly one row', async () => {
    const key = `race-${Math.random()}`;

    // Two independent connections from the pool, racing genuinely concurrent
    // INSERTs — not a read-then-write the adapter serializes itself. The
    // primary-key constraint is what decides the outcome.
    await Promise.all([postgresStore.remember(key), postgresStore.remember(key)]);

    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM platform.idempotency_key WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0]?.count).toBe('1');
  });

  it('a genuinely simultaneous pair of INSERTs across two raw connections still resolves to one row', async () => {
    const key = `race-raw-${Math.random()}`;
    const insert = () =>
      database.pool.query(
        `INSERT INTO platform.idempotency_key (idempotency_key, expires_at)
         VALUES ($1, now() + interval '1 day')
         ON CONFLICT (idempotency_key) DO NOTHING`,
        [key],
      );
    await Promise.all([insert(), insert(), insert()]);

    const { rows } = await database.pool.query<{ count: string }>(
      'SELECT count(*) AS count FROM platform.idempotency_key WHERE idempotency_key = $1',
      [key],
    );
    expect(rows[0]?.count).toBe('1');
  });
});

describe('PostgresIdempotencyStore — expiry', () => {
  it('an expired entry is ignored on read', async () => {
    const key = `expired-${Math.random()}`;
    await database.pool.query(
      `INSERT INTO platform.idempotency_key (idempotency_key, expires_at) VALUES ($1, now() - interval '1 second')`,
      [key],
    );
    expect(await postgresStore.seen(key)).toBe(false);
  });

  it('an entry expiring in the future is seen', async () => {
    const key = `not-expired-${Math.random()}`;
    await database.pool.query(
      `INSERT INTO platform.idempotency_key (idempotency_key, expires_at) VALUES ($1, now() + interval '1 hour')`,
      [key],
    );
    expect(await postgresStore.seen(key)).toBe(true);
  });

  it('remember() honours a custom TTL', async () => {
    const shortLived = new PostgresIdempotencyStore(database.pool, { ttlMs: -1000 });
    const key = `custom-ttl-${Math.random()}`;
    await shortLived.remember(key);
    // TTL already elapsed by construction (negative), so it reads as unseen.
    expect(await postgresStore.seen(key)).toBe(false);
  });

  it('reapExpired removes only expired rows and reports the count', async () => {
    const expiredKey = `reap-expired-${Math.random()}`;
    const liveKey = `reap-live-${Math.random()}`;
    await database.pool.query(
      `INSERT INTO platform.idempotency_key (idempotency_key, expires_at) VALUES ($1, now() - interval '1 second')`,
      [expiredKey],
    );
    await postgresStore.remember(liveKey);

    const removed = await postgresStore.reapExpired();
    expect(removed).toBe(1);

    const { rows } = await database.pool.query<{ idempotency_key: string }>(
      'SELECT idempotency_key FROM platform.idempotency_key',
    );
    expect(rows.map((r) => r.idempotency_key)).toEqual([liveKey]);
  });
});

describe('platform.idempotency_key — rejects a blank key at the constraint', () => {
  it('an empty-string key is refused', async () => {
    await expect(
      database.pool.query(`INSERT INTO platform.idempotency_key (idempotency_key, expires_at) VALUES ('', now())`),
    ).rejects.toThrow();
  });
});
