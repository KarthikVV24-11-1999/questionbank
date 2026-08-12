import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CONTEXT_DIR = fileURLToPath(new URL('.', import.meta.url));

/** ENGINEERING-HANDBOOK §1 — fixed anatomy, no exceptions. */
const REQUIRED_DIRECTORIES = ['api', 'application', 'domain', 'infrastructure', 'public'] as const;

describe('the content context anatomy', () => {
  for (const directory of REQUIRED_DIRECTORIES) {
    it(`has a ${directory}/ directory`, () => {
      const path = join(CONTEXT_DIR, directory);
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).isDirectory()).toBe(true);
    });
  }

  it('has no directory beyond the five the handbook fixes', () => {
    const directories = readdirSync(CONTEXT_DIR, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
    expect(directories).toEqual([...REQUIRED_DIRECTORIES].sort());
  });
});
