import { describe, expect, it } from 'vitest';
import { createApiMetrics, routeLabel, statusClass } from './api-metrics.js';

const AT = new Date('2026-11-05T10:00:00.000Z');
function rig(over: { rows?: Array<{ depth: string; oldest_age: string | null; dead: string; unconsumed: string }>; now?: () => Date; failQuery?: boolean } = {}) {
  const queries: unknown[][] = [];
  const pool = {
    totalCount: 7,
    idleCount: 3,
    waitingCount: 2,
    query: async (...args: unknown[]) => {
      queries.push(args);
      if (over.failQuery === true) throw new Error('down');
      return { rows: over.rows ?? [{ depth: '4', oldest_age: '12.5', dead: '1', unconsumed: '36' }] };
    },
  };
  const metrics = createApiMetrics({ pool: pool as never, now: over.now ?? (() => AT), rss: () => 123_456_789 });
  return { metrics, queries };
}
function serve(metrics: ReturnType<typeof createApiMetrics>, request: { method: string; path: string; route?: { path?: unknown } }, status: number) {
  let finish = (): void => undefined;
  let nexted = false;
  metrics.http()(request, { statusCode: status, once: (_event: 'finish', listener: () => void) => void (finish = listener) }, () => void (nexted = true));
  return { nexted, finish: () => finish() };
}

describe('the request metrics', () => {
  it('count a request by the route template and the class of its status, and time it', async () => {
    const { metrics } = rig();
    const route = { path: '/v1/learning/concept-map/:conceptIdentityId/evidence' };
    serve(metrics, { method: 'GET', path: '/v1/learning/concept-map/3f2a9c10-1b2c-4d3e-8f4a-5b6c7d8e9f00/evidence', route }, 200).finish();
    serve(metrics, { method: 'GET', path: '/v1/learning/concept-map/other/evidence', route }, 503).finish();
    const page = await metrics.registry.render();
    expect(page).toContain('qb_http_requests_total{route="GET /v1/learning/concept-map/:conceptIdentityId/evidence",status_class="2xx"} 1');
    expect(page).toContain('qb_http_requests_total{route="GET /v1/learning/concept-map/:conceptIdentityId/evidence",status_class="5xx"} 1');
    expect(page).toContain('qb_http_request_duration_seconds_count{route="GET /v1/learning/concept-map/:conceptIdentityId/evidence"} 2');
    expect(page).not.toContain('3f2a9c10');
    expect(page).not.toContain('/other/');
  });

  it('count only when the response is finished, and let the request go on', async () => {
    const { metrics } = rig();
    const call = serve(metrics, { method: 'POST', path: '/v1/x', route: { path: '/v1/x' } }, 201);
    expect(call.nexted).toBe(true);
    expect(await metrics.registry.render()).not.toContain('qb_http_requests_total{');
    call.finish();
    expect(await metrics.registry.render()).toContain('qb_http_requests_total{route="POST /v1/x",status_class="2xx"} 1');
  });

  it('give a request no route matched one label, whatever its path, so a scan of paths is one series', async () => {
    const { metrics } = rig();
    serve(metrics, { method: 'GET', path: '/wp-admin/a' }, 404).finish();
    serve(metrics, { method: 'GET', path: '/wp-admin/b', route: {} }, 404).finish();
    serve(metrics, { method: 'GET', path: '/c', route: { path: 3 } }, 404).finish();
    const page = await metrics.registry.render();
    expect(page).toContain('qb_http_requests_total{route="unmatched",status_class="4xx"} 3');
    expect(page).not.toContain('wp-admin');
  });

  it('do not count the page that reads them', async () => {
    const { metrics } = rig();
    const call = serve(metrics, { method: 'GET', path: '/metrics', route: { path: '/metrics' } }, 200);
    expect(call.nexted).toBe(true);
    call.finish();
    expect(await metrics.registry.render()).not.toContain('qb_http_requests_total{');
  });

  it('read the status class of every status', () => {
    expect([200, 204, 301, 404, 429, 503].map(statusClass)).toEqual(['2xx', '2xx', '3xx', '4xx', '4xx', '5xx']);
    expect(routeLabel({ method: 'GET', path: '/p', route: { path: '/t' } })).toBe('GET /t');
  });
});

describe('the outbox metrics', () => {
  it('read the backlog now: how many are waiting, how old the oldest is, and how many were given up on', async () => {
    const { metrics, queries } = rig();
    metrics.consumes(['AttemptScored', 'AttemptSubmitted']);
    const page = await metrics.registry.render();
    expect(page).toContain('qb_outbox_depth 4\n');
    expect(page).toContain('qb_outbox_unconsumed 36\n');
    expect(page).toContain('qb_outbox_oldest_unrelayed_age_seconds 12.5\n');
    expect(page).toContain('qb_outbox_dead 1\n');
    expect(queries[0]![1]).toEqual([AT, ['AttemptScored', 'AttemptSubmitted']]);
    expect(String(queries[0]![0])).toMatch(/published_at IS NULL AND dead_at IS NULL/u);
  });

  it('say 0 for the age of nothing, and never a negative age', async () => {
    const empty = await rig({ rows: [{ depth: '0', oldest_age: null, dead: '0', unconsumed: '0' }] }).metrics.registry.render();
    expect(empty).toContain('qb_outbox_oldest_unrelayed_age_seconds 0\n');
    const skewed = await rig({ rows: [{ depth: '1', oldest_age: '-3', dead: '0', unconsumed: '0' }] }).metrics.registry.render();
    expect(skewed).toContain('qb_outbox_oldest_unrelayed_age_seconds 0\n');
  });

  it('are named as failing, and the rest of the page served, when the database cannot be read', async () => {
    const page = await rig({ failQuery: true }).metrics.registry.render();
    expect(page).toContain('qb_collector_failed{collector="qb_outbox_depth"} 1');
    expect(page).toContain('qb_collector_failed{collector="qb_outbox_dead"} 1');
    expect(page).toContain('qb_process_resident_memory_bytes 123456789');
  });

  it('measure the relay\'s lag from its last drain, or from the start if it has not drained', async () => {
    let now = AT;
    const { metrics } = rig({ now: () => now });
    now = new Date(AT.getTime() + 5_000);
    expect(await metrics.registry.render()).toContain('qb_outbox_relay_seconds_since_drain 5\n');
    metrics.drained({ claimed: 0, delivered: 0, retried: 0, deadLettered: 0, refused: 0 }, new Date(AT.getTime() + 4_000));
    expect(await metrics.registry.render()).toContain('qb_outbox_relay_seconds_since_drain 1\n');
  });

  it('count what each drain did, by outcome, and nothing for an outcome that did not happen', async () => {
    const { metrics } = rig();
    metrics.drained({ claimed: 6, delivered: 3, retried: 2, deadLettered: 0, refused: 1 }, AT);
    metrics.drained({ claimed: 2, delivered: 2, retried: 0, deadLettered: 0, refused: 0 }, AT);
    const page = await metrics.registry.render();
    expect(page).toContain('qb_outbox_messages_total{outcome="delivered"} 5');
    expect(page).toContain('qb_outbox_messages_total{outcome="retried"} 2');
    expect(page).toContain('qb_outbox_messages_total{outcome="refused"} 1');
    expect(page).not.toContain('outcome="deadLettered"');
  });
});

describe('the process metrics', () => {
  it('report the pool by state, and the resident memory', async () => {
    const page = await rig().metrics.registry.render();
    expect(page).toContain('qb_db_pool_connections{state="total"} 7\nqb_db_pool_connections{state="idle"} 3\nqb_db_pool_connections{state="waiting"} 2\n');
    expect(page).toContain('qb_process_resident_memory_bytes 123456789\n');
  });
});

describe('the refusal metrics', () => {
  function wrapped() {
    const { metrics } = rig();
    const written: unknown[] = [];
    const inner = { log: (entry: unknown) => void written.push(entry), other: () => 'still here' };
    return { metrics, written, log: metrics.countingRefusals(inner as never) as unknown as typeof inner & { log: (entry: object) => void } };
  }
  const entry = (errorCode: string, reason: string) => ({ level: 'warn', message: 'm', correlationId: 'c', context: 'identity.admission', attributes: { errorCode, reason, route: 'login' } });

  it('count the refusals admission control makes, by the tier that made them, and pass every entry on', async () => {
    const { metrics, written, log } = wrapped();
    log.log(entry('RATE_LIMITED', 'subject_short'));
    log.log(entry('RATE_LIMITED', 'subject_short'));
    log.log(entry('RATE_LIMITED', 'source_long'));
    log.log(entry('WORK_SATURATED', 'queue_full'));
    log.log(entry('RATE_LIMIT_UNAVAILABLE', 'store'));
    expect(written).toHaveLength(5);
    const page = await metrics.registry.render();
    expect(page).toContain('qb_refusals_total{code="RATE_LIMITED",reason="subject_short"} 2');
    expect(page).toContain('qb_refusals_total{code="RATE_LIMITED",reason="source_long"} 1');
    expect(page).toContain('qb_refusals_total{code="WORK_SATURATED",reason="queue_full"} 1');
    expect(page).toContain('qb_refusals_total{code="RATE_LIMIT_UNAVAILABLE",reason="store"} 1');
  });

  it('do not count a log entry that is not a refusal, with or without attributes, and keep what else the logger offers', async () => {
    const { metrics, written, log } = wrapped();
    log.log(entry('BREACH_CHECK_UNAVAILABLE', 'x'));
    log.log({ level: 'warn', message: 'm', correlationId: 'c', context: 'x' });
    log.log(entry('RATE_LIMITED', undefined as never));
    expect(written).toHaveLength(3);
    const page = await metrics.registry.render();
    expect(page).not.toContain('BREACH_CHECK');
    expect(page).toContain('qb_refusals_total{code="RATE_LIMITED",reason=""} 1');
    expect((log as unknown as { other: () => string }).other()).toBe('still here');
  });
});
