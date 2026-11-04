// The path from sign-up to a first named weakness, run over HTTP against a stack that is up (M8-40). It is the journey `first-weakness-journey.integration.spec.ts` runs inside one process,
// asked of the containers instead: every request goes to the address the learner app is served from, which proxies `/v1/` to the API, so what it measures is what the app's own requests cost
// through the network stack and the proxy, and not what a handler costs.
//
// What it is and is not. It is one learner on one machine with no person reading anything; the figures are a floor on the machine's share of the ten minutes and not the criterion, as the in-process ones are.
// It checks three things the app depends on besides the path: the service worker is served from the root with nothing that would let it be cached stale, the learner app's page is served,
// and a practice run's signed package reaches the client byte for byte (its digest, its ETag and its signature all agree with the bytes received), which a proxy that rewrote a body or weakened an ETag would break.
//
//   STACK_URL   where the learner app is served (default http://localhost:8080)
//   MAIL_DIR    the directory the API writes its mail to (a development stack writes mail to files; production has no mail provider yet)
//   SERVED_APP  set to 0 to run against an API with no learner app in front of it, which skips the checks of the page and the service worker; the stack's own run never sets it
//   EXAM_CODE   the exam to choose (default JEE_MAIN); YEAR its academic year (default 2026)
//
// Exits non-zero on any failed step or check, naming it.
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

const BASE = (process.env.STACK_URL ?? 'http://localhost:8080').replace(/\/$/u, '');
const MAIL_DIR = process.env.MAIL_DIR;
const EXAM_CODE = process.env.EXAM_CODE ?? 'JEE_MAIN';
const YEAR = process.env.YEAR ?? '2026';
const PASSWORD = 'a long and ordinary passphrase';
const RUN_LENGTH = 10;

const steps = [];
async function timed(step, run) {
  const began = performance.now();
  const value = await run();
  steps.push({ step, ms: Math.round((performance.now() - began) * 10) / 10 });
  return value;
}
function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
}

async function call(method, path, { token, body, headers = {}, bytes = false } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (bytes) return { status: response.status, headers: response.headers, bytes: new Uint8Array(await response.arrayBuffer()) };
  const text = await response.text();
  let json;
  try {
    json = text === '' ? undefined : JSON.parse(text);
  } catch {
    json = undefined;
  }
  return { status: response.status, headers: response.headers, body: json, text };
}

async function expectStatus(label, promise, status) {
  const response = await promise;
  check(response.status === status, `${label}: expected ${status}, got ${response.status} ${response.text ?? ''}`.trim());
  return response;
}

/** The code in the verification mail a development stack wrote for this address. */
async function verificationCode(address) {
  check(MAIL_DIR !== undefined, 'MAIL_DIR is not set, so the verification code cannot be read');
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const names = (await readdir(MAIL_DIR).catch(() => [])).filter((name) => name.endsWith('-email_verification.txt')).sort().reverse();
    for (const name of names) {
      const contents = await readFile(join(MAIL_DIR, name), 'utf8');
      if (contents.startsWith(`To: ${address}\n`)) return /code is (\S+)\./u.exec(contents)?.[1];
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no verification mail for ${address} in ${MAIL_DIR}`);
}

const base64ToBytes = (text) => Uint8Array.from(Buffer.from(text, 'base64'));
const hex = (buffer) => [...new Uint8Array(buffer)].map((byte) => byte.toString(16).padStart(2, '0')).join('');

/** The learner's own check of a package (apps/learn/src/package/verify.ts), on the bytes as they arrived. */
async function packageIsIntact(received, publicKey) {
  const digest = hex(await webcrypto.subtle.digest('SHA-256', received.bytes));
  const header = received.headers.get('x-package-digest');
  const etag = received.headers.get('etag');
  const key = await webcrypto.subtle.importKey('spki', base64ToBytes(publicKey), { name: 'Ed25519' }, false, ['verify']);
  const signed = await webcrypto.subtle.verify({ name: 'Ed25519' }, key, base64ToBytes(received.headers.get('x-package-signature') ?? ''), received.bytes);
  return { digest, header, etag, signed };
}

const address = `learner-${Math.random().toString(16).slice(2, 10)}@example.com`;

// the served app: the page, and the service worker from the root with a header that lets the browser see a new one at once
if (process.env.SERVED_APP !== '0') await timed('the page and the service worker are served', async () => {
  const page = await call('GET', '/');
  check(page.status === 200 && /<div id="root">/u.test(page.text), 'the learner app\'s page is not served at the root');
  const worker = await call('GET', '/sw.js');
  check(worker.status === 200, `the service worker is not served at /sw.js (${worker.status})`);
  check(/javascript/u.test(worker.headers.get('content-type') ?? ''), 'the service worker is not served as JavaScript');
  const caching = worker.headers.get('cache-control') ?? '';
  check(/no-cache|no-store|max-age=0/u.test(caching), `the service worker may be cached: cache-control is "${caching}"`);
});

await timed('register', async () => expectStatus('register', call('POST', '/v1/identity/register', { body: { email: address, password: PASSWORD } }), 202));
await timed('verify the address', async () => expectStatus('verify', call('POST', '/v1/identity/email/verify', { body: { token: await verificationCode(address) } }), 200));
const session = await timed('sign in', async () => (await expectStatus('login', call('POST', '/v1/identity/login', { body: { email: address, password: PASSWORD } }), 200)).body.sessionToken);
check(typeof session === 'string' && session.length > 0, 'sign in gave no session');

await timed('choose an exam', async () => expectStatus('choose an exam', call('PATCH', '/v1/learning/profile', { token: session, body: { examCode: EXAM_CODE, targetYear: YEAR, currentClass: 'class_12' } }), 200));
await timed('say which chapters are studied', async () => {
  const options = (await expectStatus('scope options', call('GET', '/v1/learning/profile/scope-options', { token: session }), 200)).body;
  const physics = options.nodes.find((node) => node.displayName === 'Physics' && node.parentNodeId === null);
  check(physics !== undefined, 'the syllabus has no subject called Physics');
  await expectStatus('declare scope', call('PATCH', '/v1/learning/profile', { token: session, body: { scopeNodeIds: [physics.nodeId] } }), 200);
});

const profile = (await call('GET', '/v1/learning/profile', { token: session })).body;
await timed('home decides what to offer', async () => {
  await expectStatus('review plan', call('GET', '/v1/learning/review-plan', { token: session }), 200);
  const weakest = await expectStatus('weakest', call('GET', `/v1/learning/remediation-concepts?taxonomyVersionId=${profile.exam.taxonomyVersionId}`, { token: session }), 200);
  check(weakest.body.conceptIdentityIds.length === 0, 'a learner who has answered nothing has a weakest topic');
  const map = await expectStatus('concept map', call('GET', '/v1/learning/concept-map', { token: session }), 200);
  check(map.body.assessedCount === 0, 'the map of a new learner holds an answer');
});

const run = await timed('make and start the diagnostic, and serve its questions', async () => {
  const created = await expectStatus('make the diagnostic', call('POST', '/v1/assessment/practice-attempts', { token: session, headers: { 'idempotency-key': `journey-${address}` }, body: { examProfileVersionId: profile.exam.examProfileVersionId, selectionStrategy: 'breadth', count: RUN_LENGTH } }), 201);
  const attemptId = created.body.attempt.attemptId;
  await expectStatus('start', call('POST', `/v1/assessment/attempts/${attemptId}/start`, { token: session }), 200);
  const served = await call('GET', `/v1/assessment/practice-attempts/${attemptId}/package`, { token: session, bytes: true });
  check(served.status === 200, `the run's package: ${served.status}`);
  check((served.headers.get('content-type') ?? '').startsWith('application/vnd.questionbank.practice-package+json'), `the package lost its media type: ${served.headers.get('content-type')}`);
  const key = (await call('GET', '/v1/assessment/package-signing-key', { token: session })).body;
  const intact = await packageIsIntact(served, key.publicKey);
  check(intact.header === `sha256=${intact.digest}`, 'the digest header does not match the bytes received');
  check(intact.etag === `"${intact.digest}"`, `the ETag is not the digest, unweakened: ${intact.etag}`);
  check(intact.signed, 'the signature does not verify against the bytes received');
  const slots = JSON.parse(new TextDecoder().decode(served.bytes)).slots;
  check(slots.length === RUN_LENGTH, `the run has ${slots.length} questions, not ${RUN_LENGTH}`);
  return { attemptId, slotIds: slots.sort((a, b) => a.ordinal - b.ordinal).map((slot) => slot.slotId) };
});

// five right and five wrong, as a device writes them: a visit, the choice, a leave (every demonstration question's right answer is b)
let sequence = 0;
const events = run.slotIds.flatMap((slot, index) =>
  [['visit'], ['select', index % 2 === 0 ? 'b' : 'a'], ['leave']].map(([kind, answer]) => {
    sequence += 1;
    return { eventId: webcrypto.randomUUID(), attemptId: run.attemptId, slot, sequence, monotonicMs: sequence * 3000, kind, ...(answer === undefined ? {} : { answer }) };
  }),
);
await timed('send the answers', async () => expectStatus('send', call('POST', `/v1/assessment/attempts/${run.attemptId}/events`, { token: session, body: { deviceRef: 'journey', events } }), 200));
await timed('submit', async () => expectStatus('submit', call('POST', `/v1/assessment/attempts/${run.attemptId}/submission`, { token: session, headers: { 'idempotency-key': `sub-${run.attemptId}` }, body: { reason: 'manual' } }), 200));

// the server scores it and records what it showed in the background; the learner's next request waits for that, and so does this
const map = await timed('score it and record what it showed (waiting for the relay)', async () => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const read = await call('GET', '/v1/learning/concept-map', { token: session });
    if (read.status === 200 && read.body.assessedCount > 0) return read.body;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('the run was submitted and the map is still empty after ten seconds');
});
check(map.concepts.length >= 4, `the map names ${map.concepts.length} topics`);
check(map.concepts.every((topic) => topic.standing.kind === 'tentative'), 'a topic has a stated standing after two or three answers');

const weak = await timed('home names the first weakness', async () => {
  const ids = (await expectStatus('weakest', call('GET', `/v1/learning/remediation-concepts?taxonomyVersionId=${profile.exam.taxonomyVersionId}`, { token: session }), 200)).body.conceptIdentityIds;
  check(ids.length > 0, 'there is no weakest topic after the diagnostic');
  const named = await expectStatus('names', call('GET', `/v1/learning/concept-names?taxonomyVersionId=${profile.exam.taxonomyVersionId}&conceptIdentityIds=${ids[0]}`, { token: session }), 200);
  return named.body.concepts[0];
});
check(typeof weak.name === 'string' && weak.name.length > 0 && !/^[0-9a-f-]{8,}$/u.test(weak.name), `the weakest topic is not named: ${JSON.stringify(weak)}`);

const total = Math.round(steps.reduce((sum, entry) => sum + entry.ms, 0));
const lines = steps.map((entry) => `  ${entry.step.padEnd(62)} ${String(entry.ms).padStart(9)} ms`);
process.stdout.write(`FIRST WEAKNESS JOURNEY OVER HTTP (${BASE}; client time, one learner, one machine) total ${total} ms\n${lines.join('\n')}\nfirst weakness: ${weak.name}\n`);
