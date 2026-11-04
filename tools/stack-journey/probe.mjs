// The synthetic probe (M8-55): `PROBE_URL=https://… PROBE_EMAIL=… PROBE_PASSWORD=… node tools/stack-journey/probe.mjs`, run on a schedule (docs/DEPLOYMENT.md#watching-it).
//
// It is the check made from outside, through whatever is in front of the learner app (the TLS proxy, nginx), as a learner does: the page is served, a sign-in works, the session is in force,
// and the three reads a learner's home makes answer. It is not `journey.mjs`, which registers a learner, reads the confirmation from the mail directory a development stack writes and sits a
// diagnostic: none of that can be done against a host that sends real mail and holds real learners. The probe needs one account that already exists, made once by the owner by registering through
// the app, and its credentials come from the environment, never from a file in the repository.
//
// It signs out when it finishes, so each run leaves no session behind. It makes eight requests and writes nothing but a session, which it ends.
//
//   PROBE_URL        the address the learner app is served at (required), no path
//   PROBE_EMAIL, PROBE_PASSWORD   the probe account's (required)
//   PROBE_TEXTFILE   a file to write the result to in the text exposition format, for a node exporter's textfile collector or anything that reads one: qb_probe_success,
//                    qb_probe_duration_seconds{step} and qb_probe_last_run_timestamp_seconds. Written whole and moved into place, so a reader never sees half of it.
//
// Exit 0: every step answered as it should within its limit. 1: a step failed or was slow (named, with why). 2: not configured.
import { renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/** How long each step may take, in ms, from outside and through TLS: looser than the API's own targets, because the network is in it. */
export const LIMITS = Object.freeze({ page: 2000, 'sign in': 2000, 'session in force': 1000, profile: 1000, 'concept map': 1500, 'review plan': 1500, 'sign out': 1000 });

export async function probe({ url, email, password, fetchImpl = fetch, now = () => performance.now() }) {
  const base = url.replace(/\/$/u, '');
  const steps = [];
  let token;
  const step = async (name, run) => {
    const began = now();
    let failure = null;
    try {
      failure = (await run()) ?? null;
    } catch (error) {
      failure = `no answer (${error instanceof Error ? error.name : 'error'})`;
    }
    const ms = Math.round((now() - began) * 10) / 10;
    if (failure === null && ms > LIMITS[name]) failure = `took ${Math.round(ms)} ms, limit ${LIMITS[name]} ms`;
    steps.push({ name, ms, failure });
    return failure === null;
  };
  const get = (path) => fetchImpl(`${base}${path}`, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  const expect200 = (what) => async (response) => (response.status === 200 ? null : `${what} answered ${response.status}`);

  const alive = await step('page', async () => {
    const response = await get('/');
    const text = await response.text();
    return response.status === 200 && text.includes('<div id="root">') ? null : `the page answered ${response.status}`;
  });
  const signedIn =
    alive &&
    (await step('sign in', async () => {
      const response = await fetchImpl(`${base}/v1/identity/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
      if (response.status !== 200) return `sign in answered ${response.status}`;
      token = (await response.json()).sessionToken;
      return typeof token === 'string' && token.length > 0 ? null : 'sign in gave no session';
    }));
  if (signedIn) {
    await step('session in force', async () => {
      const response = await get('/v1/identity/session');
      return response.status === 200 && (await response.json()).signedIn === true ? null : `the session is not in force (${response.status})`;
    });
    await step('profile', async () => expect200('the profile')(await get('/v1/learning/profile')));
    await step('concept map', async () => expect200('the concept map')(await get('/v1/learning/concept-map')));
    await step('review plan', async () => expect200('the review plan')(await get('/v1/learning/review-plan')));
    await step('sign out', async () => {
      const response = await fetchImpl(`${base}/v1/identity/logout`, { method: 'POST', headers: { authorization: `Bearer ${token}` } });
      return response.status === 200 ? null : `sign out answered ${response.status}`;
    });
  }
  // a step is skipped only because an earlier one failed, so a run with all its steps passing is a run in which every step ran
  return { ok: steps.every((entry) => entry.failure === null), steps };
}

/** The result in the text exposition format. A step that did not run is absent, and the run is a failure. */
export function exposition(result, at) {
  return [
    '# HELP qb_probe_success 1 if every step of the synthetic probe answered as it should within its limit.',
    '# TYPE qb_probe_success gauge',
    `qb_probe_success ${result.ok ? 1 : 0}`,
    '# HELP qb_probe_duration_seconds How long each step of the probe took.',
    '# TYPE qb_probe_duration_seconds gauge',
    ...result.steps.map((entry) => `qb_probe_duration_seconds{step="${entry.name}"} ${entry.ms / 1000}`),
    '# HELP qb_probe_last_run_timestamp_seconds When the probe last finished.',
    '# TYPE qb_probe_last_run_timestamp_seconds gauge',
    `qb_probe_last_run_timestamp_seconds ${Math.floor(at / 1000)}`,
    '',
  ].join('\n');
}

export async function main(env, write = (line) => process.stdout.write(`${line}\n`)) {
  const { PROBE_URL: url, PROBE_EMAIL: email, PROBE_PASSWORD: password, PROBE_TEXTFILE: textfile } = env;
  if (!url || !email || !password) {
    write('probe: PROBE_URL, PROBE_EMAIL and PROBE_PASSWORD are required');
    return 2;
  }
  const result = await probe({ url, email, password });
  for (const entry of result.steps) write(`  ${entry.failure === null ? 'ok  ' : 'FAIL'} ${entry.name.padEnd(17)} ${String(entry.ms).padStart(8)} ms${entry.failure === null ? '' : `  ${entry.failure}`}`);
  if (result.steps.length < Object.keys(LIMITS).length) write(`  FAIL ${Object.keys(LIMITS).length - result.steps.length} steps did not run, because an earlier one failed`);
  if (textfile) {
    writeFileSync(`${textfile}.tmp`, exposition(result, Date.now()));
    renameSync(`${textfile}.tmp`, textfile);
  }
  write(result.ok ? 'probe: ok' : 'probe: FAILED');
  return result.ok ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(await main(process.env));
