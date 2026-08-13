import type { Pool } from 'pg';
import type { Telemetry } from './telemetry.js';

/**
 * Wraps `pool.query` so every call against it becomes a child span named
 * `db.query` under whatever span is active when it runs. `telemetry.ts`'s
 * `AsyncLocalStorage` parent linkage does the nesting; this file only wraps
 * the one entry point every repository across every context already calls
 * (M0-07 through M0-11), so no repository changes to get a database-call
 * span in the tree.
 *
 * The query text and its parameters are never attached as span
 * attributes — an answer key or a learner's response could be a bound
 * parameter, and the allowlist serializer's PII rule (§9 rule 12) is easiest
 * to keep true by never handing it anything to filter.
 *
 * Mutates the pool in place rather than returning a wrapper object: repository
 * constructors across the codebase type their parameter as `Pool` from `pg`
 * and are unaffected by this file existing, since the static type is
 * unchanged — only the one instance `createApplication` builds carries the
 * instrumented `query`.
 */
export function instrumentPool(pool: Pool, telemetry: Telemetry): Pool {
  const originalQuery = pool.query.bind(pool);
  const instrumented = (...args: unknown[]): unknown =>
    telemetry.withSpan('db.query', { correlationId: 'db.query' }, () =>
      (originalQuery as (...queryArgs: unknown[]) => unknown)(...args),
    );
  Object.assign(pool, { query: instrumented });
  return pool;
}
