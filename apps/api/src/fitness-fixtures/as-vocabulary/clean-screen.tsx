import type { JSX } from 'react';

/** A screen as it should be: topics, chapters and subjects; names and addresses that carry our words as parts of longer names; an identifier that is only ever a key. */
const ROUTE = '/v1/learning/concept-map';
const EVENT = 'concept_map.viewed';
export function Clean({ conceptIdentityId, name }: { readonly conceptIdentityId: string; readonly name: string }): JSX.Element {
  return (
    <main aria-label="Where you stand" data-key={conceptIdentityId}>
      <h1>{name}</h1>
      <p>Weak, from 8 answers. Conceptual questions are a topic like any other.</p>
      <a href={`${ROUTE}?topic=${conceptIdentityId}`} title={EVENT}>
        See your answers
      </a>
    </main>
  );
}
