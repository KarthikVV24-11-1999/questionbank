import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { locateTest } from './test-locator.js';

const API_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const FIXTURES = join(API_ROOT, 'src/fitness-fixtures/as-skipped-test');
const TITLE = 'planted: serves nothing it should not';
const read = (name: string) => readFileSync(join(FIXTURES, `${name}.ts`), 'utf8');

describe('a title is only evidence if the test runs (M7-17)', () => {
  it('has a fixture for every form of skip, and the controls: the set, so a form dropped from it fails', () => {
    expect(readdirSync(FIXTURES).map((f) => f.replace(/\.ts$/u, '')).sort()).toEqual(
      ['describe-skip', 'describe-todo', 'it-skip', 'it-todo', 'only-elsewhere', 'only-on-it', 'runs', 'skip-if', 'test-skip'].sort(),
    );
  });

  describe('is red on each form of skip', () => {
    const cases: [string, string, RegExp][] = [
      ['describe-skip', TITLE, /describe\.skip \(line \d+\)/u],
      ['it-skip', TITLE, /it\.skip \(line \d+\)/u],
      ['test-skip', TITLE, /test\.skip \(line \d+\)/u],
      ['describe-todo', 'planted: a surface that carries no key', /describe\.todo \(line \d+\)/u],
      ['it-todo', TITLE, /it\.todo \(line \d+\)/u],
      ['skip-if', TITLE, /it\.runIf \(line \d+\)/u],
      ['skip-if', 'planted: in a conditional block', /describe\.skipIf \(line \d+\)/u],
      ['only-elsewhere', TITLE, /a \.only at line \d+ silences everything else/u],
    ];
    for (const [fixture, title, reason] of cases) {
      it(`${fixture}: "${title}"`, () => {
        const located = locateTest(read(fixture), title);
        expect(located.found).toBe(true);
        expect(located.runs).toBe(false);
        expect(located.because).toMatch(reason);
      });
    }
  });

  describe('is green on a test that runs', () => {
    it('with nothing around it, and read through it.each', () => {
      expect(locateTest(read('runs'), TITLE)).toEqual({ found: true, runs: true });
      expect(locateTest(read('runs'), 'planted: runs for each case')).toEqual({ found: true, runs: true });
    });

    it('with an .only on the test itself, which is not silenced by the .only it carries', () => {
      expect(locateTest(read('only-on-it'), TITLE)).toEqual({ found: true, runs: true });
      expect(locateTest(read('only-on-it'), 'planted: other test, silenced by the only')).toMatchObject({ found: true, runs: false });
    });

    it('when one of two tests with the title is skipped and the other runs', () => {
      const both = `describe('a', () => { it.skip('same title', () => {}); it('same title', () => {}); });`;
      expect(locateTest(both, 'same title')).toEqual({ found: true, runs: true });
    });
  });

  it('says not found for a title that names no test, even when the words are in the file as a comment or a plain string', () => {
    expect(locateTest(`// serves nothing\nconst s = 'serves nothing it should not';\nit('other', () => {});`, 'serves nothing it should not')).toEqual({ found: false, runs: false });
  });

  it('matches a title on the source of the title argument, so a template or a concatenation is found, and reads TSX', () => {
    expect(locateTest("it(`serves nothing for ${name}`, () => {});", 'serves nothing for')).toEqual({ found: true, runs: true });
    expect(locateTest("it('serves ' + 'nothing', () => {});", "'serves '")).toMatchObject({ found: true });
    expect(locateTest("describe.skip('shows no key', () => { it('x', () => <div />); });", 'shows no key', 'screen.spec.tsx')).toMatchObject({ found: true, runs: false });
  });

  it('is not confused by a call that is not a test block: a plain function named like a modifier, or a block with no title', () => {
    expect(locateTest(`skip('serves nothing'); it(() => {}); expect(1).toBe(1);`, 'serves nothing')).toEqual({ found: false, runs: false });
  });
});
