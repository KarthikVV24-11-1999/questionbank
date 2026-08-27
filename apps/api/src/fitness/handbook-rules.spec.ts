import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  checkHandbookReferences,
  SECTION_11_FILES,
  SECTION_11_SCRIPTS,
} from './handbook-rules.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');

describe('§11 (Day One) quotes only commands and files that are real', () => {
  it('every named script and file exists', () => {
    expect(checkHandbookReferences(REPO_ROOT)).toEqual([]);
  });

  it('checked something — the reference lists are not empty', () => {
    expect(SECTION_11_SCRIPTS.length).toBeGreaterThan(0);
    expect(SECTION_11_FILES.length).toBeGreaterThan(0);
  });

  it('fires on a planted reference to a script that does not exist', () => {
    const violations = checkHandbookReferences(REPO_ROOT, {
      scripts: [{ packageJsonPath: 'apps/api/package.json', script: 'this-script-does-not-exist' }],
      files: [],
    });
    expect(violations).toEqual([
      { rule: 'MISSING_SCRIPT', detail: 'apps/api/package.json#this-script-does-not-exist' },
    ]);
  });

  it('fires on a planted reference to a file that does not exist', () => {
    const violations = checkHandbookReferences(REPO_ROOT, {
      scripts: [],
      files: ['docs/THIS-FILE-DOES-NOT-EXIST.md'],
    });
    expect(violations).toEqual([{ rule: 'MISSING_FILE', detail: 'docs/THIS-FILE-DOES-NOT-EXIST.md' }]);
  });

  it('fires on a planted reference to a package.json that does not exist', () => {
    const violations = checkHandbookReferences(REPO_ROOT, {
      scripts: [{ packageJsonPath: 'apps/does-not-exist/package.json', script: 'test' }],
      files: [],
    });
    expect(violations).toEqual([{ rule: 'MISSING_FILE', detail: 'apps/does-not-exist/package.json' }]);
  });
});
