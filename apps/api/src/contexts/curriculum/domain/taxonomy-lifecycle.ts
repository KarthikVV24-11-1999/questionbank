/** Publication lifecycle shared by taxonomy versions (DOMAIN-MODEL §4). */
export const TAXONOMY_STATES = ['draft', 'published', 'superseded'] as const;

export type TaxonomyState = (typeof TAXONOMY_STATES)[number];

/** The only legal transitions. Everything else is rejected. */
const LEGAL_TRANSITIONS: ReadonlyMap<TaxonomyState, readonly TaxonomyState[]> = new Map([
  ['draft', ['published'] as const],
  ['published', ['superseded'] as const],
  ['superseded', [] as const],
]);

export function isLegalTransition(from: TaxonomyState, to: TaxonomyState): boolean {
  return (LEGAL_TRANSITIONS.get(from) ?? []).includes(to);
}

export function isMutable(state: TaxonomyState): boolean {
  return state === 'draft';
}
