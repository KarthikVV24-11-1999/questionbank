import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTEXT_DIR = fileURLToPath(new URL('.', import.meta.url));

/** ENGINEERING-HANDBOOK §1 — fixed anatomy, no exceptions. */
const ALL_DIRECTORIES = ['api', 'application', 'domain', 'infrastructure', 'public'] as const;

/** Layers that hold a real module today. */
const PRESENT_NOW = ['domain', 'infrastructure'] as readonly string[];

/**
 * Layers the handbook fixes but that have nothing real to hold yet. A directory
 * cannot exist in git without a file in it, and a file whose only purpose is to
 * make a directory non-empty is exactly what this context forbids — so a layer
 * with nothing real is named here, not faked.
 *
 * `domain/` left this list with the aggregates (M6-09) and `infrastructure/` with the
 * repositories (M6-13). `application/` and `public/` follow when form
 * assembly and delivery give them handlers to hold, and `api/` with the routes.
 * The last assertion below fails if a layer is listed here once its directory
 * exists, so the list cannot go stale quietly.
 */
const DEFERRED = ['api', 'application', 'public'] as readonly string[];

function directories(): string[] {
  return readdirSync(CONTEXT_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
}

describe('the assessment context anatomy', () => {
  for (const directory of PRESENT_NOW) {
    it(`has a ${directory}/ directory`, () => {
      const path = join(CONTEXT_DIR, directory);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).isDirectory()).toBe(true);
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

  it('lists a layer as present only while its directory exists', () => {
    const present = directories();
    expect(PRESENT_NOW.filter((name) => !present.includes(name))).toEqual([]);
  });
});
