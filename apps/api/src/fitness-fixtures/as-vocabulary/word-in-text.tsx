import type { JSX } from 'react';

/** The words of ours, in the places a learner reads: text between tags, and attributes that are spoken. */
export function WordInText(): JSX.Element {
  return (
    <main>
      <h2>Your weakest concept</h2>
      <button aria-label="Practise this Concept">Go</button>
      <p title="The taxonomy version">This item version is retired.</p>
    </main>
  );
}
