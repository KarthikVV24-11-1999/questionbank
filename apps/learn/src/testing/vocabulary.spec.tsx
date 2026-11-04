import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { expectNoDomainVocabulary, ourWordsIn, whatALearnerReads } from './vocabulary.js';

/** The check is only worth having if it sees what a learner would: each of these is the shape of a failure it exists for. */
describe('the check for our vocabulary on a rendered screen', () => {
  const flagged = (element: React.ReactElement): string[] => ourWordsIn(render(element).container);

  it('finds the label the home screen used to show: a word of ours and the start of an identifier', () => {
    const found = flagged(<h2>Concept 3f2a9c10</h2>);
    expect(found.map((line) => line.split(':')[0])).toEqual(['concept', 'a shortened identifier']);
  });

  it('finds each of our words in text, however it is cased or joined', () => {
    for (const text of ['Concepts', 'the CONCEPT map', 'taxonomy version', 'Taxonomies', 'item version', 'item-versions']) expect(flagged(<p>{text}</p>), text).not.toEqual([]);
  });

  it('finds a full identifier, in text and in what a screen reader is given', () => {
    expect(flagged(<p>{'3f2a9c10-1b2c-4d3e-8f4a-5b6c7d8e9f00'}</p>).map((line) => line.split(':')[0])).toContain('a uuid');
    expect(flagged(<button aria-label="Practise 3f2a9c10-1b2c-4d3e-8f4a-5b6c7d8e9f00" />).map((line) => line.split(':')[0])).toContain('a uuid');
    expect(flagged(<img alt="concept" src="x.png" />)).toHaveLength(1);
    expect(flagged(<input title="taxonomy" />)).toHaveLength(1);
    expect(flagged(<input placeholder="a concept" />)).toHaveLength(1);
    expect(flagged(<input defaultValue="item version" />)).toHaveLength(1);
  });

  it('leaves the words a learner is meant to see alone, and a number or a date that is not an identifier', () => {
    const clean = flagged(
      <main aria-label="Where you stand">
        <h1>Kinematics</h1>
        <p>Physics › Mechanics</p>
        <p>Weak, from 8 answers. 2026-11-04. 20261104.</p>
        <p>conceptual understanding is not our word for it</p>
      </main>,
    );
    expect(clean).toEqual([]);
  });

  it('does not read an address, which carries an identifier because a route has to', () => {
    const view = render(<a href="?topic=3f2a9c10-1b2c-4d3e-8f4a-5b6c7d8e9f00">Kinematics</a>);
    expectNoDomainVocabulary(view.container);
    expect(whatALearnerReads(view.container)).toEqual(['Kinematics']);
  });
});
