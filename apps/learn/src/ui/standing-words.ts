import type { StandingDto } from '../api/learning-schemas.js';

/**
 * How a topic's standing is put to a learner (M8-29, FR-STU-04). A standing with enough answers behind it is said as a state; one without is said as what it is, *too early to say*, with the
 * lean the few answers have. The two are different sentences and never the same sentence with a hedge added, so a learner is not told they are weak on three answers.
 */
export const STATE_WORDS = { weak: 'Weak', developing: 'Developing', strong: 'Strong' } as const;

const answers = (count: number): string => `${count} ${count === 1 ? 'answer' : 'answers'}`;

export function standingLine(standing: StandingDto, evidenceCount: number): string {
  if (standing.kind === 'asserted') return `${STATE_WORDS[standing.state]}, from ${answers(evidenceCount)}`;
  if (standing.kind === 'tentative') return `Too early to say. ${answers(evidenceCount)} so far, leaning ${standing.leaning}`;
  return 'Not started';
}
