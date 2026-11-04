import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from 'playwright-core';
import { afterAll, describe, expect, it } from 'vitest';
import { launchChrome, type RunningChrome } from './chrome.js';
import { PROFILE_PREFIX } from './profiles.js';

/**
 * A stranger, in a real Chrome, against the booted stack (M8-44): creates an account, reads the link from the message the stack wrote, confirms the address, continues from the
 * confirmation to the questions about the exam, says which exam and which chapters, signs out and in again, sits the diagnostic, submits it, and is told the first topic to work on.
 * Every step is the page's own control; the only thing read from outside the page is the message, from the directory the stack writes mail to (a stack without the SES settings writes files;
 * one with them sends through SES, which this does not exercise).
 *
 * It is the journey `tools/stack-journey/journey.mjs` runs over HTTP, run through the learner app, so what it adds is the app: the sign-in, the cookie, the echo header, the screens, the
 * onboarding and the practice screen on the built bundle behind the proxy. It is one learner on one machine with nobody reading anything: a floor on the machine's share of the ten
 * minutes, and not the criterion. Waits are for conditions, not durations; the only clock is the timeout that fails a condition that never comes true.
 *
 *   STACK_URL             where the learner app is served (default http://localhost:8080); the link in the message must be on the same origin
 *   MAIL_DIR              the directory the stack writes its mail to (required)
 *   STACK_BROWSER_REPORT  a file to write the steps and their times to, as JSON (optional)
 *   EXAM_CODE, YEAR       the exam to choose (default JEE_MAIN, 2026)
 */
const BASE = (process.env['STACK_URL'] ?? 'http://localhost:8080').replace(/\/$/u, '');
const MAIL_DIR = process.env['MAIL_DIR'];
const REPORT = process.env['STACK_BROWSER_REPORT'];
const EXAM = `${process.env['EXAM_CODE'] ?? 'JEE_MAIN'}|${process.env['YEAR'] ?? '2026'}`;
const PASSWORD = 'a long and ordinary passphrase';
const RUN_LENGTH = 10;
const WAIT = 20_000;

interface Step {
  readonly step: string;
  readonly ms: number;
}

async function messageFor(address: string): Promise<string> {
  if (MAIL_DIR === undefined) throw new Error('MAIL_DIR is not set, so the message cannot be read');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const names = (await readdir(MAIL_DIR).catch(() => [])).filter((name) => name.endsWith('-email_verification.txt')).sort().reverse();
    for (const name of names) {
      const contents = await readFile(join(MAIL_DIR, name), 'utf8');
      if (contents.startsWith(`To: ${address}\n`)) return contents;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`no verification message for ${address} appeared in ${MAIL_DIR}`);
}

async function describePage(page: Page): Promise<string> {
  const text = await page.evaluate(() => document.body.innerText).catch(() => '(the page could not be read)');
  return `at ${page.url()}\n${text.slice(0, 1_500)}`;
}

describe('a stranger reaches a first named recommendation in a real browser', () => {
  let chrome: RunningChrome | undefined;
  let profile: string | undefined;
  afterAll(async () => {
    await chrome?.close().catch(() => undefined);
    if (profile !== undefined) await rm(profile, { recursive: true, force: true });
  });

  it('registers, confirms the address from the message, goes on to onboarding, signs out and in, sits the diagnostic and reads the topic to work on first', async () => {
    profile = await mkdtemp(join(tmpdir(), PROFILE_PREFIX));
    chrome = await launchChrome(profile);
    const page = await chrome.context.newPage();
    const problems: string[] = [];
    page.on('console', (message) => message.type() === 'error' && problems.push(message.text()));
    page.on('pageerror', (error) => problems.push(String(error)));

    const address = `stranger-${Date.now().toString(36)}@example.com`;
    const steps: Step[] = [];
    const timed = async <T>(step: string, run: () => Promise<T>): Promise<T> => {
      const began = performance.now();
      try {
        const value = await run();
        steps.push({ step, ms: Math.round((performance.now() - began) * 10) / 10 });
        return value;
      } catch (error) {
        throw new Error(`${step}: ${error instanceof Error ? error.message : String(error)}\n${await describePage(page)}\nconsole errors: ${problems.slice(-5).join(' | ')}`);
      }
    };
    const heading = (name: string | RegExp) => page.getByRole('heading', { name }).waitFor({ timeout: WAIT });

    await timed('open the app and be shown where to sign in', async () => {
      await page.goto(`${BASE}/`);
      await heading('Sign in');
    });
    await timed('go to creating an account', async () => {
      await page.getByRole('link', { name: 'Create an account' }).click();
      await heading('Create an account');
    });
    await timed('create the account', async () => {
      await page.getByLabel('Email address').fill(address);
      await page.getByLabel('Choose a password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Create account' }).click();
      await heading('Check your mail');
    });
    const message = await timed('read the link from the message', () => messageFor(address));
    const link = /Or open (\S+)/u.exec(message)?.[1];
    expect(link, `the message has no link:\n${message}`).toBeDefined();
    expect(new URL(link as string).origin, 'the link is not on the address the app is served from').toBe(new URL(BASE).origin);
    await timed('open the link and have the address confirmed', async () => {
      await page.goto(link as string);
      await heading('Your address is confirmed');
    });
    await timed('continue from the confirmation to the questions about the exam, not to an empty home', async () => {
      await page.getByRole('link', { name: 'Continue' }).click();
      await heading('About you');
      await page.getByRole('form', { name: 'Your exam' }).waitFor({ timeout: WAIT });
    });
    await timed('say which exam', async () => {
      await page.getByRole('combobox').selectOption(EXAM);
      await page.getByRole('button', { name: 'Continue' }).click();
    });
    await timed('say which class', async () => {
      await page.getByRole('form', { name: 'Your class' }).waitFor({ timeout: WAIT });
      await page.getByRole('radio', { name: 'Class 12' }).check();
      await page.getByRole('button', { name: 'Continue' }).click();
    });
    await timed('say which chapters are studied', async () => {
      await page.getByRole('form', { name: 'What you have studied' }).waitFor({ timeout: WAIT });
      await page.getByRole('checkbox', { name: 'Physics', exact: true }).check();
      await page.getByRole('button', { name: 'Continue' }).click();
      await page.getByRole('region', { name: 'All set' }).waitFor({ timeout: WAIT });
    });
    await timed('sign out', async () => {
      await page.goto(`${BASE}/`);
      await page.getByRole('button', { name: 'Sign out' }).click();
      await heading('Sign in');
    });
    await timed('sign in', async () => {
      await page.getByLabel('Email address').fill(address);
      await page.getByLabel('Password').fill(PASSWORD);
      await page.getByRole('button', { name: 'Sign in' }).click();
      await heading('What to do next');
    });

    // the session is a cookie script cannot read, and nothing about it is in the page's own storage (ADR-0065)
    const visible = await page.evaluate(() => ({ cookies: document.cookie, keys: Object.keys(window.localStorage), values: Object.values(window.localStorage).join(' ') }));
    expect(visible.cookies, 'the session cookie is readable by script').not.toContain('qb_session');
    expect(visible.cookies, 'the second cookie is not there to be echoed').toContain('qb_csrf=');
    expect(visible.keys, 'a token is kept in localStorage').not.toContain('qb-dev-token');
    expect(visible.values, 'a cookie value is kept in localStorage').not.toContain('qb_session');

    await timed('start the diagnostic', async () => {
      await page.goto(`${BASE}/`);
      await heading('See where you stand');
      await page.getByRole('button', { name: 'Start', exact: true }).click();
      await page.getByRole('region', { name: /^Question \d/u }).waitFor({ timeout: WAIT });
    });
    await timed('answer the questions', async () => {
      for (let question = 1; question <= RUN_LENGTH; question += 1) {
        if (question > 1) {
          await page.getByRole('button', { name: new RegExp(`^Question ${question}(,|$)`, 'u') }).click();
          await page.getByRole('region', { name: `Question ${question}` }).waitFor({ timeout: WAIT });
        }
        await page.getByRole('radio').first().check();
      }
    });
    await timed('finish the run', async () => {
      await page.getByRole('button', { name: 'Finish run' }).click();
      await page.getByRole('button', { name: 'Yes, submit' }).click();
      await page.getByRole('link', { name: 'Back to what to do next' }).waitFor({ timeout: WAIT });
    });
    await timed('wait for the run to be scored and recorded', async () => {
      // scored in the background, as in the HTTP journey, so the map is asked (from the page, with the session it holds) until it holds an answer; home is not reloaded to find out, since
      // each load is several reads of the profile and the limit on those is a person's, not a poll's
      for (let attempt = 0; attempt < 150; attempt += 1) {
        const assessed = await page.evaluate(async () => (await (await fetch('/v1/learning/concept-map', { credentials: 'include' })).json()).assessedCount as number | undefined);
        if (typeof assessed === 'number' && assessed > 0) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error('the run was submitted and the map is still empty after fifteen seconds');
    });
    const topic = await timed('read the first topic to work on', async () => {
      await page.goto(`${BASE}/`);
      await page.getByText('This is the topic you are weakest on').waitFor({ timeout: WAIT });
      return (await page.getByRole('heading', { level: 2 }).first().innerText()).trim();
    });
    expect(topic.length, 'the topic has no name').toBeGreaterThan(0);
    expect(topic, 'the topic is named by an identifier').not.toMatch(/^[0-9a-f-]{8,}$/u);

    const total = Math.round(steps.reduce((sum, entry) => sum + entry.ms, 0));
    const lines = steps.map((entry) => `  ${entry.step.padEnd(58)} ${String(entry.ms).padStart(9)} ms`);
    const text = `FIRST RECOMMENDATION IN A REAL BROWSER (${BASE}; headless Chrome, one learner, one machine) total ${total} ms\n${lines.join('\n')}\nfirst topic to work on: ${topic}\n`;
    process.stdout.write(text);
    if (REPORT !== undefined) await writeFile(REPORT, JSON.stringify({ totalMs: total, steps, topic, text }, null, 2));
    expect(problems.filter((problem) => !/Failed to load resource/u.test(problem)), 'the page logged errors').toEqual([]);
  });
});
