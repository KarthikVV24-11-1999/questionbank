import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTEXT_DIR = fileURLToPath(new URL('.', import.meta.url));

/** ENGINEERING-HANDBOOK §1 — fixed anatomy, no exceptions. */
const ALL_DIRECTORIES = ['api', 'application', 'domain', 'infrastructure', 'public'] as const;

/** Layers that hold a real module today. */
const PRESENT_NOW = ['application', 'domain', 'public'] as const;

/**
 * Layers the handbook fixes but that have nothing real to hold until Track B
 * (`api/`) and Track C (`infrastructure/`). A directory cannot exist in git
 * without a file in it, and a file whose only purpose is to make a directory
 * non-empty is exactly what this track forbids — so these are named, not
 * faked. When one lands, move it to `PRESENT_NOW`; the last assertion below
 * fails if it is moved without the directory existing, or left here once it does.
 */
const DEFERRED = ['api', 'infrastructure'] as const;

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
