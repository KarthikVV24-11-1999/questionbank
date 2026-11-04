import type { Pool } from 'pg';
import type { DrainReport } from '../outbox/relay.js';
import type { LogEntry } from './logger.js';
import { MetricsRegistry } from './metrics.js';

/**
 * What the API measures about itself (M8-53, M8-51, M8-52). Each metric answers a question an operator or a load run asks:
 *
 *   - `qb_http_requests_total{route,status_class}` and `qb_http_request_duration_seconds{route}`: how much, how fast and how often wrong, per route *template* (`POST /v1/identity/login`,
 *     never a path with an identifier in it) and per status class (`2xx`, `4xx`, `5xx`).
 *   - `qb_outbox_depth`, `qb_outbox_oldest_unrelayed_age_seconds`, `qb_outbox_dead`: the backlog the relay has yet to deliver, how old its oldest message is, and what has been given up on. **Only
 *     messages of a type some consumer is registered for are the relay's backlog** (`consumes`): the relay claims no other, so counting them would make a queue of messages nobody will ever deliver
 *     look like a relay that is behind.
 *   - `qb_outbox_unconsumed`: the messages of a type nothing consumes. They accumulate for ever, one for each item published (D130), and are counted so that growth is seen.
 *   - `qb_outbox_relay_seconds_since_drain`: the relay's lag, as the time since it last finished a drain. A relay that has stopped shows here before its backlog does.
 *   - `qb_outbox_messages_total{outcome}`: what each drain did (delivered, retried, dead-lettered, refused).
 *   - `qb_db_pool_connections{state}`: the pool's `total`, `idle` and `waiting` clients. `waiting` above zero is a request waiting for a connection.
 *   - `qb_refusals_total{code,reason}`: requests the admission control refused, by the tier that refused them (`source_short`, `subject_long`...).
 *   - `qb_process_resident_memory_bytes`: the process's resident set, for the soak.
 */
export interface MetricsDeps {
  readonly pool: Pick<Pool, 'query' | 'totalCount' | 'idleCount' | 'waitingCount'>;
  readonly now: () => Date;
  readonly rss: () => number;
}

interface HttpRequestLike {
  readonly method: string;
  readonly path: string;
  readonly route?: { readonly path?: unknown };
}
interface HttpResponseLike {
  readonly statusCode: number;
  once(event: 'finish', listener: () => void): unknown;
}

/** The status class of a response, as a label: `2xx`. */
export const statusClass = (status: number): string => `${Math.floor(status / 100)}xx`;

/** The label for a route that was matched, and for one that was not: a request nobody routed must not become a series per path. */
export const routeLabel = (request: HttpRequestLike): string => (typeof request.route?.path === 'string' ? `${request.method} ${request.route.path}` : 'unmatched');

const REFUSAL_CODES = new Set(['RATE_LIMITED', 'RATE_LIMIT_UNAVAILABLE', 'WORK_SATURATED']);

export function createApiMetrics(deps: MetricsDeps) {
  const registry = new MetricsRegistry();
  const requests = registry.counter('qb_http_requests_total', 'Requests answered, by route template and status class.');
  const duration = registry.histogram('qb_http_request_duration_seconds', 'Time to answer a request, by route template.');
  const delivered = registry.counter('qb_outbox_messages_total', 'What each outbox drain did with the messages it claimed, by outcome.');
  const refusals = registry.counter('qb_refusals_total', 'Requests refused by admission control, by code and the tier that refused.');
  let lastDrainAt: Date | null = null;
  let consumed: readonly string[] = [];
  const startedAt = deps.now();

  registry.gauge('qb_outbox_depth', 'Messages published to the outbox and not yet delivered or dead-lettered.', async () => [{ value: (await backlog()).depth }]);
  registry.gauge('qb_outbox_oldest_unrelayed_age_seconds', 'Age of the oldest message the relay has not delivered; 0 when there is none.', async () => [{ value: (await backlog()).oldestAgeSeconds }]);
  registry.gauge('qb_outbox_unconsumed', 'Live messages of a type no consumer is registered for: never claimed, never delivered.', async () => [{ value: (await backlog()).unconsumed }]);
  registry.gauge('qb_outbox_dead', 'Messages the relay gave up on and kept for an operator.', async () => [{ value: (await backlog()).dead }]);
  registry.gauge('qb_outbox_relay_seconds_since_drain', 'Seconds since the relay last finished a drain, or since the process started if it has not.', () => [{ value: (deps.now().getTime() - (lastDrainAt ?? startedAt).getTime()) / 1000 }]);
  registry.gauge('qb_db_pool_connections', 'Database pool clients by state.', () => [
    { labels: { state: 'total' }, value: deps.pool.totalCount },
    { labels: { state: 'idle' }, value: deps.pool.idleCount },
    { labels: { state: 'waiting' }, value: deps.pool.waitingCount },
  ]);
  registry.gauge('qb_process_resident_memory_bytes', 'Resident set size of the API process.', () => [{ value: deps.rss() }]);

  async function backlog(): Promise<{ depth: number; oldestAgeSeconds: number; dead: number; unconsumed: number }> {
    const { rows } = await deps.pool.query<{ depth: string; oldest_age: string | null; dead: string; unconsumed: string }>(
      `SELECT count(*) FILTER (WHERE published_at IS NULL AND dead_at IS NULL AND event_type = ANY($2)) AS depth,
              extract(epoch FROM ($1::timestamptz - min(occurred_at) FILTER (WHERE published_at IS NULL AND dead_at IS NULL AND event_type = ANY($2)))) AS oldest_age,
              count(*) FILTER (WHERE dead_at IS NOT NULL) AS dead,
              count(*) FILTER (WHERE published_at IS NULL AND dead_at IS NULL AND NOT (event_type = ANY($2))) AS unconsumed
         FROM platform.outbox_message`,
      [deps.now(), [...consumed]],
    );
    const row = rows[0] as { depth: string; oldest_age: string | null; dead: string; unconsumed: string };
    return { depth: Number(row.depth), oldestAgeSeconds: Math.max(0, Number(row.oldest_age ?? 0)), dead: Number(row.dead), unconsumed: Number(row.unconsumed) };
  }

  return {
    registry,
    /** The event types the relay has a consumer for: the root says so when it has built them. */
    consumes(types: Iterable<string>): void {
      consumed = [...types];
    },
    /** Express middleware: times a request and counts it when the response is finished, labelled by the route that served it. `/metrics` is not counted, so a scrape does not move what it reads. */
    http() {
      return (request: HttpRequestLike, response: HttpResponseLike, next: () => void): void => {
        if (request.path === '/metrics') return next();
        const began = process.hrtime.bigint();
        response.once('finish', () => {
          const route = routeLabel(request);
          requests.inc({ route, status_class: statusClass(response.statusCode) });
          duration.observe({ route }, Number(process.hrtime.bigint() - began) / 1e9);
        });
        next();
      };
    },
    /** To be called after each drain with what it did. */
    drained(report: DrainReport, at: Date): void {
      lastDrainAt = at;
      for (const outcome of ['delivered', 'retried', 'deadLettered', 'refused'] as const) if (report[outcome] > 0) delivered.inc({ outcome }, report[outcome]);
    },
    /** A refusal log that also counts: wraps the log admission control writes to, and counts the entries that are refusals. */
    countingRefusals<L extends { log(entry: LogEntry): void }>(inner: L): L {
      // the inner object stays the prototype, so whatever else the logger offers is still offered
      return Object.assign(Object.create(inner) as L, {
        log: (entry: LogEntry) => {
          const code = entry.attributes?.['errorCode'];
          if (typeof code === 'string' && REFUSAL_CODES.has(code)) refusals.inc({ code, reason: String(entry.attributes?.['reason'] ?? '') });
          inner.log(entry);
        },
      });
    },
  };
}
