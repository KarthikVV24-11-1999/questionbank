import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { INTERVAL_CAP_LITERAL_ALLOWED, checkNoIntervalCapLiteral } from './interval-cap-rules.js';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../platform/config/config.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = resolve(API_ROOT, '../..');

describe('M6-37 — the interval cap has one source', () => {
  it('finds no literal cap anywhere in the shipped source, specs included', () => {
    expect(checkNoIntervalCapLiteral(WORKSPACE, ['apps/api/src', 'packages'])).toEqual([]);
  });

  it('allows a literal only in the file that defines the value, which exists and holds it', () => {
    for (const file of Object.keys(INTERVAL_CAP_LITERAL_ALLOWED)) expect(existsSync(join(WORKSPACE, file)), file).toBe(true);
    const config = readFileSync(join(WORKSPACE, 'apps/api/src/platform/config/config.ts'), 'utf8');
    expect(config).toMatch(/DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS\s*=\s*120_000/u);
    expect(DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS).toBe(120_000);
  });

  it('exempts only the engine, whose tests exercise the cap as the parameter it is', () => {
    const inEngine = checkNoIntervalCapLiteral(WORKSPACE, ['packages/attempt-engine'], { exemptPrefixes: [] });
    expect(inEngine.length).toBeGreaterThan(0); // the engine\'s specs do carry literals: the exemption is what lets them
    expect(checkNoIntervalCapLiteral(WORKSPACE, ['packages/attempt-engine'])).toEqual([]);
  });

  describe('is red on a planted literal', () => {
    const fixtures = join(API_ROOT, 'src/fitness-fixtures');
    const run = (file: string) => checkNoIntervalCapLiteral(fixtures, ['as-interval-cap'], { allowed: {}, exemptPrefixes: [] }).filter((v) => v.file.endsWith(file));

    it('written as a property', () => {
      expect(run('planted-literal-cap.ts')).toEqual([expect.objectContaining({ rule: 'M6_37_INTERVAL_CAP_LITERAL', detail: expect.stringContaining('90_000') })]);
    });

    it('assigned to a variable', () => {
      expect(run('planted-assigned-cap.ts')).toEqual([expect.objectContaining({ detail: expect.stringContaining('30000') })]);
    });

    it('but not when the value is derived from the configured one', () => {
      expect(run('permitted-derived-cap.ts')).toEqual([]);
    });
  });
});
