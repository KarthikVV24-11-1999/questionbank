import { describe, expect, it } from 'vitest';
import { LATENCY_BUCKETS_SECONDS, MetricsRegistry } from './metrics.js';

describe('counters', () => {
  it('add up per label set, and render with their help and type', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('qb_things_total', 'Things.');
    counter.inc({ kind: 'a' });
    counter.inc({ kind: 'a' }, 2);
    counter.inc({ kind: 'b' });
    expect(await registry.render()).toContain('# HELP qb_things_total Things.\n# TYPE qb_things_total counter\nqb_things_total{kind="a"} 3\nqb_things_total{kind="b"} 1\n');
  });

  it('are one series however the labels are ordered, and may have none', async () => {
    const registry = new MetricsRegistry();
    const counter = registry.counter('qb_c_total', 'C.');
    counter.inc({ b: '2', a: '1' });
    counter.inc({ a: '1', b: '2' });
    counter.inc();
    const page = await registry.render();
    expect(page).toContain('qb_c_total{a="1",b="2"} 2\n');
    expect(page).toContain('qb_c_total 1\n');
  });

  it('only go up', () => {
    expect(() => new MetricsRegistry().counter('qb_c_total', 'C.').inc({}, -1)).toThrow('only goes up');
    expect(() => new MetricsRegistry().counter('qb_c_total', 'C.').inc({}, Number.NaN)).toThrow('only goes up');
  });
});

describe('histograms', () => {
  it('count each observation in every bucket at or above it, with a sum, a count and an infinite bucket', async () => {
    const registry = new MetricsRegistry();
    registry.histogram('qb_d_seconds', 'D.', [0.1, 1]).observe({ route: 'GET /x' }, 0.05);
    registry.histogram('qb_e_seconds', 'E.', [0.1, 1]).observe({}, 0.5);
    const page = await registry.render();
    expect(page).toContain('qb_d_seconds_bucket{le="0.1",route="GET /x"} 1\nqb_d_seconds_bucket{le="1",route="GET /x"} 1\nqb_d_seconds_bucket{le="+Inf",route="GET /x"} 1\nqb_d_seconds_sum{route="GET /x"} 0.05\nqb_d_seconds_count{route="GET /x"} 1\n');
    expect(page).toContain('qb_e_seconds_bucket{le="0.1"} 0\nqb_e_seconds_bucket{le="1"} 1\nqb_e_seconds_bucket{le="+Inf"} 1\n');
  });

  it('counts an observation exactly on a bound in that bucket: a bound is "at most"', async () => {
    const registry = new MetricsRegistry();
    registry.histogram('qb_d_seconds', 'D.', [0.1]).observe({}, 0.1);
    expect(await registry.render()).toContain('qb_d_seconds_bucket{le="0.1"} 1\n');
  });

  it('accumulate, and an observation above every bucket is only in the infinite one', async () => {
    const registry = new MetricsRegistry();
    const histogram = registry.histogram('qb_d_seconds', 'D.', [1]);
    histogram.observe({}, 0.5);
    histogram.observe({}, 7);
    const page = await registry.render();
    expect(page).toContain('qb_d_seconds_bucket{le="1"} 1\nqb_d_seconds_bucket{le="+Inf"} 2\nqb_d_seconds_sum 7.5\nqb_d_seconds_count 2\n');
  });

  it('has buckets that put the NFR latency targets on a boundary, so a quantile can be read at them', () => {
    for (const target of [0.2, 0.3, 0.5, 1.5, 2, 3]) expect(LATENCY_BUCKETS_SECONDS).toContain(target);
    expect([...LATENCY_BUCKETS_SECONDS]).toEqual([...LATENCY_BUCKETS_SECONDS].sort((a, b) => a - b));
  });
});

describe('gauges', () => {
  it('are read when the page is, so they show now and not the last write', async () => {
    const registry = new MetricsRegistry();
    let depth = 1;
    registry.gauge('qb_depth', 'Depth.', () => [{ value: depth }]);
    expect(await registry.render()).toContain('qb_depth 1\n');
    depth = 9;
    expect(await registry.render()).toContain('qb_depth 9\n');
  });

  it('may be read asynchronously and be many series', async () => {
    const registry = new MetricsRegistry();
    registry.gauge('qb_pool', 'Pool.', async () => [{ labels: { state: 'idle' }, value: 2 }, { labels: { state: 'waiting' }, value: 0 }]);
    expect(await registry.render()).toContain('qb_pool{state="idle"} 2\nqb_pool{state="waiting"} 0\n');
  });

  it('that cannot be read are named, and the page is still served', async () => {
    const registry = new MetricsRegistry();
    registry.gauge('qb_ok', 'Ok.', () => [{ value: 1 }]);
    registry.gauge('qb_down', 'Down.', () => Promise.reject(new Error('database is gone')));
    const page = await registry.render();
    expect(page).toContain('qb_ok 1\n');
    expect(page).not.toContain('qb_down ');
    expect(page).toContain('qb_collector_failed{collector="qb_down"} 1\n');
    expect(page).not.toContain('database is gone');
  });

  it('with nothing wrong, say nothing is failing', async () => {
    expect(await new MetricsRegistry().render()).toBe('# HELP qb_collector_failed A gauge that could not be read at this scrape.\n# TYPE qb_collector_failed gauge\n');
  });

  it('write infinities and quote what a label holds', async () => {
    const registry = new MetricsRegistry();
    registry.gauge('qb_odd', 'Odd.', () => [{ labels: { v: 'a"b\\c\nd' }, value: Number.POSITIVE_INFINITY }, { labels: { v: 'n' }, value: Number.NEGATIVE_INFINITY }, { labels: { v: 'x' }, value: Number.NaN }]);
    const page = await registry.render();
    expect(page).toContain('qb_odd{v="a\\"b\\\\c\\nd"} +Inf\n');
    expect(page).toContain('qb_odd{v="n"} -Inf\nqb_odd{v="x"} NaN\n');
  });
});

describe('names', () => {
  it('are lower-case words, and are not used twice', () => {
    const registry = new MetricsRegistry();
    registry.counter('qb_a_total', 'A.');
    expect(() => registry.gauge('qb_a_total', 'A.', () => [])).toThrow('two metrics are named qb_a_total');
    for (const bad of ['', 'Qb', '1a', 'a-b', 'a b']) expect(() => registry.counter(bad, 'x'), bad).toThrow('is not a metric name');
  });
});
