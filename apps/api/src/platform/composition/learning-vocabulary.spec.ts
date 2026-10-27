import { describe, expect, it } from 'vitest';
import { DIFFICULTY_ESTIMATES, EVIDENCE_OUTCOMES } from '../../contexts/learning/domain/mastery-evidence.js';
import { CORRECTNESS_VALUES } from '../../contexts/scoring/domain/item-outcome.js';
import { DIFFICULTY_BANDS } from '../../contexts/content/public/index.js';

/**
 * Two lists of one vocabulary drift (ENGINEERING-HANDBOOK §5, session rule 5). The learning domain imports nothing, so it
 * keeps its own copies; this holds them to the owning contexts' lists from the one place the three may be named together.
 */
describe('the learning vocabulary is the owning contexts\' vocabulary', () => {
  it('names exactly the difficulty bands content has, in the same order', () => {
    expect([...DIFFICULTY_ESTIMATES]).toEqual([...DIFFICULTY_BANDS]);
  });

  it('takes as evidence only outcomes scoring can produce, and leaves out exactly the four that are not a given response', () => {
    for (const outcome of EVIDENCE_OUTCOMES) expect(CORRECTNESS_VALUES).toContain(outcome);
    const leftOut = CORRECTNESS_VALUES.filter((value) => !(EVIDENCE_OUTCOMES as readonly string[]).includes(value));
    expect([...leftOut].sort()).toEqual(['bonus', 'dropped', 'indeterminate', 'unattempted']);
  });
});
