import { describe, expect, it } from 'vitest';
import { TAXONOMY_STATES, isLegalTransition, isMutable, type TaxonomyState } from './taxonomy-lifecycle.js';

const LEGAL: ReadonlyArray<readonly [TaxonomyState, TaxonomyState]> = [
  ['draft', 'published'],
  ['published', 'superseded'],
];

function isLegalPair(from: TaxonomyState, to: TaxonomyState): boolean {
  return LEGAL.some(([legalFrom, legalTo]) => legalFrom === from && legalTo === to);
}

describe('taxonomy lifecycle', () => {
  it('has exactly three states', () => {
    expect([...TAXONOMY_STATES]).toEqual(['draft', 'published', 'superseded']);
  });

  it.each(LEGAL)('permits %s → %s', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(true);
  });

  it('rejects every transition that is not draft→published or published→superseded', () => {
    const illegal = TAXONOMY_STATES.flatMap((from) =>
      TAXONOMY_STATES.filter((to) => !isLegalPair(from, to)).map((to) => [from, to] as const),
    );

    expect(illegal).toHaveLength(7);
    for (const [from, to] of illegal) {
      expect(isLegalTransition(from, to)).toBe(false);
    }
  });

  it('treats only a draft as mutable', () => {
    expect(isMutable('draft')).toBe(true);
    expect(isMutable('published')).toBe(false);
    expect(isMutable('superseded')).toBe(false);
  });
});
