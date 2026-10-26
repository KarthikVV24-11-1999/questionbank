import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContext } from 'playwright-core';

/**
 * A real Chrome that the test owns the process of — started here, not by the automation library — so that "the browser was killed"
 * is a signal sent to the browser's own process, and the profile on disk is the only thing the next launch has.
 */
export interface RunningChrome {
  readonly process: ChildProcess;
  readonly browser: Browser;
  readonly context: BrowserContext;
  /** SIGKILL: no unload, no flush, no goodbye. Resolves once the process is gone. */
  kill(): Promise<void>;
  /** A normal shutdown of the browser: it is asked to close and does. */
  close(): Promise<void>;
}

const CANDIDATES = [
  process.env['CHROME_PATH'],
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/usr/bin/google-chrome',
  '/usr/bin/google-chrome-stable',
  '/usr/bin/chromium',
].filter((path): path is string => path !== undefined && path.length > 0);

export function chromePath(): string {
  const found = CANDIDATES.find((path) => existsSync(path));
  if (found === undefined) throw new Error(`no Chrome found; looked in ${CANDIDATES.join(', ')} (set CHROME_PATH). The adversarial suite needs a real browser and does not skip without one.`);
  return found;
}

async function devtoolsUrl(profileDir: string): Promise<string> {
  const file = join(profileDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 200; attempt += 1) {
    try {
      const [port] = (await readFile(file, 'utf8')).split('\n');
      if (port !== undefined && port.length > 0) return `http://127.0.0.1:${port}`;
    } catch {
      // not written yet: Chrome is still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('Chrome did not publish its devtools port');
}

export async function launchChrome(profileDir: string): Promise<RunningChrome> {
  // A previous Chrome killed with SIGKILL leaves this behind, and the next launch must not read the old port.
  await rm(join(profileDir, 'DevToolsActivePort'), { force: true });
  const child = spawn(
    chromePath(),
    [
      '--headless=new',
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-background-networking',
      '--disable-sync',
      // On a CI runner the browser's own sandbox may be unavailable to an unprivileged user; the pages here are this repository's own, on localhost.
      ...(process.env['CI'] === undefined ? [] : ['--no-sandbox']),
      'about:blank',
    ],
    { stdio: 'ignore' },
  );
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  const browser = await chromium.connectOverCDP(await devtoolsUrl(profileDir));
  const context = browser.contexts()[0];
  if (context === undefined) throw new Error('Chrome has no default context');
  return {
    process: child,
    browser,
    context,
    kill: async () => {
      child.kill('SIGKILL');
      await exited;
    },
    close: async () => {
      // Browser.close is Chrome's own orderly shutdown: windows closed, storage committed, then the process exits.
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.close').catch(() => undefined);
      await exited;
    },
  };
}
