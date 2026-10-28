import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { sourceFilesIn } from '../../testing/context-anatomy.js';

const CONTEXT_DIR = fileURLToPath(new URL('.', import.meta.url));

/** ENGINEERING-HANDBOOK §1 — fixed anatomy, no exceptions. */
const ALL_DIRECTORIES = ['api', 'application', 'domain', 'infrastructure', 'public'] as const;

/** Layers that hold a real module today. */
const PRESENT_NOW = ['api', 'application', 'domain', 'infrastructure', 'public'] as const;

/**
 * Layers the handbook fixes but that have nothing real to hold yet. None today:
 * `api/` landed with the composition (M5-37), holding the module that carries the
 * registry. A directory cannot exist in git without a file in it, and a file whose
 * only purpose is to make a directory non-empty is exactly what this context
 * forbids — so a layer with nothing real is named here, not faked. The last
 * assertion below fails if a layer is listed here once its directory exists.
 */
const DEFERRED = [] as readonly string[];

function directories(): string[] {
  return readdirSync(CONTEXT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('the generation context anatomy', () => {
  for (const directory of PRESENT_NOW) {
    it(`has a ${directory}/ directory`, () => {
      const path = join(CONTEXT_DIR, directory);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).isDirectory()).toBe(true);
    });

    it(`has TypeScript source in ${directory}/, not only a placeholder`, () => {
      expect(sourceFilesIn(join(CONTEXT_DIR, directory)).length).toBeGreaterThan(0);
    });
  }

  it('has no directory beyond the five the handbook fixes', () => {
    expect(directories().filter((name) => !(ALL_DIRECTORIES as readonly string[]).includes(name))).toEqual([]);
  });

  it('accounts for all five layers, each either present or explicitly deferred', () => {
    expect([...PRESENT_NOW, ...DEFERRED].sort()).toEqual([...ALL_DIRECTORIES].sort());
  });

  it('lists a layer as deferred only while its directory does not exist', () => {
    const present = directories();
    expect(DEFERRED.filter((name) => present.includes(name))).toEqual([]);
  });
});
