import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkReadmeContexts, contextDirectories } from './readme-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const REPO_ROOT = resolve(API_ROOT, '../..');

describe('the root README names the contexts there are (M7-10)', () => {
  const readme = readFileSync(resolve(REPO_ROOT, 'README.md'), 'utf8');
  const directories = contextDirectories(API_ROOT);

  it('the heading, the table and the diagram agree with the directory listing', () => {
    expect(checkReadmeContexts(readme, directories)).toEqual([]);
  });

  it('looked at the six contexts there are: the set, not whatever was found', () => {
    expect(directories).toEqual(['assessment', 'content', 'curriculum', 'generation', 'learning', 'scoring']);
  });
});

describe('the rule, run against a planted README', () => {
  const planted = readFileSync(resolve(API_ROOT, 'src/fitness-fixtures/as-readme-contexts/README.planted.md'), 'utf8');
  const found = checkReadmeContexts(planted, ['curriculum', 'scoring', 'learning']);

  it('catches a count that is wrong', () => {
    expect(found.filter((v) => v.rule === 'README_CONTEXT_COUNT').map((v) => v.detail)).toEqual([
      'the README says Four bounded contexts and the directory holds 3 (curriculum, learning, scoring)',
    ]);
  });

  it('catches a context with no row and a row with no context', () => {
    expect(found.filter((v) => v.rule === 'README_TABLE_ROWS').map((v) => v.detail).sort()).toEqual([
      'contexts/learning/ exists and the README table has no row for it',
      'the README table has a row for ghost, and contexts/ghost/ does not exist',
    ]);
  });

  it('catches a context the diagram omits and one it invents', () => {
    expect(found.filter((v) => v.rule === 'README_DIAGRAM').map((v) => v.detail).sort()).toEqual([
      'contexts/learning/ exists and the README diagram does not show it',
      'the README diagram shows contexts/ghost/, which does not exist',
    ]);
  });

  it('says nothing is wrong about a heading it cannot find, rather than passing it', () => {
    expect(checkReadmeContexts('no heading here', ['scoring']).some((v) => v.rule === 'README_CONTEXT_COUNT')).toBe(true);
  });
});
