// The arithmetic of the load test (M8-51) and the thresholds of the soak (M8-52), with no network in it so that it can be tested. `load.mjs` runs it.
//
// THE DERIVATION. NFR §1.1 says what drives load here: sustained in-exam concurrency does not (offline-first capture turns a three-hour sitting into two short bursts), and three bursts do. The
// beta is 200 invited students. From the NFR's own shares:
//
//   B1, package pre-download:  80% of 200 pull a package in a 15-minute window  = 160 pulls / 900 s   = 0.178 /s
//   B2, submission storm:      60% of 200 submit inside 5 minutes               = 120 submits / 300 s = 0.400 /s
//   B3, result rush:           100% of 200 read results within 30 minutes       = 200 reads / 1800 s  = 0.111 /s
//   day one, signing in:       100% of 200 sign in within 5 minutes             = 200 logins / 300 s  = 0.667 /s
//
// The last is not in the NFR and is this file's own assumption: "within minutes" is taken as five. A class that is told to log in at nine does it faster than that, and the stampede is the
// thing the day-one login is for. SCA-01 asks for the load at 3x the projected peak, so every rate above is multiplied by 3 (FACTOR). To disagree with any figure, change the line that holds it.
export const BETA = Object.freeze({
  students: 200,
  factor: 3,
  streams: Object.freeze({
    signIn: Object.freeze({ share: 1.0, windowSeconds: 300, what: 'everyone signs in on day one, within five minutes (this file\'s assumption)' }),
    package: Object.freeze({ share: 0.8, windowSeconds: 900, what: 'B1: 80% pull a package in the 15 minutes before a mock' }),
    submit: Object.freeze({ share: 0.6, windowSeconds: 300, what: 'B2: 60% submit inside the 5 minutes at the end' }),
    result: Object.freeze({ share: 1.0, windowSeconds: 1800, what: 'B3: everyone reads their result within 30 minutes of publication' }),
  }),
});

/** For each stream: how many operations the beta makes, in what window, at what rate, and the same at the factor. */
export function derive(beta = BETA) {
  const out = {};
  for (const [name, stream] of Object.entries(beta.streams)) {
    const beta1 = beta.students * stream.share;
    out[name] = {
      what: stream.what,
      operations: beta1,
      windowSeconds: stream.windowSeconds,
      perSecond: beta1 / stream.windowSeconds,
      loadedOperations: beta1 * beta.factor,
      loadedPerSecond: (beta1 * beta.factor) / stream.windowSeconds,
    };
  }
  return out;
}

/** How many operations of a stream a run of `seconds` makes at the loaded rate: the rate is the derived one, and the run is shorter than the window, so the window is sampled and not played. */
export const operationsIn = (stream, seconds) => Math.ceil(stream.loadedPerSecond * seconds);

/** Nearest-rank percentile of a list of numbers, 0 < p <= 100. NaN for an empty list: a percentile of nothing is not 0. */
export function percentile(values, p) {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
}

/**
 * What the NFR table asks of each operation measured here, at the 95th percentile (the table's "target" column is the p95 target). `PER-09` is the T0/T1 write API, and sign-in and
 * registration are writes. The blocked ones are in `BLOCKED`.
 */
export const TARGETS = Object.freeze({
  signIn: Object.freeze({ id: 'PER-09', ms: 300, what: 'sign in (a write, and a password hash)' }),
  package: Object.freeze({ id: 'PER-08', ms: 200, what: 'a practice run\'s package (a read)' }),
  events: Object.freeze({ id: 'PER-09', ms: 300, what: 'the answers of a run sent (a write)' }),
  submission: Object.freeze({ id: 'PER-09', ms: 300, what: 'a run submitted (a write)' }),
  conceptMap: Object.freeze({ id: 'PER-16', ms: 500, what: 'the concept map read' }),
  profile: Object.freeze({ id: 'PER-08', ms: 200, what: 'the learner\'s profile (a read)' }),
  resultAvailable: Object.freeze({ id: 'PER-13', ms: 60_000, what: 'time from a run\'s submission to its result being in the map' }),
});

/** What cannot be measured on the stack as it is seeded, and what it needs. A target here is not passed and not failed: it is blocked. */
export const BLOCKED = Object.freeze([
  { id: 'PER-10', what: 'attempt submission ingest, 75 to 180 responses', needs: 'a published 75-item JEE form or a 180-item NEET form and an operator to publish it; the seed loads 18 demonstration questions on 6 topics, and a form is assembled and published by an ops principal' },
  { id: 'PER-11', what: 'scoring a 75-item JEE Main form', needs: 'the same form; a run of ten questions scores in a different time and is not reported as this' },
  { id: 'PER-12', what: 'scoring a 180-item NEET form', needs: 'the same form' },
  { id: 'SCA-02', what: 'B1 egress and a CDN hit ratio of 95%', needs: 'a CDN and a host; this is the package\'s latency through one nginx, not egress' },
  { id: 'SCA-03', what: '250,000 attempts (20 million responses) in five minutes', needs: 'a deployment sized for the ceiling; this is 3x a beta of 200' },
  { id: 'SCA-04', what: '100,000 result reads a minute for thirty minutes', needs: 'the same' },
]);

/** The result of one stream: durations in ms of the operations that were answered 2xx, and the count of each status that was not. */
export function summarise(samples) {
  const ok = samples.filter((sample) => sample.status >= 200 && sample.status < 300).map((sample) => sample.ms);
  const failures = {};
  for (const sample of samples) if (!(sample.status >= 200 && sample.status < 300)) failures[sample.status] = (failures[sample.status] ?? 0) + 1;
  return { count: samples.length, ok: ok.length, failures, p50: percentile(ok, 50), p95: percentile(ok, 95), p99: percentile(ok, 99), max: ok.length === 0 ? Number.NaN : Math.max(...ok) };
}

/**
 * The verdict: for each measured stream, a breach if its p95 is over its target, if nothing succeeded, or if any operation failed. A breach that is registered in `known` (stream name to the debt that carries it
 * and why) is reported and does not fail the run; a registered breach that did not happen is said so, so that a fixed one is seen to be fixed. A stream with no samples is a failure of the run, not a pass.
 */
export function judge(results, known = {}, targets = TARGETS) {
  const rows = [];
  for (const [name, target] of Object.entries(targets)) {
    const r = results[name];
    const breaches = [];
    if (r === undefined || r.count === 0) breaches.push('nothing was measured');
    else {
      if (r.ok === 0) breaches.push('nothing succeeded');
      else if (!(r.p95 <= target.ms)) breaches.push(`p95 ${Math.round(r.p95)} ms is over ${target.ms} ms`);
      const failed = r.count - r.ok;
      if (failed > 0) breaches.push(`${failed} of ${r.count} failed (${Object.entries(r.failures).map(([status, n]) => `${n} x ${status}`).join(', ')})`);
    }
    const registered = known[name];
    rows.push({ name, target, result: r, breaches, registered, fails: breaches.length > 0 && registered === undefined, healed: breaches.length === 0 && registered !== undefined });
  }
  return { rows, failed: rows.some((row) => row.fails) };
}

/** The median of a list, for the soak's comparisons. NaN for nothing. */
export const median = (values) => percentile(values, 50);

/**
 * The soak's thresholds, each a number with a reason, each checked against the samples the run took of `GET /metrics`. A sample is `{ t, rss, pool, depth, oldest, lag }`: seconds since the start,
 * resident bytes, the pool's total clients, the outbox's waiting messages, the age of the oldest in seconds, and seconds since the relay last drained.
 *
 *   rss: the median of the last quarter of the run may not be more than 30% above the median of the second quarter. The first quarter is warm-up (the heap grows to its working size) and is not
 *        counted either way. A per-request leak shows as a slope; a working set that has settled does not.
 *   pool: the most clients the pool ever held may not exceed MAX_POOL (the pool's own cap, 10 in `pool.ts`), and the last quarter's median may not be above the second quarter's.
 *   depth and oldest: during the run the oldest unrelayed message may not be older than 10 s (the relay ticks every second), and when the load has stopped and the relay has had 30 s the backlog
 *        must be 0. A queue that forms under load and drains is the finding; one that does not drain is the failure.
 *   lag: the relay may not go more than 5 s without finishing a drain, at any sample.
 */
export const SOAK = Object.freeze({ rssGrowth: 1.3, maxPool: 10, oldestSeconds: 10, drainedBySeconds: 30, lagSeconds: 5 });

export function soakVerdict(samples, tail, limits = SOAK) {
  const checks = [];
  const span = samples.at(-1)?.t ?? 0;
  const within = (from, to) => samples.filter((sample) => sample.t >= span * from && sample.t <= span * to);
  const second = within(0.25, 0.5);
  const last = within(0.75, 1);
  const need = (what, ok, detail) => checks.push({ what, ok, detail });
  if (samples.length < 8 || second.length === 0 || last.length === 0) {
    need('enough samples to compare', false, `${samples.length} samples`);
    return { checks, failed: true };
  }
  const rss2 = median(second.map((s) => s.rss));
  const rss4 = median(last.map((s) => s.rss));
  need('resident memory settles', rss4 <= rss2 * limits.rssGrowth, `median of the last quarter ${mib(rss4)} MiB against ${mib(rss2)} MiB in the second (limit x${limits.rssGrowth})`);
  const pool2 = median(second.map((s) => s.pool));
  const pool4 = median(last.map((s) => s.pool));
  need('the pool stays inside its cap', Math.max(...samples.map((s) => s.pool)) <= limits.maxPool, `most clients held ${Math.max(...samples.map((s) => s.pool))}, cap ${limits.maxPool}`);
  need('the pool does not creep', pool4 <= pool2, `median ${pool4} in the last quarter against ${pool2} in the second`);
  need('no message waits long for the relay', Math.max(...samples.map((s) => s.oldest)) <= limits.oldestSeconds, `oldest unrelayed message was ${Math.round(Math.max(...samples.map((s) => s.oldest)) * 10) / 10} s old at its worst, limit ${limits.oldestSeconds} s`);
  need('the relay keeps draining', Math.max(...samples.map((s) => s.lag)) <= limits.lagSeconds, `the longest wait between drains was ${Math.round(Math.max(...samples.map((s) => s.lag)) * 10) / 10} s, limit ${limits.lagSeconds} s`);
  need('the backlog drains once the load stops', tail.depth === 0, `${tail.depth} messages waiting ${limits.drainedBySeconds} s after the load stopped`);
  return { checks, failed: checks.some((check) => !check.ok) };
}
const mib = (bytes) => Math.round(bytes / 1_048_576);

/**
 * The stampede is the day-one login with no spread at all: every student signs in at the same moment. It has no row in the NFR table (the rate is the beta's whole login set in one second,
 * hundreds of times the derived one), so it is **reported and not judged against a target**. What fails the run is the server not coping in a way it should not: an answer that is neither a
 * sign-in nor the documented refusal for being busy (503), or the server being unready afterwards. A 503 is the bound on password hashing doing its job (a queue of 256 waiting at most 15 s) and
 * is counted, with the share of the stampede it was.
 */
export function stampedeVerdict(samples, readyAfter) {
  const by = {};
  for (const sample of samples) by[sample.status] = (by[sample.status] ?? 0) + 1;
  const ok = samples.filter((sample) => sample.status === 200).map((sample) => sample.ms);
  const unexpected = Object.entries(by).filter(([status]) => status !== '200' && status !== '503');
  const checks = [
    { what: 'every answer was a sign-in or the busy refusal', ok: unexpected.length === 0, detail: unexpected.length === 0 ? `${by[200] ?? 0} signed in, ${by[503] ?? 0} told the service was busy` : `unexpected: ${unexpected.map(([status, n]) => `${n} x ${status}`).join(', ')}` },
    { what: 'someone signed in', ok: ok.length > 0, detail: `${ok.length} of ${samples.length}` },
    { what: 'the server is ready afterwards', ok: readyAfter === true, detail: readyAfter === true ? '/readyz answered 200' : '/readyz did not answer 200' },
  ];
  return { checks, by, signedIn: ok.length, busy: by[503] ?? 0, p50: percentile(ok, 50), p95: percentile(ok, 95), max: ok.length === 0 ? Number.NaN : Math.max(...ok), failed: checks.some((check) => !check.ok) };
}

/**
 * What size of per-request leak the soak could have seen: the RSS threshold allows a rise of (rssGrowth - 1) of the settled working set, so a leak of L bytes a request over N requests is seen
 * only if L x N exceeds that. Returns the L at which it just would be, in bytes. A leak smaller than this passes the soak, and so does one that needs more than N requests to show.
 */
export function seeableLeakBytes(samples, requests, limits = SOAK) {
  const span = samples.at(-1)?.t ?? 0;
  const second = samples.filter((sample) => sample.t >= span * 0.25 && sample.t <= span * 0.5).map((sample) => sample.rss);
  return (second.length === 0 || requests === 0 ? Number.NaN : ((limits.rssGrowth - 1) * median(second)) / requests);
}
