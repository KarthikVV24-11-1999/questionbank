import type { AnswerFacts } from '../practice/verdict-events.js';
import type { Verdict } from '../api/schemas.js';

/**
 * What the sitting of a practice run is given beyond a paper's (M8-33): the server's word on an answer, the telling of it to analytics, and the means of adding questions to the run. A paper is given none of
 * them, which is what makes it a paper: its answers are not judged while it is open.
 */
export interface PracticeLinks {
  /** The server's verdict on the answer the slot now holds. Rejects when it cannot be had. */
  readonly feedback: (slotId: string) => Promise<Verdict>;
  /** The learner has been told a verdict for an answer: once for each answer, whoever asks how often. */
  readonly told: (slotId: string, answerKey: string, verdict: Verdict, facts: AnswerFacts) => void;
  /** Adds questions to the run and brings the screen up on the run as it now is, with the package it now has, verified as the first was. Rejects with words for the learner. */
  readonly grow: () => Promise<void>;
}
