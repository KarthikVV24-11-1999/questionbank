import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { readCode } from './source-scan.js';

/**
 * **A learner is never shown our vocabulary** (M8-30, UX-ARCHITECTURE §2, D88 closed by this track).
 *
 * "Domain vocabulary is never exposed. *Concept*, *taxonomy version* and *item version* are our words; students see subject, chapter, topic, question." The strongest thing source can show is
 * weaker than that sentence, and this file says so rather than claim it. It cannot see what a screen will say: a label built at run time out of an identifier (`` `${id.slice(0, 8)}` ``) is
 * not a string in the source at all, and that is exactly the label D88 was about. What it can show is the *written* half, and that half is what it holds:
 *
 *   - **No string a learner could read contains one of our words** (`M8_30_OUR_WORD_IN_A_STRING`): `concept`, `taxonomy`, `item version`, as words, in any case and in any string literal, template
 *     literal or run of JSX text under `apps/learn/src`. `conceptIdentityId`, `concept_ids` and `concept_map.viewed` are names, not words, and are not read; a route (`/v1/learning/concept-map`)
 *     and an import specifier are addresses and are not read either.
 *   - **No string a learner could read is, or contains, a bare identifier** (`M8_30_IDENTIFIER_IN_A_STRING`): a UUID, or the eight hexadecimal characters a shortened one leaves.
 *
 * The other half is behavioural and is not here: `apps/learn/src/testing/vocabulary.ts` reads a *rendered* screen (its text, and the attributes that are spoken) and fails on the same words and on any
 * identifier, and each screen's spec calls it on every state it can show. The two are different reads of the same rule, and neither would have caught `Concept 3f2a9c10` alone: the scan catches
 * the word in the source, the render catches an identifier that was only ever made at run time.
 *
 * Specs, the test support directory and the public assets are not governed (a spec is allowed to say what it forbids). Two limits of the scan are stated and not solved: JSX text is found between
 * `>` and `<`, so a comparison written between them is read as text (a false alarm at worst), and text held in a file that is not TypeScript is not read.
 */
export type VocabularyRule = 'M8_30_OUR_WORD_IN_A_STRING' | 'M8_30_IDENTIFIER_IN_A_STRING';

export interface VocabularyViolation {
  readonly rule: VocabularyRule;
  readonly file: string;
  readonly text: string;
}

/** The words of ours. Each is a word and not a part of a longer name, so the names the code is made of are free to use them. */
export const OUR_WORDS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'concept', pattern: /\bconcepts?\b/iu },
  { name: 'taxonomy', pattern: /\btaxonom(?:y|ies)\b/iu },
  { name: 'item version', pattern: /\bitem[\s-]*versions?\b/iu },
];
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;
/** What a shortened identifier leaves: eight hexadecimal characters with a digit and a letter, so a date or a plain number is not one. */
const SHORT_ID = /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/iu;

/**
 * Strings that look like an identifier and are not for a learner, each with its reason. An entry names the file and the exact text, so it excuses one string in one place and not a pattern; the spec fails an entry
 * that no longer matches anything, so the list cannot rot into a door left open.
 */
export const NOT_FOR_A_LEARNER: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'apps/learn/src/main.tsx': {
    '00000000-0000-0000-0000-000000000000': "the platform tenant's identifier, which every analytics envelope carries; it is sent and never rendered",
  },
};

const SKIPPED = ['node_modules', 'coverage', 'dist', 'fitness-fixtures', 'testing', 'public'];

function sourceFiles(directory: string): string[] {
  return readdirSync(directory).flatMap((entry) => {
    if (SKIPPED.includes(entry)) return [];
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/u.test(entry) && !/\.(spec|d)\.tsx?$/u.test(entry) ? [path] : [];
  });
}

/** An address is read by a program: a route or a query, and an import specifier. */
const isAddress = (text: string, before: string): boolean => /^[/?]/u.test(text) || /(?:\bfrom|\bimport\s*\(?|\brequire\s*\()\s*$/u.test(before);

/** Every string literal, template literal and run of JSX text in code that has had its comments taken out. A template's `${}` is read as code, and the strings in it as strings. */
export function readableStrings(code: string, jsx: boolean): string[] {
  const found: string[] = [];
  const scan = (source: string): void => {
    let index = 0;
    while (index < source.length) {
      const char = source[index] as string;
      if (char !== "'" && char !== '"' && char !== '`') {
        index += 1;
        continue;
      }
      const before = source.slice(Math.max(0, index - 20), index);
      let text = '';
      let end = index + 1;
      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\') {
          text += source.slice(end, end + 2);
          end += 2;
          continue;
        }
        if (char === '`' && source[end] === '$' && source[end + 1] === '{') {
          let depth = 1;
          let close = end + 2;
          while (close < source.length && depth > 0) {
            if (source[close] === '{') depth += 1;
            if (source[close] === '}') depth -= 1;
            close += 1;
          }
          scan(source.slice(end + 2, close - 1));
          text += ' ';
          end = close;
          continue;
        }
        text += source[end];
        end += 1;
      }
      if (!isAddress(text, before)) found.push(text);
      index = end + 1;
    }
  };
  scan(code);
  if (jsx) {
    // JSX text is what is between a tag's `>` and the next `<`, outside any braces; the strings in braces were read above
    for (const match of code.matchAll(/>([^<>{}]*[A-Za-z0-9][^<>{}]*)</gu)) found.push((match[1] as string).trim());
  }
  return found;
}

export function checkLearnerVocabulary(
  workspaceRoot: string,
  roots: readonly string[],
  options: { readonly notForALearner?: Readonly<Record<string, Readonly<Record<string, string>>>> } = {},
): { readonly violations: VocabularyViolation[]; readonly scannedFiles: number } {
  const excused = options.notForALearner ?? NOT_FOR_A_LEARNER;
  const violations: VocabularyViolation[] = [];
  let scannedFiles = 0;
  for (const root of roots) {
    for (const path of sourceFiles(join(workspaceRoot, root))) {
      scannedFiles += 1;
      const file = relative(workspaceRoot, path).replaceAll('\\', '/');
      for (const text of new Set(readableStrings(readCode(path), path.endsWith('.tsx')))) {
        if (excused[file]?.[text] !== undefined) continue;
        for (const word of OUR_WORDS) if (word.pattern.test(text)) violations.push({ rule: 'M8_30_OUR_WORD_IN_A_STRING', file, text });
        if (UUID.test(text) || SHORT_ID.test(text)) violations.push({ rule: 'M8_30_IDENTIFIER_IN_A_STRING', file, text });
      }
    }
  }
  return { violations, scannedFiles };
}
