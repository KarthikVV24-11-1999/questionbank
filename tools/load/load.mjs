// The load test and the soak (M8-51, M8-52): `node tools/load/load.mjs [load|soak]`, run by infra/compose/boot.mjs against the stack it has booted, after the journeys and the restore drill.
//
// WHAT THE LOAD IS. Derived, not asserted: model.mjs works the beta's own share of NFR §1.1 out (200 students; B1 package pull, B2 submission storm, B3 result rush, and everyone signing in on
// day one), multiplies it by 3 (NFR SCA-01) and prints the arithmetic first, so it can be disagreed with. The run plays the *rates* so derived, on four streams at once, for LOAD_SECONDS (default 90):
// the beta's windows are 5 to 30 minutes and the run is shorter, so it samples a window and does not play one. Arrivals are open-loop (an operation starts when its time comes, whether or not the
// last has finished), with the interval between them jittered by up to 30% so they do not march.
//
// WHAT IS MEASURED, AND AGAINST WHAT. Each operation's time as the client sees it (this process, through the learner app's nginx), at the 95th percentile, against the NFR table's target for its
// kind (model.mjs TARGETS). A breach, a failed operation or a stream with nothing measured exits non-zero, unless the breach is registered in KNOWN below with the debt that carries it. The paths the
// stack cannot serve (a 75-item form's submission, its scoring) are printed as BLOCKED with what they need, and are never simulated: a ten-question practice run is a different object and its numbers
// are labelled as its own.
//
// THE LIMITER. The authentication routes are rate limited per source address and per address typed (D94). This process is one source standing in for two hundred, and a real beta is two hundred
// sources, so the SOURCE tiers of login and registration are raised for the run (infra/compose/boot.mjs passes RATE_LIMIT_LOGIN and RATE_LIMIT_REGISTER to the API) and the SUBJECT tiers are left
// as they are. That is the test measuring something a real beta would not reach at the source tier, and it is said here and in the output; it does not measure the limiter, which has its own
// abuse simulation. Silently raising them would be a different thing.
//
// WHAT THE NUMBERS ARE. The runner is two vCPUs and this process shares them with the API, the database and the proxy, so latency is pessimistic (the generator contends with the thing it measures),
// throughput is a ceiling, and neither is the host's. It is a floor on how bad it gets and a finding about where the wall is, and not a production percentile. A run of 90 seconds makes about 900
// operations in all; it cannot show a problem that needs a different shape of load.
//
// THE SOAK is the same profile for SOAK_SECONDS (default 240), sampling the API's own `GET /metrics` every two seconds and judging four drifts against thresholds (model.mjs SOAK). Its arithmetic is
// printed with its result: the number of requests it made, and so the size of a per-request leak it could have seen.
import { webcrypto } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BETA, BLOCKED, SOAK, derive, judge, operationsIn, seeableLeakBytes, soakVerdict, stampedeVerdict, summarise } from './model.mjs';

const BASE = (process.env.STACK_URL ?? 'http://localhost:8080').replace(/\/$/u, '');
const METRICS = process.env.METRICS_URL ?? 'http://127.0.0.1:3000/metrics';
const MODE = process.argv[2] ?? 'load';
const SECONDS = Number(process.env.LOAD_SECONDS ?? (MODE === 'soak' ? 240 : 90));
const EXAM = process.env.EXAM_CODE ?? 'JEE_MAIN';
const YEAR = process.env.YEAR ?? '2026';
const PASSWORD = 'a long and ordinary passphrase';
const RUN_LENGTH = 10;

/** Breaches that are registered, by stream: the debt that carries each and why. Empty until a run finds one; a breach is not suppressed, it is written down here with its entry in docs/DEBT.md. */
export const KNOWN = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (line = '') => process.stdout.write(`${line}\n`);

async function call(method, path, { token, body, headers = {}, raw = false } = {}) {
  const began = performance.now();
  let status = 0;
  let json;
  try {
    const response = await fetch(`${BASE}${path}`, {
      method,
      headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    status = response.status;
    if (raw) await response.arrayBuffer();
    else {
      const text = await response.text();
      json = text === '' ? undefined : JSON.parse(text);
    }
  } catch {
    status = 0;
  }
  return { status, ms: performance.now() - began, body: json };
}

/** For the setup, which is not measured: a refusal for being busy or limited is waited out and tried again. */
async function patient(method, path, options, want) {
  for (let attempt = 1; attempt <= 12; attempt += 1) {
    const response = await call(method, path, options);
    if (response.status === want) return response;
    if (response.status !== 503 && response.status !== 429 && response.status !== 0) throw new Error(`setup: ${method} ${path} answered ${response.status} ${JSON.stringify(response.body)}`);
    await sleep(300 * attempt);
  }
  throw new Error(`setup: ${method} ${path} would not answer ${want}`);
}

async function pool(items, concurrency, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index], index);
    }
  }));
  return results;
}

let counter = 0;
const address = (kind) => `load-${kind}-${Date.now().toString(36)}-${(counter += 1)}@example.com`;

async function register(kind) {
  const email = address(kind);
  await patient('POST', '/v1/identity/register', { body: { email, password: PASSWORD } }, 202);
  const login = await patient('POST', '/v1/identity/login', { body: { email, password: PASSWORD } }, 200);
  return { email, token: login.body.sessionToken };
}

/** A learner who has chosen an exam and said which chapters, with a ten-question diagnostic made and started. */
async function learnerWithARun(kind) {
  const who = await register(kind);
  await patient('PATCH', '/v1/learning/profile', { token: who.token, body: { examCode: EXAM, targetYear: YEAR, currentClass: 'class_12' } }, 200);
  const options = (await patient('GET', '/v1/learning/profile/scope-options', { token: who.token }, 200)).body;
  const physics = options.nodes.find((node) => node.displayName === 'Physics' && node.parentNodeId === null);
  await patient('PATCH', '/v1/learning/profile', { token: who.token, body: { scopeNodeIds: [physics.nodeId] } }, 200);
  const profile = (await patient('GET', '/v1/learning/profile', { token: who.token }, 200)).body;
  const created = await patient('POST', '/v1/assessment/practice-attempts', { token: who.token, headers: { 'idempotency-key': `${who.email}` }, body: { examProfileVersionId: profile.exam.examProfileVersionId, selectionStrategy: 'breadth', count: RUN_LENGTH } }, 201);
  const attemptId = created.body.attempt.attemptId;
  await patient('POST', `/v1/assessment/attempts/${attemptId}/start`, { token: who.token }, 200);
  return { ...who, attemptId };
}

async function slotsOf(learner) {
  const response = await call('GET', `/v1/assessment/practice-attempts/${learner.attemptId}/package`, { token: learner.token });
  if (response.status !== 200) throw new Error(`setup: package answered ${response.status}`);
  const bytes = await (await fetch(`${BASE}/v1/assessment/practice-attempts/${learner.attemptId}/package`, { headers: { authorization: `Bearer ${learner.token}` } })).json();
  return bytes.slots.sort((a, b) => a.ordinal - b.ordinal).map((slot) => slot.slotId);
}

function eventsFor(learner, slotIds) {
  let sequence = 0;
  return slotIds.flatMap((slot, index) =>
    [['visit'], ['select', index % 2 === 0 ? 'b' : 'a'], ['leave']].map(([kind, answer]) => {
      sequence += 1;
      return { eventId: webcrypto.randomUUID(), attemptId: learner.attemptId, slot, sequence, monotonicMs: sequence * 3000, kind, ...(answer === undefined ? {} : { answer }) };
    }),
  );
}

const send = (learner, events) => call('POST', `/v1/assessment/attempts/${learner.attemptId}/events`, { token: learner.token, body: { deviceRef: 'load', events } });
const submit = (learner) => call('POST', `/v1/assessment/attempts/${learner.attemptId}/submission`, { token: learner.token, headers: { 'idempotency-key': `sub-${learner.attemptId}` }, body: { reason: 'manual' } });

async function mapHolds(learner, patience = 60_000) {
  const began = performance.now();
  while (performance.now() - began < patience) {
    const read = await call('GET', '/v1/learning/concept-map', { token: learner.token });
    if (read.status === 200 && read.body.assessedCount > 0) return performance.now() - began;
    await sleep(250);
  }
  return Number.POSITIVE_INFINITY;
}

/** The text exposition format, reduced to the values the soak and the report read. */
export function readMetrics(text) {
  const value = (pattern) => {
    const match = pattern.exec(text);
    return match === null ? Number.NaN : Number(match[1]);
  };
  const refusals = [...text.matchAll(/^qb_refusals_total\{code="([A-Z_]+)",reason="([a-z_]*)"\} (\S+)$/gmu)].map((m) => `${m[1]}/${m[2]} x ${m[3]}`);
  return {
    rss: value(/^qb_process_resident_memory_bytes (\S+)$/mu),
    pool: value(/^qb_db_pool_connections\{state="total"\} (\S+)$/mu),
    waiting: value(/^qb_db_pool_connections\{state="waiting"\} (\S+)$/mu),
    depth: value(/^qb_outbox_depth (\S+)$/mu),
    oldest: value(/^qb_outbox_oldest_unrelayed_age_seconds (\S+)$/mu),
    lag: value(/^qb_outbox_relay_seconds_since_drain (\S+)$/mu),
    refusals,
    requests: [...text.matchAll(/^qb_http_requests_total\{[^}]*\} (\S+)$/gmu)].reduce((sum, m) => sum + Number(m[1]), 0),
  };
}
const scrape = async () => readMetrics(await (await fetch(METRICS)).text());

/** Starts `count` operations spread over `seconds` at the loaded rate, each at its own moment, with jitter, without waiting for the last to end. */
function arrivals(count, seconds) {
  const gap = (seconds * 1000) / count;
  return Array.from({ length: count }, (_, index) => Math.max(0, (index + 0.5) * gap + (Math.random() - 0.5) * 0.6 * gap));
}

function printDerivation(derived) {
  log(`THE LOAD, derived from NFR §1.1 for ${BETA.students} students at ${BETA.factor}x (SCA-01), and what this run plays of it (${SECONDS} s)`);
  log('  stream     beta ops / window         loaded rate   this run');
  for (const [name, d] of Object.entries(derived)) {
    log(`  ${name.padEnd(9)} ${String(d.operations).padStart(4)} / ${String(d.windowSeconds).padStart(4)} s = ${d.perSecond.toFixed(3)}/s   ${d.loadedPerSecond.toFixed(3)}/s      ${String(operationsIn(d, SECONDS)).padStart(4)} ops   (${d.what})`);
  }
}

async function runLoad(seconds, onTick) {
  const derived = derive();
  printDerivation(derived);
  const n = Object.fromEntries(Object.entries(derived).map(([name, d]) => [name, operationsIn(d, seconds)]));
  log(`\nsetting up learners (not measured): ${n.signIn} sign-ins over ${Math.ceil(n.signIn / 3)} accounts, ${n.package} runs to pull, ${n.submit} to submit, ${n.result} finished and scored`);
  const setupBegan = performance.now();
  const signers = await pool(Array.from({ length: Math.ceil(n.signIn / 3) }, (_, i) => i), 6, async () => ({ email: address('signin') })).then(async (list) => pool(list, 6, async (item) => (await patient('POST', '/v1/identity/register', { body: { email: item.email, password: PASSWORD } }, 202), item)));
  const pullers = await pool(Array.from({ length: n.package }, (_, i) => i), 6, () => learnerWithARun('pull'));
  const submitters = await pool(Array.from({ length: n.submit }, (_, i) => i), 6, async () => {
    const learner = await learnerWithARun('submit');
    return { ...learner, events: eventsFor(learner, await slotsOf(learner)) };
  });
  const readers = await pool(Array.from({ length: n.result }, (_, i) => i), 6, async () => {
    const learner = await learnerWithARun('read');
    await patient('POST', `/v1/assessment/attempts/${learner.attemptId}/events`, { token: learner.token, body: { deviceRef: 'load', events: eventsFor(learner, await slotsOf(learner)) } }, 200);
    await patient('POST', `/v1/assessment/attempts/${learner.attemptId}/submission`, { token: learner.token, headers: { 'idempotency-key': `sub-${learner.attemptId}` }, body: { reason: 'manual' } }, 200);
    return learner;
  });
  for (const reader of readers) if ((await mapHolds(reader, 120_000)) === Number.POSITIVE_INFINITY) throw new Error('setup: a finished run was never scored');
  log(`set up ${signers.length + pullers.length + submitters.length + readers.length} accounts in ${Math.round((performance.now() - setupBegan) / 1000)} s`);

  const samples = { signIn: [], package: [], events: [], submission: [], conceptMap: [], profile: [], resultAvailable: [] };
  const record = (name, response) => samples[name].push({ status: response.status, ms: response.ms });
  const began = performance.now();
  const launched = [];
  const at = (offsets, work) => offsets.forEach((offset, index) => launched.push(sleep(offset).then(() => work(index))));
  at(arrivals(n.signIn, seconds), async (i) => record('signIn', await call('POST', '/v1/identity/login', { body: { email: signers[i % signers.length].email, password: PASSWORD } })));
  at(arrivals(n.package, seconds), async (i) => record('package', await call('GET', `/v1/assessment/practice-attempts/${pullers[i].attemptId}/package`, { token: pullers[i].token, raw: true })));
  at(arrivals(n.submit, seconds), async (i) => {
    const learner = submitters[i];
    record('events', await send(learner, learner.events));
    const submitted = await submit(learner);
    record('submission', submitted);
    const waited = await mapHolds(learner, 60_000);
    samples.resultAvailable.push({ status: Number.isFinite(waited) ? 200 : 504, ms: Number.isFinite(waited) ? waited : 60_000 });
  });
  at(arrivals(n.result, seconds), async (i) => {
    record('conceptMap', await call('GET', '/v1/learning/concept-map', { token: readers[i].token }));
    record('profile', await call('GET', '/v1/learning/profile', { token: readers[i].token }));
  });
  const ticker = onTick === undefined ? undefined : (async () => {
    while (performance.now() - began < seconds * 1000 + 15_000) {
      await onTick((performance.now() - began) / 1000);
      await sleep(2000);
    }
  })();
  await Promise.all(launched);
  return { samples, began, ticker, requestsMade: Object.values(samples).reduce((sum, list) => sum + list.length, 0) };
}

function report(results) {
  const verdict = judge(results, KNOWN);
  log('\nRESULTS (client time through the learner app\'s proxy; one runner, two vCPUs, generator on the same box: pessimistic latency, a ceiling on throughput, not the host\'s numbers)');
  log('  operation                                   target            n    ok     p50     p95     p99     max   verdict');
  for (const row of verdict.rows) {
    const r = row.result ?? { count: 0, ok: 0 };
    const f = (v) => (Number.isFinite(v) ? String(Math.round(v)).padStart(6) : '     -');
    const word = row.breaches.length === 0 ? (row.healed ? 'ok (registered breach has healed)' : 'ok') : row.registered === undefined ? `BREACH: ${row.breaches.join('; ')}` : `known breach (${row.registered}): ${row.breaches.join('; ')}`;
    log(`  ${row.target.what.slice(0, 40).padEnd(40)} ${row.target.id} p95 <= ${String(row.target.ms).padStart(5)} ms ${String(r.count).padStart(4)} ${String(r.ok).padStart(5)} ${f(r.p50)}  ${f(r.p95)}  ${f(r.p99)}  ${f(r.max)}   ${word}`);
  }
  log('\nBLOCKED here, and what each needs:');
  for (const b of BLOCKED) log(`  ${b.id} ${b.what}: ${b.needs}`);
  return verdict;
}

/** Every student signs in at the same moment: the day-one login with no spread (model.mjs stampedeVerdict). */
async function stampede() {
  const students = BETA.students;
  log(`\nTHE STAMPEDE: ${students} students sign in in the same instant (reported, not judged against a target)`);
  const accounts = await pool(Array.from({ length: students }, (_, i) => i), 8, async () => {
    const email = address('stampede');
    await patient('POST', '/v1/identity/register', { body: { email, password: PASSWORD } }, 202);
    return email;
  });
  const began = performance.now();
  const samples = await Promise.all(accounts.map((email) => call('POST', '/v1/identity/login', { body: { email, password: PASSWORD } })));
  const took = (performance.now() - began) / 1000;
  const ready = (await call('GET', '/readyz')).status === 200 || (await fetch(METRICS.replace('/metrics', '/readyz')).then((r) => r.status === 200, () => false));
  const verdict = stampedeVerdict(samples, ready);
  log(`  ${verdict.signedIn} signed in (p50 ${Math.round(verdict.p50)} ms, p95 ${Math.round(verdict.p95)} ms, slowest ${Math.round(verdict.max)} ms), ${verdict.busy} were told the service was busy; all ${students} answered in ${took.toFixed(1)} s`);
  for (const check of verdict.checks) log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.what}: ${check.detail}`);
  return verdict;
}

async function main() {
  if (MODE === 'soak') {
    const series = [];
    const outcome = await runLoad(SECONDS, async (t) => {
      try {
        series.push({ t, ...(await scrape()) });
      } catch {
        // a scrape that fails is a gap in the series, and a series with gaps fails its own sample count
      }
    });
    await outcome.ticker;
    const results = Object.fromEntries(Object.entries(outcome.samples).map(([name, list]) => [name, summarise(list)]));
    const verdict = report(results);
    log(`\nSOAK: ${SECONDS} s of the profile, ${outcome.requestsMade} measured requests (and the setup's, and the polling for results), ${series.length} samples of /metrics`);
    const leak = seeableLeakBytes(series, outcome.requestsMade);
    log(`  arithmetic: the run made ${outcome.requestsMade} measured requests (and the setup's, and the polling for results, which are more). The RSS threshold is a rise of ${Math.round((SOAK.rssGrowth - 1) * 100)}% over the second quarter's median, so a leak is seen only if it is more than about ${Math.round(leak / 1024)} KiB for every measured request. A smaller leak passes, and so does one that needs a day, a restart or a different request mix to show.`);
    await sleep(SOAK.drainedBySeconds * 1000);
    const tail = await scrape();
    const soak = soakVerdict(series, { depth: tail.depth });
    for (const check of soak.checks) log(`  ${check.ok ? 'ok  ' : 'FAIL'} ${check.what}: ${check.detail}`);
    log(`  refusals counted by the API over the run: ${tail.refusals.length === 0 ? 'none' : tail.refusals.join(', ')}`);
    process.exit(soak.failed || verdict.failed ? 1 : 0);
  }
  const outcome = await runLoad(SECONDS);
  const results = Object.fromEntries(Object.entries(outcome.samples).map(([name, list]) => [name, summarise(list)]));
  const verdict = report(results);
  let tail;
  try {
    tail = await scrape();
    log(`\nthe API's own account: ${tail.requests} requests counted, pool ${tail.pool} clients (${tail.waiting} waiting), outbox ${tail.depth} waiting, relay ${Math.round(tail.lag * 10) / 10} s since a drain, refusals: ${tail.refusals.length === 0 ? 'none' : tail.refusals.join(', ')}`);
  } catch {
    log('\nthe API\'s own account could not be read from /metrics');
  }
  const crowd = await stampede();
  process.exit(verdict.failed || crowd.failed ? 1 : 0);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    log(`\nLOAD RUN FAILED: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
