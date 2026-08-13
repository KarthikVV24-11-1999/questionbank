// @vitest-environment node
import { existsSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';

/**
 * M0-15, closes D3: the build itself, not a doubled-up assertion over
 * `vite.config.ts`'s source. Runs the real `vite build` (the same call
 * `corepack pnpm --filter @questionbank/studio build` makes) through Vite's
 * own JS API, so a broken build fails this spec and not just a manual check
 * nobody runs.
 */
const APP_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_DIR = join(APP_ROOT, 'dist');

describe('the production build', () => {
  it('produces an index.html, a hashed JS bundle, and no source map', async () => {
    const result = await build({
      root: APP_ROOT,
      configFile: join(APP_ROOT, 'vite.config.ts'),
      logLevel: 'silent',
    });

    // `build`'s return type is a union across watch/lib/multi-output modes;
    // the single-output object it actually returns here carries `output`.
    const output = (result as { output?: readonly unknown[] }).output;
    expect(output?.length ?? 0).toBeGreaterThan(0);
    expect(existsSync(join(DIST_DIR, 'index.html'))).toBe(true);

    const assetFiles = readdirSync(join(DIST_DIR, 'assets'));
    const jsFiles = assetFiles.filter((name) => /^index-[\w-]+\.js$/u.test(name));
    expect(jsFiles.length).toBeGreaterThan(0);

    const mapFiles = assetFiles.filter((name) => name.endsWith('.map'));
    expect(mapFiles).toEqual([]);

    // The initial-bundle measurement (§9 rule 20), written to a file so the
    // close-out reads a real number rather than quoting one from memory. No
    // per-route budget is asserted here — that gate exists only once a route
    // split does (M0-15's own acceptance).
    const bundleBytes = jsFiles.reduce(
      (total, name) => total + statSync(join(DIST_DIR, 'assets', name)).size,
      0,
    );
    mkdirSync(APP_ROOT, { recursive: true });
    writeFileSync(
      join(APP_ROOT, 'bundle-size.json'),
      JSON.stringify({ measuredAt: new Date().toISOString(), initialBundleBytes: bundleBytes }, null, 2),
    );
    expect(bundleBytes).toBeGreaterThan(0);
  }, 30_000);
});
