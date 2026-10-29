import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Page } from 'playwright-core';

/**
 * What a run keeps when a condition it waited for never came true (D80): the page's console, every request it made and what became of it, a
 * screenshot, and a short statement of what the page was showing. A runner that fails is gone once the job ends; this is what a developer has
 * to read afterwards, and the workflow uploads the directory.
 *
 * The recorder is attached when the page is opened, because a log cannot be collected after the fact: by the time a wait times out the
 * requests it would explain are over.
 */
export interface Recorder {
  readonly console: string[];
  readonly network: string[];
}

export interface EvidenceOptions {
  /** Where failures are written, one directory per seed. */
  readonly dir: string;
}

export const defaultEvidenceDir = (): string => process.env['QB_ADVERSARIAL_EVIDENCE_DIR'] ?? resolve(import.meta.dirname, '../failures');

export function recordPage(page: Page): Recorder {
  const started = Date.now();
  const at = () => `+${String(Date.now() - started).padStart(6, ' ')}ms`;
  const recorder: Recorder = { console: [], network: [] };
  page.on('console', (message) => recorder.console.push(`${at()} ${message.type()} ${message.text()} (${message.location().url}:${message.location().lineNumber})`));
  page.on('pageerror', (error) => recorder.console.push(`${at()} pageerror ${error.stack ?? error.message}`));
  page.on('crash', () => recorder.console.push(`${at()} the page crashed`));
  page.on('request', (request) => recorder.network.push(`${at()} -> ${request.method()} ${request.url()}${request.serviceWorker() === null ? '' : ' (from a service worker)'}`));
  page.on('response', (response) => {
    const worker = response.fromServiceWorker() ? ' (answered by the service worker)' : '';
    recorder.network.push(`${at()} <- ${response.status()} ${response.request().method()} ${response.url()}${worker}`);
  });
  page.on('requestfailed', (request) => recorder.network.push(`${at()} xx ${request.method()} ${request.url()} ${request.failure()?.errorText ?? 'failed'}`));
  return recorder;
}

/** A page that has crashed or closed does not answer; a capture that waited for it would hang the run it is trying to explain. */
const within = <T>(ms: number, work: Promise<T>, fallback: T): Promise<T> => Promise.race([work.catch(() => fallback), new Promise<T>((resolveFallback) => setTimeout(() => resolveFallback(fallback), ms))]);

export interface EvidenceInput {
  readonly seed: number;
  readonly page: Page;
  readonly recorder: Recorder;
  readonly error: unknown;
  /** What the server was asked, and whether it was being made to fail. */
  readonly server: { readonly requests: ReadonlyArray<{ readonly method: string; readonly path: string }>; readonly outage: string };
  readonly dir: string;
}

/** Writes `console.log`, `network.log`, `screenshot.png` and `summary.json` under `<dir>/seed-<n>/`, and returns that directory. */
export async function writeEvidence(input: EvidenceInput): Promise<string> {
  const target = resolve(input.dir, `seed-${input.seed}`);
  mkdirSync(target, { recursive: true });
  writeFileSync(resolve(target, 'console.log'), `${input.recorder.console.join('\n')}\n`);
  writeFileSync(resolve(target, 'network.log'), `${input.recorder.network.join('\n')}\n`);
  const screenshot = await within(10_000, input.page.screenshot({ path: resolve(target, 'screenshot.png'), timeout: 10_000 }).then(() => true), false);
  const shown = await within(
    5_000,
    input.page.evaluate(() => ({
      url: window.location.href,
      readyState: document.readyState,
      controlledByServiceWorker: navigator.serviceWorker?.controller != null,
      storedKeys: Object.keys(window.localStorage).filter((key) => key.startsWith('qb.')),
      text: (document.body?.innerText ?? '').slice(0, 2_000),
    })),
    null,
  );
  writeFileSync(
    resolve(target, 'summary.json'),
    `${JSON.stringify(
      {
        seed: input.seed,
        error: input.error instanceof Error ? input.error.message : String(input.error),
        serverOutage: input.server.outage,
        serverRequests: input.server.requests.map((request) => `${request.method} ${request.path}`),
        screenshot: screenshot ? 'screenshot.png' : 'unavailable: the page did not answer',
        page: shown ?? 'unavailable: the page did not answer',
      },
      null,
      2,
    )}\n`,
  );
  return target;
}
