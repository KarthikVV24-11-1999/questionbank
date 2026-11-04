import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LIMITS, exposition, main, probe } from './probe.mjs';

/** A learner app and API that answer as the real ones do, and can be told to fail or be slow at a path. */
function fake() {
  const state = { fail: new Map(), slow: new Map(), seen: [], signedIn: false, page: '<html><div id="root"></div></html>', sessionLies: false };
  const server = createServer(async (req, res) => {
    state.seen.push(`${req.method} ${req.url}`);
    const delay = state.slow.get(req.url);
    if (delay !== undefined) await new Promise((resolve) => setTimeout(resolve, delay));
    const failure = state.fail.get(req.url);
    if (failure !== undefined) return res.writeHead(failure).end();
    const json = (body) => res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/') return res.writeHead(200).end(state.page);
    if (req.url === '/v1/identity/login') {
      let text = '';
      for await (const chunk of req) text += chunk;
      const { email, password } = JSON.parse(text);
      if (email !== 'probe@example.com' || password !== 'right') return res.writeHead(401).end('{}');
      state.signedIn = true;
      return json({ sessionToken: 'tok' });
    }
    if (req.headers.authorization !== 'Bearer tok') return res.writeHead(401).end('{}');
    if (req.url === '/v1/identity/session') return json({ signedIn: state.signedIn && !state.sessionLies, endedBy: null });
    if (req.url === '/v1/identity/logout') return (state.signedIn = false), json({ done: true });
    return json({});
  });
  return { state, server, async start() { await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve)); return `http://127.0.0.1:${server.address().port}`; } };
}

describe('the synthetic probe', () => {
  let app;
  let url;
  before(async () => {
    app = fake();
    url = await app.start();
  });
  after(() => app.server.close());
  const run = (over = {}) => probe({ url, email: 'probe@example.com', password: 'right', ...over });
  const reset = () => {
    app.state.fail.clear();
    app.state.slow.clear();
    app.state.seen.length = 0;
    app.state.page = '<html><div id="root"></div></html>';
    app.state.sessionLies = false;
  };

  it('passes when the page is served, the sign-in works and the reads answer, and signs out, leaving no session', async () => {
    reset();
    const result = await run();
    assert.equal(result.ok, true, JSON.stringify(result.steps));
    assert.deepEqual(result.steps.map((s) => s.name), Object.keys(LIMITS));
    assert.deepEqual(app.state.seen, ['GET /', 'POST /v1/identity/login', 'GET /v1/identity/session', 'GET /v1/learning/profile', 'GET /v1/learning/concept-map', 'GET /v1/learning/review-plan', 'POST /v1/identity/logout']);
    assert.equal(app.state.signedIn, false);
  });

  it('fails, naming the step, when a read answers an error', async () => {
    for (const [path, name] of [['/v1/learning/profile', 'profile'], ['/v1/learning/concept-map', 'concept map'], ['/v1/learning/review-plan', 'review plan']]) {
      reset();
      app.state.fail.set(path, 503);
      const result = await run();
      assert.equal(result.ok, false, name);
      assert.match(result.steps.find((s) => s.name === name).failure, /answered 503/u);
    }
  });

  it('fails when the page is not the app, or is not served, and does not try to sign in', async () => {
    reset();
    app.state.fail.set('/', 502);
    const result = await run();
    assert.equal(result.ok, false);
    assert.deepEqual(result.steps.map((s) => s.name), ['page']);
    assert.ok(!app.state.seen.includes('POST /v1/identity/login'));
  });

  it('fails when the page answers 200 and is not the app: a proxy\'s default page, a parked domain', async () => {
    reset();
    app.state.page = '<html>Welcome to nginx!</html>';
    const result = await run();
    assert.equal(result.ok, false);
    assert.match(result.steps[0].failure, /the page answered 200/u);
  });

  it('fails when the session a sign-in made is not in force', async () => {
    reset();
    app.state.sessionLies = true;
    const result = await run();
    assert.equal(result.ok, false);
    assert.match(result.steps.find((s) => s.name === 'session in force').failure, /not in force/u);
  });

  it('fails when the sign-in is refused, and reads nothing', async () => {
    reset();
    const result = await run({ password: 'wrong' });
    assert.equal(result.ok, false);
    assert.match(result.steps.at(-1).failure, /sign in answered 401/u);
    assert.ok(!app.state.seen.includes('GET /v1/learning/profile'));
  });

  it('fails a step that answers correctly and slowly, naming the limit', async () => {
    reset();
    app.state.slow.set('/v1/identity/session', LIMITS['session in force'] + 150);
    const result = await run();
    assert.equal(result.ok, false);
    assert.match(result.steps.find((s) => s.name === 'session in force').failure, /took \d+ ms, limit 1000 ms/u);
  });

  it('fails when nothing answers at all', async () => {
    const result = await probe({ url: 'http://127.0.0.1:1', email: 'a', password: 'b' });
    assert.equal(result.ok, false);
    assert.match(result.steps[0].failure, /no answer/u);
  });

  it('writes the result in the text exposition format, whole and in place, and a failure as 0', async () => {
    reset();
    const dir = mkdtempSync(join(tmpdir(), 'qb-probe-'));
    const file = join(dir, 'probe.prom');
    const lines = [];
    assert.equal(await main({ PROBE_URL: url, PROBE_EMAIL: 'probe@example.com', PROBE_PASSWORD: 'right', PROBE_TEXTFILE: file }, (l) => lines.push(l)), 0);
    const text = readFileSync(file, 'utf8');
    assert.match(text, /^qb_probe_success 1$/mu);
    assert.match(text, /^qb_probe_duration_seconds\{step="sign in"\} \d/mu);
    assert.match(text, /^qb_probe_last_run_timestamp_seconds \d{10}$/mu);
    assert.ok(!existsSync(`${file}.tmp`));
    app.state.fail.set('/v1/learning/profile', 500);
    assert.equal(await main({ PROBE_URL: url, PROBE_EMAIL: 'probe@example.com', PROBE_PASSWORD: 'right', PROBE_TEXTFILE: file }, (l) => lines.push(l)), 1);
    assert.match(readFileSync(file, 'utf8'), /^qb_probe_success 0$/mu);
    assert.ok(lines.some((l) => l.includes('FAIL') && l.includes('profile answered 500')));
    assert.equal(lines.at(-1), 'probe: FAILED');
  });

  it('is not configured without a url and credentials, and says so with exit 2, making no request', async () => {
    reset();
    for (const env of [{}, { PROBE_URL: url }, { PROBE_URL: url, PROBE_EMAIL: 'a' }, { PROBE_EMAIL: 'a', PROBE_PASSWORD: 'b' }]) {
      const lines = [];
      assert.equal(await main(env, (l) => lines.push(l)), 2);
      assert.match(lines[0], /required/u);
    }
    assert.deepEqual(app.state.seen, []);
  });

  it('exposes a failed run with only the steps that ran', () => {
    const text = exposition({ ok: false, steps: [{ name: 'page', ms: 12, failure: 'x' }] }, 1_700_000_000_000);
    assert.match(text, /^qb_probe_success 0$/mu);
    assert.match(text, /^qb_probe_duration_seconds\{step="page"\} 0\.012$/mu);
    assert.ok(!text.includes('sign in'));
    assert.match(text, /^qb_probe_last_run_timestamp_seconds 1700000000$/mu);
  });
});
