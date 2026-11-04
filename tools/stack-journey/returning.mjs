// A learner who was here before (M8-50): `STACK_URL=… JOURNEY_LEARNER_FILE=… node tools/stack-journey/returning.mjs`.
//
// The first journey writes who it made (journey.mjs, JOURNEY_LEARNER_FILE). After a restore this signs that learner in with their own password and checks what only their own history
// can show: the exam they chose is still chosen, the chapters they declared are still declared, and the map holds the answers they gave and names a weakest topic. A database restored
// without a table, or with the right tables and no rows, fails here even if the counts elsewhere happened to match.
import { readFileSync } from 'node:fs';

const BASE = (process.env.STACK_URL ?? 'http://localhost:8080').replace(/\/$/u, '');
const file = process.env.JOURNEY_LEARNER_FILE;
if (file === undefined) throw new Error('JOURNEY_LEARNER_FILE is not set, so there is no learner to return');
const { address, password } = JSON.parse(readFileSync(file, 'utf8'));

async function call(method, path, { token, body } = {}) {
  const response = await fetch(`${BASE}${path}`, { method, headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await response.text();
  return { status: response.status, body: text === '' ? undefined : JSON.parse(text) };
}
function check(condition, message) {
  if (!condition) throw new Error(`check failed: ${message}`);
}

const login = await call('POST', '/v1/identity/login', { body: { email: address, password } });
check(login.status === 200, `the learner from before could not sign in (${login.status})`);
const token = login.body.sessionToken;
const profile = (await call('GET', '/v1/learning/profile', { token })).body;
check(profile?.exam?.examCode !== undefined && profile.exam !== null, 'the exam they chose is gone');
check(profile.scope !== null, 'the chapters they declared are gone');
const map = (await call('GET', '/v1/learning/concept-map', { token })).body;
check(map?.assessedCount > 0, `the map holds no answers (${map?.assessedCount})`);
const weakest = (await call('GET', `/v1/learning/remediation-concepts?taxonomyVersionId=${profile.exam.taxonomyVersionId}`, { token })).body;
check(weakest?.conceptIdentityIds?.length > 0, 'there is no weakest topic');
process.stdout.write(`${address} signed in after the restore: exam ${profile.exam.examCode}, ${map.assessedCount} topics assessed, a weakest topic named\n`);
