import type { Pool } from 'pg';

/**
 * Content's `IdempotencyStore` port (`contexts/content/application/ports.ts`),
 * implemented **unchanged** — a port that had to move to get a durable
 * adapter was the wrong port. `InMemoryIdempotencyStore` stays exactly where
 * it is, still a double; this is what it stood in for (D22).
 *
 * Declared locally rather than imported from `contexts/content/application/`
 * — `platform/` does not reach into a context's application layer, on the
 * same argument `audit-recorder.ts` makes for its own structural type. The
 * two interfaces are, and must stay, identical: a spec asserts it.
 */
export interface IdempotencyStore {
  /** True when this key has already been applied, in which case nothing is written. */
  seen(key: string): Promise<boolean>;
  remember(key: string): Promise<void>;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

export interface PostgresIdempotencyStoreOptions {
  readonly ttlMs?: number;
}

export class PostgresIdempotencyStore implements IdempotencyStore {
  readonly #pool: Pool;
  readonly #ttlMs: number;

  constructor(pool: Pool, options: PostgresIdempotencyStoreOptions = {}) {
    this.#pool = pool;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Expired entries are ignored — a key past its TTL is treated as never seen. */
  async seen(key: string): Promise<boolean> {
    const { rows } = await this.#pool.query(
      `SELECT 1 FROM platform.idempotency_key WHERE idempotency_key = $1 AND expires_at > now()`,
      [key],
    );
    return rows.length > 0;
  }

  /**
   * `ON CONFLICT DO NOTHING`: the primary-key constraint is what resolves
   * two concurrent callers remembering the same key to one row, not a
   * SELECT-then-INSERT this method deliberately does not perform.
   */
  async remember(key: string): Promise<void> {
    const expiresAt = new Date(Date.now() + this.#ttlMs);
    await this.#pool.query(
      `INSERT INTO platform.idempotency_key (idempotency_key, expires_at)
       VALUES ($1, $2)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [key, expiresAt],
    );
  }

  /**
   * Not part of `IdempotencyStore` — a maintenance operation, on a schedule
   * the composition root does not need to own yet (M0-08's acceptance is
   * explicit that this is out of scope this task). Returns the row count
   * removed, so a future scheduler can log something more useful than "ran".
   */
  async reapExpired(): Promise<number> {
    const result = await this.#pool.query('DELETE FROM platform.idempotency_key WHERE expires_at <= now()');
    return result.rowCount ?? 0;
  }
}
