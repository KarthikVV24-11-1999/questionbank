import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkLearnerVocabulary, NOT_FOR_A_LEARNER, readableStrings } from './vocabulary-rules.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const WORKSPACE = resolve(API_ROOT, '../..');
const FIXTURES = join(API_ROOT, 'src/fitness-fixtures');

describe('a learner is never shown our vocabulary (M8-30, UX-ARCHITECTURE §2)', () => {
  it('finds none in what the learner app says, and the scan is not vacuous', () => {
    const { violations, scannedFiles } = checkLearnerVocabulary(WORKSPACE, ['apps/learn/src']);
    expect(violations).toEqual([]);
    expect(scannedFiles).toBeGreaterThan(30);
  });

  it('excuses only strings that are really there, so the list cannot rot', () => {
    for (const [file, texts] of Object.entries(NOT_FOR_A_LEARNER)) {
      expect(existsSync(join(WORKSPACE, file)), file).toBe(true);
      for (const [text, reason] of Object.entries(texts)) {
        expect(readFileSync(join(WORKSPACE, file), 'utf8'), `${file}: ${text}`).toContain(text);
        expect(reason.length, text).toBeGreaterThan(20);
      }
    }
    // and an excuse is the only reason the scan is quiet on it
    const without = checkLearnerVocabulary(WORKSPACE, ['apps/learn/src'], { notForALearner: {} });
    expect(without.violations.map((violation) => [violation.file, violation.text])).toEqual(Object.entries(NOT_FOR_A_LEARNER).flatMap(([file, texts]) => Object.keys(texts).map((text) => [file, text])));
  });

  describe('is red on a planted violation, and quiet on a screen as it should be', () => {
    const run = (file: string) => checkLearnerVocabulary(FIXTURES, ['as-vocabulary'], { notForALearner: {} }).violations.filter((violation) => violation.file.endsWith(file));

    it('is quiet on a screen that uses our words only as parts of longer names, in routes and in event names', () => {
      expect(run('clean-screen.tsx')).toEqual([]);
    });

    it('finds our words in JSX text and in the attributes that are spoken', () => {
      expect(run('word-in-text.tsx').map((violation) => [violation.rule, violation.text])).toEqual([
        ['M8_30_OUR_WORD_IN_A_STRING', 'Practise this Concept'],
        ['M8_30_OUR_WORD_IN_A_STRING', 'The taxonomy version'],
        ['M8_30_OUR_WORD_IN_A_STRING', 'Your weakest concept'],
        ['M8_30_OUR_WORD_IN_A_STRING', 'This item version is retired.'],
      ]);
    });

    it('finds our words in strings that code builds, templates and the strings inside them included', () => {
      expect(new Set(run('word-in-code.ts').map((violation) => violation.text))).toEqual(new Set(['This concept keeps slipping.', 'Concept  ', 'Your taxonomy', 'Item versions']));
      expect(run('word-in-code.ts').every((violation) => violation.rule === 'M8_30_OUR_WORD_IN_A_STRING')).toBe(true);
    });

    it('finds a whole identifier and the start of one written where a learner reads', () => {
      expect(run('identifier-in-text.tsx').map((violation) => [violation.rule, violation.text])).toEqual([
        ['M8_30_IDENTIFIER_IN_A_STRING', 'a1b2c3d4-0000-4000-8000-0123456789ab'],
        ['M8_30_IDENTIFIER_IN_A_STRING', 'Topic 3f2a9c10'],
      ]);
    });
  });

  describe('what it reads as a string a learner could read', () => {
    it('reads literals, templates and the strings inside a template\'s expressions, and leaves out addresses', () => {
      const code = `import x from 'concept-library';\nconst a = 'one'; const b = "two"; const c = \`three \${ok ? 'four' : "five"} six\`; const d = '/v1/learning/concept-map'; const e = '?concept=1';`;
      expect(readableStrings(code, false)).toEqual(['one', 'two', 'four', 'five', 'three   six']);
    });

    it('reads JSX text only in a screen, and only the text', () => {
      const code = `const x = <p title="t">Hello <b>there</b>{value}</p>;`;
      expect(readableStrings(code, true)).toEqual(['t', 'Hello', 'there']);
      expect(readableStrings(code, false)).toEqual(['t']);
    });

    it('reads an escaped quote inside a string as part of it', () => {
      expect(readableStrings(`const s = 'it\\'s a concept';`, false)).toEqual(["it\\'s a concept"]);
    });
  });
});
