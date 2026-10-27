import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { contextOf } from './boundary-rules.js';
import { importsOf } from './source-scan.js';
import { checkLearningBoundary, contextFiles } from './learning-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = 'src/fitness-fixtures';
const PLANTED = {
  learningToScoring: `${FIXTURES}/as-learning-imports-scoring/planted-direct-import.ts`,
  learningToContent: `${FIXTURES}/as-learning-imports-content/planted-type-only-import.ts`,
  scoringToLearning: `${FIXTURES}/as-scoring-imports-learning/planted-type-only-import.ts`,
  contentToLearning: `${FIXTURES}/as-content-imports-learning/planted-direct-import.ts`,
} as const;

describe('learning and the contexts its evidence comes from share no import (M7-06, DEC-M7-1)', () => {
  it('the real tree has none, in either direction', () => {
    expect(checkLearningBoundary(API_ROOT)).toEqual([]);
  });

  it('scanned a real tree: the set of governed contexts, not a loop over whatever was found', () => {
    const files = contextFiles(API_ROOT);
    expect([...new Set(files.map(contextOf))].sort()).toEqual(['assessment', 'content', 'curriculum', 'generation', 'learning', 'scoring']);
    expect(files.filter((file) => contextOf(file) === 'learning').length).toBeGreaterThan(3);
    expect(files.filter((file) => contextOf(file) === 'scoring').length).toBeGreaterThan(30);
    expect(files.filter((file) => contextOf(file) === 'content').length).toBeGreaterThan(50);
    for (const planted of Object.values(PLANTED)) expect(files, planted).not.toContain(planted);
  });
});

describe('the rule, run against a planted violation per clause', () => {
  it('learning → scoring: a direct value import through the barrel, which F1 admits', () => {
    const found = checkLearningBoundary(API_ROOT, { files: [PLANTED.learningToScoring], as: 'learning' });
    expect(found.map((v) => [v.rule, v.importPath])).toEqual([['LEARNING_REACHES_ITS_SOURCES', '../../contexts/scoring/public/index.js']]);
    expect(found[0]?.file).toBe(PLANTED.learningToScoring);
    expect(found[0]?.message).toContain('DEC-M7-1');
  });

  it('learning → content: a type-only import, which a scan for `import {` walks past', () => {
    const found = checkLearningBoundary(API_ROOT, { files: [PLANTED.learningToContent], as: 'learning' });
    expect(found.map((v) => [v.rule, v.importPath])).toEqual([['LEARNING_REACHES_ITS_SOURCES', '../../contexts/content/public/index.js']]);
  });

  it('scoring → learning: the owning context learning who consumes it, as a type-only import', () => {
    const found = checkLearningBoundary(API_ROOT, { files: [PLANTED.scoringToLearning], as: 'scoring' });
    expect(found.map((v) => [v.rule, v.importPath])).toEqual([['SOURCE_REACHES_LEARNING', '../../contexts/learning/public/index.js']]);
  });

  it('content → learning: a value import of a composition seam', () => {
    const found = checkLearningBoundary(API_ROOT, { files: [PLANTED.contentToLearning], as: 'content' });
    expect(found.map((v) => [v.rule, v.importPath])).toEqual([['SOURCE_REACHES_LEARNING', '../../contexts/learning/public/composition.js']]);
  });

  it('is not tripped by what it permits: the same imports from a file that is not of the pair', () => {
    // content reaching scoring, learning reaching itself, and assessment reaching learning are other rules' business
    expect(checkLearningBoundary(API_ROOT, { files: [PLANTED.learningToScoring], as: 'assessment' })).toEqual([]);
    expect(checkLearningBoundary(API_ROOT, { files: [PLANTED.scoringToLearning], as: 'learning' })).toEqual([]);
    expect(checkLearningBoundary(API_ROOT, { files: [PLANTED.learningToContent], as: 'scoring' })).toEqual([]);
  });

  it('the import scanner it rests on reads a type-only import, a re-export and a dynamic import', () => {
    const source = [
      `import type { A } from '../../contexts/scoring/public/index.js';`,
      `export type { B } from '../../contexts/content/public/index.js';`,
      `const c = await import('../../contexts/scoring/domain/x.js');`,
    ].join('\n');
    expect(importsOf(source).sort()).toEqual([
      '../../contexts/content/public/index.js',
      '../../contexts/scoring/domain/x.js',
      '../../contexts/scoring/public/index.js',
    ]);
  });

  it('matches a specifier that is not a relative path on its text', () => {
    const found = checkLearningBoundary(API_ROOT, { files: [`${FIXTURES}/as-learning-imports-scoring/planted-package-specifier.ts`], as: 'learning' });
    expect(found.map((v) => [v.rule, v.importPath])).toEqual([['LEARNING_REACHES_ITS_SOURCES', '@questionbank/api/contexts/scoring/domain/score-record.js']]);
  });
});
