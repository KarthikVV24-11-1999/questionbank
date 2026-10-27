import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { DOCS_INDEX, checkDocsIndex, entryExists, indexEntries, trackedDocuments } from './docs-index-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = resolve(API_ROOT, '../..');
const PLANTED = resolve(API_ROOT, 'src/fitness-fixtures/as-docs-index/README.planted.md');

describe('docs/README.md indexes every document, and every entry names one that exists (M7-07)', () => {
  const index = readFileSync(resolve(REPO_ROOT, DOCS_INDEX), 'utf8');
  const documents = trackedDocuments(REPO_ROOT);

  it('the real index and the real tree agree, in both directions', () => {
    expect(checkDocsIndex(index, documents, (target) => entryExists(REPO_ROOT, target))).toEqual([]);
  });

  it('looked at the documents the repository keeps: the set, and not whatever was found', () => {
    // a fixed floor, so an empty listing cannot pass for "everything is indexed"
    expect(documents.length).toBeGreaterThanOrEqual(20);
    for (const named of ['docs/README.md', 'docs/KEY-FREE.md', 'docs/M6-ACCEPTANCE.md', 'docs/IMPLEMENTATION-DECISIONS.md', 'docs/DEBT.md']) {
      expect(documents, named).toContain(named);
    }
    expect(indexEntries(index)).toContain('adr/');
  });

  it('does not demand an entry for a working file git does not keep', () => {
    // a repository built here, with its own exclusion: the behaviour is asserted on a constructed condition, not on
    // whichever files this machine's clone happens to exclude locally
    const root = mkdtempSync(join(tmpdir(), 'qb-docs-index-'));
    try {
      execFileSync('git', ['init', '--quiet'], { cwd: root });
      mkdirSync(join(root, 'docs/tasks'), { recursive: true });
      writeFileSync(join(root, '.git/info/exclude'), 'docs/WORKING.md\ndocs/tasks/\n');
      for (const file of ['docs/README.md', 'docs/KEPT.md', 'docs/WORKING.md', 'docs/tasks/PLAN.md']) writeFileSync(join(root, file), '#\n');
      expect(trackedDocuments(root)).toEqual(['docs/KEPT.md', 'docs/README.md']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not ask the index to list itself', () => {
    expect(checkDocsIndex('', [DOCS_INDEX], () => true)).toEqual([]);
  });

  it('counts only the markdown directly under docs/, not the documents inside a directory', () => {
    expect(documents.every((path) => /^docs\/[^/]+\.md$/u.test(path))).toBe(true);
  });
});

describe('the rule, run against a planted index', () => {
  const planted = readFileSync(PLANTED, 'utf8');
  const exists = (target: string) => ['PRESENT.md', 'adr/'].includes(target);

  it('reads the entries of an index', () => {
    expect(indexEntries(planted)).toEqual(['PRESENT.md', 'GONE.md', 'adr/']);
  });

  it('catches a tracked document with no entry', () => {
    const found = checkDocsIndex(planted, ['docs/PRESENT.md', 'docs/UNLISTED.md'], exists);
    expect(found.filter((v) => v.rule === 'DOCUMENT_NOT_INDEXED').map((v) => v.detail)).toEqual([`docs/UNLISTED.md is tracked and has no entry in ${DOCS_INDEX}`]);
  });

  it('catches an entry that names nothing', () => {
    const found = checkDocsIndex(planted, ['docs/PRESENT.md'], exists);
    expect(found).toEqual([{ rule: 'INDEX_ENTRY_NAMES_NOTHING', detail: `${DOCS_INDEX} lists GONE.md, which does not exist` }]);
  });

  it('catches the omission this milestone found: the two documents M6 left out', () => {
    const before = readFileSync(resolve(REPO_ROOT, DOCS_INDEX), 'utf8')
      .split('\n')
      .filter((line) => !line.includes('KEY-FREE.md') && !line.includes('M6-ACCEPTANCE.md'))
      .join('\n');
    const found = checkDocsIndex(before, trackedDocuments(REPO_ROOT), (target) => entryExists(REPO_ROOT, target));
    expect(found.map((v) => v.rule)).toEqual(['DOCUMENT_NOT_INDEXED', 'DOCUMENT_NOT_INDEXED']);
    expect(found.map((v) => v.detail).join(' ')).toContain('docs/KEY-FREE.md');
    expect(found.map((v) => v.detail).join(' ')).toContain('docs/M6-ACCEPTANCE.md');
  });
});
