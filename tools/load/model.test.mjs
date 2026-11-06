import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { readMetrics } from './load.mjs';
import { BETA, BLOCKED, BUDGETS, MIN_SAMPLES, SOAK, seeableLeakBytes, TARGETS, derive, judge, median, operationsIn, percentile, relayGap, soakVerdict, stampedeVerdict, summarise } from './model.mjs';

const ok = (ms) => ({ status: 200, ms });
const stream = (name, ms, count = 120) => [name, summarise(Array.from({ length: count }, () => ok(ms)))];
const clean = () => Object.fromEntries(Object.keys(TARGETS).map((name) => stream(name, 10)));

describe('the derivation of the load', () => {
  it('works the beta out from the NFR\'s shares, and multiplies it by three', () => {
    const d = derive();
    assert.deepEqual(
      Object.fromEntries(Object.entries(d).map(([name, v]) => [name, [v.operations, v.windowSeconds, v.loadedOperations]])),
      { signIn: [200, 300, 600], package: [160, 900, 480], submit: [120, 300, 360], result: [200, 1800, 600] },
    );
    assert.equal(d.package.perSecond.toFixed(3), '0.178');
    assert.equal(d.submit.perSecond.toFixed(3), '0.400');
    assert.equal(d.result.perSecond.toFixed(3), '0.111');
    assert.equal(d.signIn.perSecond.toFixed(3), '0.667');
    assert.equal(d.signIn.loadedPerSecond, 2);
    assert.equal(d.submit.loadedPerSecond, 1.2);
  });

  it('is the NFR\'s three bursts and the day one login, 200 students at a factor of 3', () => {
    assert.equal(BETA.students, 200);
    assert.equal(BETA.factor, 3);
    assert.deepEqual(Object.keys(BETA.streams), ['signIn', 'package', 'submit', 'result']);
    assert.deepEqual([BETA.streams.package.share, BETA.streams.submit.share, BETA.streams.result.share], [0.8, 0.6, 1.0]);
    assert.deepEqual([BETA.streams.package.windowSeconds, BETA.streams.submit.windowSeconds, BETA.streams.result.windowSeconds], [900, 300, 1800]);
  });

  it('plays the loaded rate for the length of the run, rounded up, and follows the factor', () => {
    const d = derive();
    assert.equal(operationsIn(d.signIn, 90), 180);
    assert.equal(operationsIn(d.package, 90), 48);
    assert.equal(operationsIn(d.submit, 45), 54);
    assert.equal(operationsIn(d.package, 10), 6, '5.33 operations is six, since a partial one is still started');
    const doubled = derive({ ...BETA, factor: 6 });
    assert.equal(operationsIn(doubled.signIn, 90), 360);
  });
});

describe('percentiles and summaries', () => {
  it('are nearest-rank, and nothing for nothing', () => {
    const values = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.deepEqual([percentile(values, 50), percentile(values, 95), percentile(values, 99), percentile(values, 100)], [50, 95, 99, 100]);
    assert.equal(percentile([5], 95), 5);
    assert.ok(Number.isNaN(percentile([], 95)));
    assert.equal(median([3, 1, 2]), 2);
    assert.deepEqual(percentile([30, 10, 20], 100), 30);
  });

  it('count the operations answered 2xx in the times, and everything else by its status', () => {
    const s = summarise([ok(10), ok(30), { status: 503, ms: 9 }, { status: 429, ms: 1 }, { status: 503, ms: 2 }, { status: 0, ms: 1 }]);
    assert.deepEqual([s.count, s.ok, s.failures, s.max], [6, 2, { 503: 2, 429: 1, 0: 1 }, 30]);
    assert.equal(s.p95, 30);
    const redirected = summarise([ok(10), { status: 301, ms: 3 }, { status: 199, ms: 3 }, { status: 300, ms: 3 }]);
    assert.deepEqual([redirected.ok, redirected.failures], [1, { 301: 1, 199: 1, 300: 1 }]);
    const none = summarise([]);
    assert.ok(Number.isNaN(none.p95) && Number.isNaN(none.max));
  });
});

describe('the verdict: the runner\'s budget gates, the NFR table is reported (M8-56)', () => {
  it('passes a clean run, and holds each stream to its own target and its own budget', () => {
    assert.equal(judge(clean()).failed, false);
    assert.deepEqual(Object.fromEntries(Object.entries(TARGETS).map(([name, t]) => [name, [t.id, t.ms]])), {
      signIn: ['PER-09', 300], package: ['PER-08', 200], events: ['PER-09', 300], submission: ['PER-09', 300], conceptMap: ['PER-16', 500], profile: ['PER-08', 200], resultAvailable: ['PER-13', 60000],
    });
    assert.deepEqual(Object.fromEntries(Object.entries(BUDGETS).map(([name, b]) => [name, b.ms])), { signIn: 450, package: 150, events: 250, submission: 100, conceptMap: 200, profile: 150, resultAvailable: 10000 });
    assert.deepEqual(Object.keys(BUDGETS), Object.keys(TARGETS));
  });

  it('fails on a p95 over the budget, and not on one exactly at it', () => {
    assert.equal(judge({ ...clean(), package: summarise(Array.from({ length: 120 }, () => ok(151))) }).failed, true);
    assert.equal(judge({ ...clean(), package: summarise(Array.from({ length: 120 }, () => ok(150))) }).failed, false);
    const breach = judge({ ...clean(), conceptMap: summarise(Array.from({ length: 120 }, () => ok(201))) });
    assert.match(breach.rows.find((row) => row.name === 'conceptMap').breaches[0], /p95 201 ms is over the runner's budget of 200 ms/u);
  });

  it('does not fail on the NFR table: a figure over the target and inside the budget is reported as over and passes', () => {
    const verdict = judge({ ...clean(), signIn: summarise(Array.from({ length: 120 }, () => ok(350))) });
    assert.equal(verdict.failed, false);
    const row = verdict.rows.find((r) => r.name === 'signIn');
    assert.deepEqual([row.nfr, row.breaches], ['over', []]);
    assert.equal(judge(clean()).rows.find((r) => r.name === 'signIn').nfr, 'within');
    assert.equal(judge({ ...clean(), signIn: summarise(Array.from({ length: 120 }, () => ok(300))) }).rows.find((r) => r.name === 'signIn').nfr, 'within');
  });

  it('gates a percentile only with at least the minimum successes: below it the figure is reported, said to be under, and the run does not fail on it', () => {
    assert.equal(MIN_SAMPLES, 100);
    const few = judge({ ...clean(), package: summarise(Array.from({ length: MIN_SAMPLES - 1 }, () => ok(9999))) });
    assert.equal(few.failed, false);
    assert.equal(few.rows.find((r) => r.name === 'package').under, true);
    const enough = judge({ ...clean(), package: summarise(Array.from({ length: MIN_SAMPLES }, () => ok(9999))) });
    assert.equal(enough.failed, true);
    assert.equal(enough.rows.find((r) => r.name === 'package').under, false);
  });

  it('counts only the successes toward the minimum', () => {
    const mixed = summarise([...Array.from({ length: 99 }, () => ok(9999)), ...Array.from({ length: 50 }, () => ({ status: 503, ms: 1 }))]);
    const row = judge({ ...clean(), package: mixed }).rows.find((r) => r.name === 'package');
    assert.equal(row.under, true);
    assert.match(row.breaches.join(' '), /50 of 149 failed/u);
  });

  it('judges the 95th percentile, so a slow tail past it is not a breach and a slow 6th percent is', () => {
    const times = (slow) => summarise([...Array.from({ length: 100 - slow }, () => ok(10)), ...Array.from({ length: slow }, () => ok(900))]);
    assert.equal(judge({ ...clean(), signIn: times(5) }).failed, false);
    assert.equal(judge({ ...clean(), signIn: times(6) }).failed, true);
    assert.equal(judge({ ...clean(), signIn: times(6) }).rows.find((r) => r.name === 'signIn').under, false);
  });

  it('fails on any operation that failed, however fast the rest were and however few', () => {
    const few = summarise([...Array.from({ length: 9 }, () => ok(10)), { status: 503, ms: 5 }]);
    assert.equal(judge({ ...clean(), events: few }).failed, true);
    const mixed = summarise([...Array.from({ length: 99 }, () => ok(10)), { status: 503, ms: 5 }]);
    const verdict = judge({ ...clean(), events: mixed });
    assert.equal(verdict.failed, true);
    assert.match(verdict.rows.find((row) => row.name === 'events').breaches.join(' '), /1 of 100 failed \(1 x 503\)/u);
  });

  it('fails on a stream that measured nothing, or in which nothing succeeded: a gate that could not look has not passed', () => {
    const { profile: _gone, ...rest } = clean();
    assert.equal(judge(rest).failed, true);
    assert.equal(judge(rest).rows.find((row) => row.name === 'profile').nfr, 'unmeasured', 'no figure is compared with the table when there is none');
    assert.equal(judge({ ...clean(), profile: summarise([]) }).failed, true);
    assert.equal(judge({ ...clean(), profile: summarise([{ status: 200, ms: 10_000 }, { status: 500, ms: 1 }]) }).failed, true, 'a failed operation in a small stream still fails it');
    assert.match(judge({ ...clean(), profile: summarise([{ status: 500, ms: 1 }]) }).rows.find((row) => row.name === 'profile').breaches.join(' '), /nothing succeeded/u);
  });

  it('lets a breach that is registered through, says so, and says when a registered one has healed', () => {
    const slow = { ...clean(), package: summarise(Array.from({ length: 120 }, () => ok(900))) };
    const known = judge(slow, { package: 'D999' });
    assert.equal(known.failed, false);
    assert.equal(known.rows.find((row) => row.name === 'package').registered, 'D999');
    assert.equal(judge(slow, { signIn: 'D999' }).failed, true);
    const healed = judge(clean(), { package: 'D999' });
    assert.equal(healed.failed, false);
    assert.equal(healed.rows.find((row) => row.name === 'package').healed, true);
  });

  it('names what cannot be measured here, and the NFR rows that are not passed for it', () => {
    assert.deepEqual(BLOCKED.map((b) => b.id), ['PER-10', 'PER-11', 'PER-12', 'SCA-02', 'SCA-03', 'SCA-04']);
    for (const b of BLOCKED) assert.ok(b.needs.length >= 8, b.id);
  });
});

describe('the soak', () => {
  const series = (over = {}) =>
    Array.from({ length: 40 }, (_, i) => ({ t: i * 2, rss: 100 * 1_048_576, pool: 8, depth: 2, oldest: 1, lag: 0.5, ...(typeof over === 'function' ? over(i) : over) }));
  const verdict = (samples, depth = 0) => soakVerdict(samples, { depth });
  const failing = (v) => v.checks.filter((c) => !c.ok).map((c) => c.what);

  it('passes a run in which nothing drifts', () => {
    assert.deepEqual(failing(verdict(series())), []);
    assert.equal(verdict(series()).checks.length, 5);
  });

  it('fails resident memory that keeps rising, and not memory that settled after the first quarter', () => {
    assert.deepEqual(failing(verdict(series((i) => ({ rss: (100 + i * 3) * 1_048_576 })))), ['resident memory settles']);
    assert.deepEqual(failing(verdict(series((i) => ({ rss: (i < 10 ? 60 + i * 4 : 100) * 1_048_576 })))), []);
    assert.deepEqual(failing(verdict(series((i) => ({ rss: (i < 20 ? 100 : 129) * 1_048_576 })))), []);
    assert.deepEqual(failing(verdict(series((i) => ({ rss: (i < 20 ? 100 : 131) * 1_048_576 })))), ['resident memory settles']);
  });

  it('fails a pool over its cap, and a pool that creeps up between the second quarter and the last', () => {
    assert.deepEqual(failing(verdict(series((i) => ({ pool: i === 20 ? 11 : 8 })))), ['the pool stays inside its cap']);
    assert.deepEqual(failing(verdict(series((i) => ({ pool: i > 30 ? 9 : 8 })))), ['the pool does not creep']);
    assert.deepEqual(failing(verdict(series({ pool: 10 }))), []);
  });

  it('fails a message that waits longer than ten seconds for the relay, at any sample', () => {
    assert.deepEqual(failing(verdict(series((i) => ({ oldest: i === 7 ? 10.5 : 1 })))), ['no message waits long for the relay']);
    assert.deepEqual(failing(verdict(series((i) => ({ oldest: i === 7 ? 10 : 1 })))), []);
  });

  it('does not fail a long gap between drains with nothing old waiting: a drain that is busy delivering (runs 42098744164 and 42103811295, 7.8 s, and 14.9 s on the first)', () => {
    assert.deepEqual(failing(verdict(series((i) => ({ lag: 15, oldest: 1.8 })))), []);
    assert.deepEqual(failing(verdict(series((i) => ({ lag: i === 3 ? 7.8 : 0.5, oldest: i === 3 ? 2.5 : 1 })))), []);
    assert.deepEqual(failing(verdict(series((i) => ({ lag: i === 3 ? 7.8 : 0.5, oldest: i === 3 ? 9 : 1 })))), []);
  });

  it('still fails a relay that has stopped with work waiting: the oldest message climbs past ten seconds while the gap between drains grows with it', () => {
    const stopped = series((i) => (i < 10 ? {} : { lag: (i - 9) * 2, depth: 2 + i * 50, oldest: (i - 9) * 2 }));
    assert.deepEqual(failing(verdict(stopped)), ['no message waits long for the relay']);
    assert.equal(verdict(stopped).failed, true);
  });

  it('still fails a relay that stopped and left its backlog: nothing has drained thirty seconds after the load ended', () => {
    const stoppedLate = series((i) => (i < 36 ? {} : { lag: (i - 35) * 2, oldest: 3 }));
    assert.deepEqual(failing(verdict(stoppedLate, 40)), ['the backlog drains once the load stops']);
  });

  it('fails a backlog that is still there thirty seconds after the load stopped', () => {
    assert.deepEqual(failing(verdict(series(), 1)), ['the backlog drains once the load stops']);
  });

  it('fails a run too short to compare, rather than passing on nothing', () => {
    const short = verdict(series().slice(0, 5));
    assert.equal(short.failed, true);
    assert.deepEqual(failing(short), ['enough samples to compare']);
    assert.equal(verdict([]).failed, true);
  });

  it('reports the longest gap between drains and the age of the oldest message then, and judges neither', () => {
    const run = series((i) => ({ lag: i === 5 ? 7.8 : 0.5, oldest: i === 5 ? 1.9 : 1 }));
    assert.deepEqual(relayGap(run), { gapSeconds: 7.8, oldestThenSeconds: 1.9 });
    assert.deepEqual(relayGap(series((i) => ({ lag: i === 0 ? 3 : 0.5, oldest: i === 0 ? 4 : 1 })).reverse()), { gapSeconds: 3, oldestThenSeconds: 4 });
    assert.ok(Number.isNaN(relayGap([]).gapSeconds) && Number.isNaN(relayGap([]).oldestThenSeconds));
    assert.deepEqual(verdict(series((i) => ({ lag: 100 }))).checks.map((c) => c.what).filter((what) => /relay/u.test(what)), ['no message waits long for the relay']);
  });

  it('has the thresholds the header states', () => {
    assert.deepEqual({ ...SOAK }, { rssGrowth: 1.3, maxPool: 10, oldestSeconds: 10, drainedBySeconds: 30 });
  });
});

describe('the stampede', () => {
  const crowd = (statuses) => statuses.map((status, i) => ({ status, ms: 100 + i }));

  it('passes when everyone signed in or was told the service was busy, and the server is ready', () => {
    const v = stampedeVerdict(crowd([...Array(150).fill(200), ...Array(50).fill(503)]), true);
    assert.equal(v.failed, false);
    assert.deepEqual([v.signedIn, v.busy], [150, 50]);
  });

  it('fails on any other answer, on nobody signing in, and on a server that is not ready', () => {
    assert.equal(stampedeVerdict(crowd([...Array(10).fill(200), 500]), true).failed, true);
    assert.equal(stampedeVerdict(crowd([...Array(10).fill(200), 429]), true).failed, true);
    assert.equal(stampedeVerdict(crowd(Array(10).fill(503)), true).failed, true);
    assert.equal(stampedeVerdict(crowd(Array(10).fill(200)), false).failed, true);
    assert.equal(stampedeVerdict(crowd(Array(10).fill(200)), true).failed, false);
  });
});

describe('reading the API\'s own metrics', () => {
  it('takes the values the soak and the report need from the text page', () => {
    const page = [
      'qb_process_resident_memory_bytes 123456',
      'qb_db_pool_connections{state="total"} 7',
      'qb_db_pool_connections{state="waiting"} 2',
      'qb_outbox_depth 4',
      'qb_outbox_oldest_unrelayed_age_seconds 12.5',
      'qb_outbox_relay_seconds_since_drain 0.4',
      'qb_refusals_total{code="RATE_LIMITED",reason="subject_short"} 3',
      'qb_http_requests_total{route="GET /a",status_class="2xx"} 10',
      'qb_http_requests_total{route="GET /b",status_class="4xx"} 5',
    ].join('\n');
    assert.deepEqual(readMetrics(page), { rss: 123456, pool: 7, waiting: 2, depth: 4, oldest: 12.5, lag: 0.4, refusals: ['RATE_LIMITED/subject_short x 3'], requests: 15 });
  });

  it('says NaN for what is not there, so a missing metric cannot read as zero', () => {
    const read = readMetrics('');
    assert.ok(Number.isNaN(read.rss) && Number.isNaN(read.depth));
    assert.deepEqual(read.refusals, []);
  });
});

describe('what a soak could have seen', () => {
  const samples = Array.from({ length: 40 }, (_, i) => ({ t: i * 2, rss: 100 * 1_048_576 }));

  it('is the allowed rise in the working set, divided by the requests made', () => {
    assert.equal(Math.round(seeableLeakBytes(samples, 1000)), Math.round((0.3 * 100 * 1_048_576) / 1000));
    assert.equal(Math.round(seeableLeakBytes(samples, 2000)), Math.round(seeableLeakBytes(samples, 1000) / 2));
  });

  it('is nothing for a run with no samples in the second quarter or no requests: it says so and does not invent a figure', () => {
    assert.ok(Number.isNaN(seeableLeakBytes([], 100)));
    assert.ok(Number.isNaN(seeableLeakBytes(samples, 0)));
  });
});

