import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  checklistItemsUnder,
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

describe('M0-CLOSEOUT.md carries the same Definition of Done M0-WALKING-SKELETON.md ratified (M0-27)', () => {
  const sourceMarkdown = readFileSync(resolve(REPO_ROOT, 'docs/tasks/M0-WALKING-SKELETON.md'), 'utf8');
  const closeoutMarkdown = readFileSync(resolve(REPO_ROOT, 'docs/tasks/M0-CLOSEOUT.md'), 'utf8');

  const SECTIONS = [
    [
      '**Delivered and proven here (Tier 1)**',
      '**Authored and asserted, claiming nothing more (Tier 2)**',
      '### Delivered and proven here (Tier 1)',
      '### Authored and asserted, claiming nothing more (Tier 2)',
    ],
    [
      '**Authored and asserted, claiming nothing more (Tier 2)**',
      '**Blocked — marked so now, and not to be narrowed until they pass (Tier 3)**',
      '### Authored and asserted, claiming nothing more (Tier 2)',
      '### Blocked — marked so now, not narrowed until they pass (Tier 3)',
    ],
    [
      '**Blocked — marked so now, and not to be narrowed until they pass (Tier 3)**',
      '**Carried and reassigned**',
      '### Blocked — marked so now, not narrowed until they pass (Tier 3)',
      '### Carried and reassigned',
    ],
    ['**Carried and reassigned**', undefined, '### Carried and reassigned', undefined],
  ] as const;

  it.each(SECTIONS)(
    '%s carries the same number of criteria in both documents',
    (sourceHeading, sourceNext, closeoutHeading, closeoutNext) => {
      const sourceItems = checklistItemsUnder(sourceMarkdown, sourceHeading, sourceNext);
      const closeoutItems = checklistItemsUnder(closeoutMarkdown, closeoutHeading, closeoutNext);
      expect(sourceItems.length).toBeGreaterThan(0);
      expect(closeoutItems.length).toBe(sourceItems.length);
    },
  );

  it('a criterion dropped from the close-out is caught', () => {
    const withOneDropped = closeoutMarkdown.replace(/- \[x\] All 27 tasks merged\n/u, '');
    const before = checklistItemsUnder(
      closeoutMarkdown,
      '### Delivered and proven here (Tier 1)',
      '### Authored and asserted, claiming nothing more (Tier 2)',
    ).length;
    const after = checklistItemsUnder(
      withOneDropped,
      '### Delivered and proven here (Tier 1)',
      '### Authored and asserted, claiming nothing more (Tier 2)',
    ).length;
    expect(after).toBe(before - 1);
  });
});
