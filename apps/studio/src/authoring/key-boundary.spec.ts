import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * ADR-0009's enumerated exception, applied to the Studio tree.
 *
 * The answer key has to reach the author's browser — that is what an authoring
 * surface *is* — so the rule cannot be "no key anywhere". It is instead: the
 * features allowed to carry one are **named here, and the list is closed**.
 * Adding a feature to it is a reviewed diff; a key-bearing field appearing
 * anywhere else fails.
 *
 * **Asserted in both directions**, per DEC-4's second ratified condition. A
 * check that only looked for keys where they should not be passes cheerfully
 * on the day somebody removes the key field from the item editor, which is a
 * different bug and just as bad.
 */

const KEY_BEARING_FEATURES = [
  join('features', 'item-editor'),
  join('features', 'solution-editor'),
  // M4-38 (ADR-0009, DEC-M4-12): the review workspace is an authoring-family
  // surface — a reviewer verifies correctness, which requires seeing which
  // option is correct. Added when review-workspace first rendered
  // `correctOptionId`/`correctOptionIds`, per the plan's own acceptance
  // criterion ("the answer key is present ... and the surface is
  // unreachable without an authoring policy").
  join('features', 'review-workspace'),
] as const;

/** The field names that are the key, or name it, by whatever spelling. */
const KEY_BEARING = /correctOptionId|expectedValue|isCorrect|is_correct|answerKey/u;

/**
 * The scanner names the field names it looks for, so it matches itself. The
 * exemption is written here rather than inferred, because an exemption nobody
 * had to type is one that quietly grows.
 */
const SCANNER = join('src', 'authoring', 'key-boundary.spec.ts');

function sourceFiles(root: string): string[] {
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return path.endsWith('.ts') || path.endsWith('.tsx') ? [path] : [];
  });
}

describe('the answer key reaches only the enumerated authoring features (ADR-0009)', () => {
  const files = sourceFiles('src');

  it('scanned the whole Studio tree', () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it('names a key-bearing field nowhere outside the list', () => {
    const offenders = files.filter(
      (path) =>
        path !== SCANNER &&
        !KEY_BEARING_FEATURES.some((feature) => path.includes(feature)) &&
        KEY_BEARING.test(readFileSync(path, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  // The other direction: a listed feature that silently stopped carrying the
  // key is an editor that can no longer author one, and the scan above would
  // have nothing to say about it.
  it('finds the key present in every feature the list says carries one', () => {
    for (const feature of KEY_BEARING_FEATURES) {
      const inFeature = files.filter((path) => path.includes(feature));
      expect(inFeature.length, feature).toBeGreaterThan(0);
      expect(
        inFeature.some((path) => KEY_BEARING.test(readFileSync(path, 'utf8'))),
        feature,
      ).toBe(true);
    }
  });
});
