import { expect } from 'vitest';

/**
 * What a learner reads must not be in our vocabulary (UX-ARCHITECTURE §2: "Domain vocabulary is never exposed"). A student sees subject, chapter, topic and question; *concept*, *taxonomy* and
 * *item version* are ours, and so is every identifier. This is the half of the rule a source scan cannot hold: a label built at run time out of an identifier (`Concept 3f2a9c10`) is not a string
 * in the source, and only a rendered screen has it (M8-30, D88).
 *
 * `whatALearnerReads` is everything on the screen a person or a screen reader is given: the text, and the attributes that are spoken or shown (`aria-label`, `title`, `alt`, `placeholder`,
 * `aria-description`, the value of a field). An address (`href`) is not read by anyone and may carry an identifier, as a route does.
 */
export const OUR_WORDS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }> = [
  { name: 'concept', pattern: /\bconcepts?\b/iu },
  { name: 'taxonomy', pattern: /\btaxonom(?:y|ies)\b/iu },
  { name: 'item version', pattern: /\bitem[\s-]*versions?\b/iu },
  { name: 'a uuid', pattern: /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu },
  { name: 'a shortened identifier', pattern: /\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{8}\b/iu },
];

const SPOKEN = ['aria-label', 'aria-description', 'title', 'alt', 'placeholder'] as const;

export function whatALearnerReads(root: Element): string[] {
  const read: string[] = [];
  const text = root.ownerDocument.createTreeWalker(root, 4 /* NodeFilter.SHOW_TEXT */);
  for (let node = text.nextNode(); node !== null; node = text.nextNode()) {
    const value = (node.textContent ?? '').trim();
    if (value !== '') read.push(value);
  }
  for (const element of [root, ...root.querySelectorAll('*')]) {
    for (const attribute of SPOKEN) {
      const value = element.getAttribute(attribute);
      if (value !== null && value.trim() !== '') read.push(value.trim());
    }
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
      if (element.value.trim() !== '') read.push(element.value.trim());
    }
  }
  return read;
}

/** The words of ours that appear in what a learner reads: empty when the screen is clean. */
export function ourWordsIn(root: Element): string[] {
  const found: string[] = [];
  for (const line of whatALearnerReads(root)) {
    for (const { name, pattern } of OUR_WORDS) if (pattern.test(line)) found.push(`${name}: "${line}"`);
  }
  return found;
}

export function expectNoDomainVocabulary(root: Element): void {
  expect(ourWordsIn(root)).toEqual([]);
}
