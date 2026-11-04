import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { Page, Route } from 'playwright-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conceptMap, concept, evidence, mapped, pace, plan, report, scheduled, TOPICS } from '../../../apps/learn/src/testing/learning-fixtures.js';
import { chosenProfile, emptyProfile, EXAM_CHOICES, SCOPE_OPTIONS, scopedProfile } from '../../../apps/learn/src/testing/profile-fakes.js';
import { freshChrome, newProfileDir, type RunEnvironment } from './browser-run.js';
import { StubServer } from './stub-server.js';

/**
 * Every learner screen, in each state it can show, checked by axe in a real Chrome against the built bundle (M8-49): WCAG 2.0, 2.1 and 2.2 at levels A and AA, as axe implements them.
 *
 * **What a green run is worth.** It is a gate on what a machine can see: colour contrast as the browser renders it (the part jsdom cannot do), accessible names, roles, labels, form
 * fields without labels, landmarks, duplicate ids, link purpose where it is in the text, a name for every control, target size. It is **not** a claim that the product is accessible. A
 * machine cannot tell whether the reading order makes sense, whether an error is announced when it happens (a `role="alert"` is checked for existing, not for being heard), whether a
 * focus move after a navigation lands somewhere useful, whether the diagnostic can be sat with a screen reader from the first question to the last, or whether the words are plain. axe's own
 * documentation puts what it finds at about a third of the problems a person would. The manual half is an obligation that stays open (D127 in docs/DEBT.md), and M9 wants a third-party audit.
 *
 * **How the states are made.** The built bundle is served by the stub server, and the calls to `/v1/` are answered by the test with a fixture (the same ones the screens' own specs use), a
 * refusal, or no answer at all: *loaded*, *empty* (the server answers with nothing in it), *failed* (503) and *loading* (the request is held). A screen that has no state of one of the kinds
 * is not listed under it. The paper being sat is the exception, and is run against the stub server's own attempt.
 */
const require = createRequire(import.meta.url);
const AXE = require.resolve('axe-core/axe.min.js');
const environment: RunEnvironment = { distDir: resolve(import.meta.dirname, '../../../apps/learn/dist'), chrome: { current: null, profileDir: newProfileDir() } };
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

interface Reply {
  readonly status: number;
  readonly body?: unknown;
}
type Answer = 'hang' | Reply;
const ok = (body: unknown): Reply => ({ status: 200, body });
const problem = (status: number, code: string, detail: string): Reply => ({ status, body: { type: 'about:blank', title: detail, status, detail, code, retryable: status >= 500, correlationId: 'c' } });
const unavailable = problem(503, 'Unavailable', 'The service is unavailable. Try again shortly.');
const SIGNED_IN = ok({ signedIn: true, endedBy: null });
const SIGNED_OUT = ok({ signedIn: false, endedBy: null });

interface Screen {
  readonly screen: string;
  readonly state: 'loading' | 'loaded' | 'empty' | 'failed';
  /** What the screen is asked of the server, by path; anything not named is a 404. */
  readonly answers: Readonly<Record<string, Answer>>;
  readonly path: string;
  /** What shows the state has been reached: waited for before axe looks. */
  readonly ready: (page: Page) => Promise<unknown>;
  /** What a person does to bring the screen to the state, if it is not there on arrival. */
  readonly act?: (page: Page) => Promise<void>;
}

const text = (value: string | RegExp) => (page: Page) => page.getByText(value).first().waitFor();
const heading = (name: string | RegExp) => (page: Page) => page.getByRole('heading', { name }).first().waitFor();
const alert = (page: Page) => page.getByRole('alert').first().waitFor();
const LOGIN = '/v1/identity/login';
const WEAK = { kind: 'asserted', state: 'weak', confidence: 0.6 } as const;
const MAP = conceptMap([mapped(1, WEAK), mapped(2, { kind: 'tentative', leaning: 'weak' }, { evidenceCount: 3 }), mapped(3, { kind: 'asserted', state: 'strong', confidence: 0.8 })]);
const HOME_BASE = { '/v1/identity/session': SIGNED_IN, '/v1/learning/review-plan': ok(plan()), '/v1/learning/profile': ok(scopedProfile()) };
const ONBOARD = (next: 'exam' | 'class' | 'coverage' | null) =>
  next === 'exam' ? emptyProfile() : next === 'class' ? { ...chosenProfile(), currentClass: null, onboarding: { steps: [], next, skipped: false } } : next === 'coverage' ? { ...chosenProfile(), onboarding: { steps: [], next, skipped: false } } : scopedProfile();

const SCREENS: readonly Screen[] = [
  // the gate and the way in
  { screen: 'opening', state: 'loading', path: '/', answers: { '/v1/identity/session': 'hang' }, ready: text('Opening…') },
  { screen: 'sign in', state: 'loaded', path: '/', answers: { '/v1/identity/session': SIGNED_OUT }, ready: heading('Sign in') },
  { screen: 'sign in, password changed', state: 'loaded', path: '/?auth=signin&changed=1', answers: { '/v1/identity/session': SIGNED_OUT }, ready: text(/Your password is changed/u) },
  { screen: 'sign in, ended by another sign-in', state: 'loaded', path: '/', answers: { '/v1/identity/session': ok({ signedIn: false, endedBy: 'another_sign_in' }) }, ready: text(/signed in on another device/u) },
  {
    screen: 'sign in',
    state: 'failed',
    path: '/',
    answers: { '/v1/identity/session': SIGNED_OUT, [LOGIN]: problem(401, 'Authentication', 'The email or password is not right.') },
    ready: alert,
    act: async (page) => {
      await page.getByLabel('Email address').fill('asha@example.com');
      await page.getByLabel('Password').fill('not the password');
      await page.getByRole('button', { name: 'Sign in' }).click();
    },
  },
  { screen: 'create an account', state: 'loaded', path: '/?auth=register', answers: { '/v1/identity/session': SIGNED_OUT }, ready: heading('Create an account') },
  {
    screen: 'create an account',
    state: 'failed',
    path: '/?auth=register',
    answers: { '/v1/identity/session': SIGNED_OUT, '/v1/identity/register': problem(400, 'Validation', 'That password is not acceptable: use at least 12 characters.') },
    ready: alert,
    act: async (page) => {
      await page.getByLabel('Email address').fill('asha@example.com');
      await page.getByLabel('Choose a password').fill('twelve chars!!');
      await page.getByRole('button', { name: 'Create account' }).click();
    },
  },
  { screen: 'check your mail', state: 'loaded', path: '/?auth=sent', answers: {}, ready: heading('Check your mail') },
  { screen: 'check your mail, sent again', state: 'loaded', path: '/?auth=sent&again=1', answers: {}, ready: text('We have sent it again.') },
  {
    screen: 'check your mail',
    state: 'failed',
    path: '/?auth=sent',
    answers: { '/v1/identity/email/verification': problem(503, 'Unavailable', 'The message could not be sent just now. Try again shortly.') },
    ready: alert,
    act: (page) => page.getByRole('button', { name: 'Send it again' }).click(),
  },
  { screen: 'recover your password', state: 'loaded', path: '/?auth=recover', answers: { '/v1/identity/session': SIGNED_OUT }, ready: heading('Forgotten your password?') },
  { screen: 'recover your password, asked', state: 'loaded', path: '/?auth=recover&asked=1', answers: { '/v1/identity/session': SIGNED_OUT }, ready: text(/a message is on its way/u) },
  {
    screen: 'recover your password',
    state: 'failed',
    path: '/?auth=recover',
    answers: { '/v1/identity/session': SIGNED_OUT, '/v1/identity/password/recovery': problem(429, 'RateLimited', 'Too many requests. Try again later.') },
    ready: alert,
    act: async (page) => {
      await page.getByLabel('Email address').fill('asha@example.com');
      await page.getByRole('button', { name: 'Send the link' }).click();
    },
  },
  { screen: 'confirm an address', state: 'loading', path: '/#verify=abcdefgh12345678', answers: { '/v1/identity/email/verify': 'hang' }, ready: text('Confirming your address…') },
  { screen: 'confirm an address', state: 'loaded', path: '/#verify=abcdefgh12345678', answers: { '/v1/identity/email/verify': ok({ verified: true }) }, ready: heading('Your address is confirmed') },
  { screen: 'confirm an address', state: 'failed', path: '/#verify=abcdefgh12345678', answers: { '/v1/identity/email/verify': problem(400, 'Validation', 'That link is not valid any longer.') }, ready: heading('That link did not work') },
  { screen: 'choose a new password', state: 'loaded', path: '/#reset=abcdefgh12345678', answers: {}, ready: heading('Choose a new password') },
  {
    screen: 'choose a new password',
    state: 'failed',
    path: '/#reset=abcdefgh12345678',
    answers: { '/v1/identity/password/reset': problem(400, 'Validation', 'That link is not valid any longer.') },
    ready: alert,
    act: async (page) => {
      await page.getByLabel('New password', { exact: true }).fill('a long and ordinary passphrase');
      await page.getByRole('button', { name: 'Save the new password' }).click();
    },
  },
  // home
  { screen: 'what to do next', state: 'loading', path: '/', answers: { ...HOME_BASE, '/v1/learning/review-plan': 'hang' }, ready: text(/./u) },
  { screen: 'what to do next, invitation to say who you are', state: 'empty', path: '/', answers: { ...HOME_BASE, '/v1/learning/profile': ok(emptyProfile()) }, ready: heading('What to do next') },
  { screen: 'what to do next, the diagnostic', state: 'loaded', path: '/', answers: { ...HOME_BASE, '/v1/learning/remediation-concepts': ok({ conceptIdentityIds: [] }), '/v1/learning/concept-map': ok(conceptMap([], { assessedCount: 0 })) }, ready: heading('See where you stand') },
  { screen: 'what to do next, a topic to practise', state: 'loaded', path: '/', answers: { ...HOME_BASE, '/v1/learning/review-plan': ok(plan({ due: [scheduled(1)] })), '/v1/learning/concept-names': ok({ concepts: [TOPICS[0]] }) }, ready: heading('Kinematics') },
  { screen: 'what to do next', state: 'failed', path: '/', answers: { ...HOME_BASE, '/v1/learning/review-plan': unavailable }, ready: alert },
  // onboarding
  { screen: 'about you', state: 'loading', path: '/?onboarding=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/profile': 'hang' }, ready: text('One moment…') },
  { screen: 'about you, exam', state: 'loaded', path: '/?onboarding=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/profile': ok(ONBOARD('exam')), '/v1/learning/profile/exam-choices': ok(EXAM_CHOICES) }, ready: (page) => page.getByRole('form', { name: 'Your exam' }).waitFor() },
  { screen: 'about you, exam', state: 'empty', path: '/?onboarding=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/profile': ok(ONBOARD('exam')), '/v1/learning/profile/exam-choices': ok({ exams: [] }) }, ready: text(/list of exams cannot be loaded/u) },
  { screen: 'about you, class', state: 'loaded', path: '/?onboarding=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/profile': ok(ONBOARD('class')) }, ready: (page) => page.getByRole('form', { name: 'Your class' }).waitFor() },
  { screen: 'about you, chapters', state: 'loaded', path: '/?onboarding=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/profile': ok(ONBOARD('coverage')), '/v1/learning/profile/scope-options': ok(SCOPE_OPTIONS) }, ready: (page) => page.getByRole('form', { name: 'What you have studied' }).waitFor() },
  { screen: 'about you, all set', state: 'loaded', path: '/?onboarding=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/profile': ok(ONBOARD(null)) }, ready: (page) => page.getByRole('region', { name: 'All set' }).waitFor() },
  { screen: 'about you', state: 'failed', path: '/?onboarding=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/profile': unavailable }, ready: text(/appear to be offline/u) },
  // where you stand
  { screen: 'where you stand', state: 'loading', path: '/?map=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/concept-map': 'hang' }, ready: heading('Where you stand') },
  { screen: 'where you stand', state: 'loaded', path: '/?map=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/concept-map': ok(MAP) }, ready: text('Kinematics') },
  { screen: 'where you stand', state: 'empty', path: '/?map=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/concept-map': ok(conceptMap([], { assessedCount: 0 })) }, ready: heading('Where you stand') },
  { screen: 'where you stand', state: 'failed', path: '/?map=1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/concept-map': unavailable }, ready: alert },
  // one topic
  { screen: 'your answers on a topic', state: 'loading', path: `/?topic=${concept(1)}`, answers: { '/v1/identity/session': SIGNED_IN, [`/v1/learning/concept-map/${concept(1)}/evidence`]: 'hang' }, ready: heading('Your answers') },
  { screen: 'your answers on a topic', state: 'loaded', path: `/?topic=${concept(1)}`, answers: { '/v1/identity/session': SIGNED_IN, [`/v1/learning/concept-map/${concept(1)}/evidence`]: ok(evidence(1, 3)) }, ready: heading('Kinematics') },
  { screen: 'your answers on a topic', state: 'empty', path: `/?topic=${concept(1)}`, answers: { '/v1/identity/session': SIGNED_IN, [`/v1/learning/concept-map/${concept(1)}/evidence`]: ok(evidence(1, 0)) }, ready: heading('Kinematics') },
  { screen: 'your answers on a topic', state: 'failed', path: `/?topic=${concept(1)}`, answers: { '/v1/identity/session': SIGNED_IN, [`/v1/learning/concept-map/${concept(1)}/evidence`]: unavailable }, ready: alert },
  // a report
  { screen: 'a report', state: 'loading', path: '/?report=att-1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/attempts/att-1/report': 'hang', '/v1/learning/attempts/att-1/pace': 'hang' }, ready: text(/./u) },
  { screen: 'a report', state: 'loaded', path: '/?report=att-1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/attempts/att-1/report': ok(report()), '/v1/learning/attempts/att-1/pace': ok(pace()), '/v1/learning/concept-names': ok({ concepts: TOPICS.slice(0, 2) }), '/v1/learning/profile': ok(scopedProfile()), '/v1/assessment/attempts/att-1': 'hang' }, ready: text('Kinematics') },
  { screen: 'a report', state: 'failed', path: '/?report=att-1', answers: { '/v1/identity/session': SIGNED_IN, '/v1/learning/attempts/att-1/report': unavailable, '/v1/learning/attempts/att-1/pace': unavailable }, ready: alert },
];

let server: StubServer;
beforeAll(async () => {
  await freshChrome(environment);
  server = new StubServer({ distDir: environment.distDir, durationMs: 3_600_000, intervalCapMs: 120_000 });
  await server.start();
});
afterAll(async () => {
  await server.stop();
  await environment.chrome.current?.close();
});

async function answer(route: Route, answers: Readonly<Record<string, Answer>>): Promise<void> {
  const url = new URL(route.request().url());
  const given = answers[url.pathname];
  if (url.pathname === '/v1/analytics/events' || route.request().method() === 'OPTIONS') return route.fulfill({ status: 202, body: '' });
  if (given === 'hang') return; // never answered: the screen stays in its loading state
  const reply: Reply = given ?? problem(404, 'NotFound', 'There is no such thing.');
  return route.fulfill({ status: reply.status, contentType: reply.status >= 400 ? 'application/problem+json' : 'application/json', body: JSON.stringify(reply.body ?? {}) });
}

async function violations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: AXE });
  const result = await page.evaluate(async (tags) => {
    const axe = (window as unknown as { axe: { run(context: Document, options: object): Promise<{ violations: Array<{ id: string; help: string; nodes: Array<{ target: unknown[]; failureSummary?: string }> }>; passes: unknown[] }> } }).axe;
    const found = await axe.run(document, { runOnly: { type: 'tag', values: tags } });
    return { violations: found.violations.map((v) => ({ id: v.id, help: v.help, nodes: v.nodes.map((n) => `${n.target.join(' ')}: ${(n.failureSummary ?? '').split('\n').slice(0, 2).join(' ')}`) })), passes: found.passes.length };
  }, TAGS);
  expect(result.passes, 'axe ran no rules at all').toBeGreaterThan(5);
  return result.violations.map((v) => `${v.id} (${v.help}): ${v.nodes.join(' | ')}`);
}

describe('every learner screen, in each state it can show, against WCAG 2.2 AA as far as axe can tell (M8-49)', () => {
  it('lists the screens and states it covers, so that a screen taken out of the list is seen in a diff', () => {
    const covered = new Set(SCREENS.map((s) => `${s.screen} / ${s.state}`));
    expect(covered.size).toBe(SCREENS.length);
    for (const state of ['loading', 'loaded', 'empty', 'failed'] as const) expect(SCREENS.some((s) => s.state === state), state).toBe(true);
    expect([...new Set(SCREENS.map((s) => s.screen.split(',')[0]))].sort()).toEqual(['a report', 'about you', 'check your mail', 'choose a new password', 'confirm an address', 'create an account', 'opening', 'recover your password', 'sign in', 'what to do next', 'where you stand', 'your answers on a topic'].sort());
  });

  for (const screen of SCREENS) {
    it(`${screen.screen}, ${screen.state}: no violation`, async () => {
      const page = await environment.chrome.current!.context.newPage();
      try {
        await page.route(`${server.origin}/v1/**`, (route) => answer(route, screen.answers));
        await page.goto(`${server.origin}${screen.path}`);
        if (screen.act !== undefined) await screen.act(page);
        await screen.ready(page);
        expect(await violations(page)).toEqual([]);
      } finally {
        await page.close();
      }
    });
  }

  it('the paper being sat: a question, answered and not', async () => {
    const page = await environment.chrome.current!.context.newPage();
    try {
      await page.route(`${server.origin}/v1/identity/session`, (route) => answer(route, { '/v1/identity/session': SIGNED_IN }));
      await page.goto(`${server.origin}/?form=00000000-0000-4000-8000-0000000000f1&session=2026-01-27/shift-1`);
      await page.getByRole('region', { name: 'Question 1' }).waitFor();
      expect(await violations(page), 'a question not yet answered').toEqual([]);
      await page.getByRole('radio').first().check();
      await page.getByRole('button', { name: 'Submit paper' }).click();
      await page.getByRole('alertdialog', { name: 'Confirm submission' }).waitFor();
      expect(await violations(page), 'the confirmation to submit').toEqual([]);
    } finally {
      await page.close();
    }
  });

  it('the paper being sat, when the server is failing', async () => {
    const down = new StubServer({ distDir: environment.distDir, durationMs: 3_600_000, intervalCapMs: 120_000 });
    await down.start();
    down.outage = '503';
    const page = await environment.chrome.current!.context.newPage();
    try {
      await page.route(`${down.origin}/v1/identity/session`, (route) => answer(route, { '/v1/identity/session': SIGNED_IN }));
      await page.goto(`${down.origin}/?form=00000000-0000-4000-8000-0000000000f1&session=2026-01-27/shift-1`);
      await page.getByRole('alert').or(page.getByRole('status')).first().waitFor();
      expect(await violations(page)).toEqual([]);
    } finally {
      await page.close();
      await down.stop();
    }
  });
});
