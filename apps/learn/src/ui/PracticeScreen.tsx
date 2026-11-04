import type { JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import type { Verdict } from '../api/schemas.js';
import type { BootResult } from '../bootstrap.js';
import { unreachable } from '../bootstrap.js';
import type { AnswerFacts } from '../practice/verdict-events.js';
import { screenHref } from './screen-context.js';
import { Root } from './Root.js';

/**
 * The practice run, sat (M8-24, closes D87; DEC-M8-15 in docs/IMPLEMENTATION-DECISIONS.md). It is the same screen a paper is sat on, one question at a time with the palette, the sync indicator and the confirmation before
 * it is finished, over a run's own package: the answers go into the response log the paper's go into, by the same writer, and are sent by the same session after the commit
 * that holds them. Nothing about delivery is rebuilt here; a second runtime for practice would have been the second set of bugs.
 *
 * What differs is stated, not hidden. A run has no clock, so none is shown and none submits it. It can be put down and picked up (the link above the question), which a paper cannot. It
 * is finished through the attempt routes like a paper, and its result is read the same way and says `pending` until it has been scored.
 *
 * **It tells the learner how an answer came out, and can be added to** (M8-33, closes D111; DEC-M8-20 in docs/IMPLEMENTATION-DECISIONS.md). The verdict is the one word the server serves for an answer it holds; with no
 * connection there is none, and the screen says the answer is saved and will be marked. Adding questions asks the server for more, then brings the run up again, which fetches the package the run now has and verifies it as the first was.
 */
export interface PracticeScreenProps {
  readonly boot: () => Promise<BootResult>;
  readonly every: (ms: number, fn: () => void) => () => void;
  readonly onOnline: (fn: () => void) => () => void;
  readonly onUpdateWanted?: () => void;
  readonly assessment: Pick<AssessmentApi, 'getPracticeFeedback' | 'growPracticeAttempt'>;
  readonly attemptId: string;
  /** The telling of a verdict to analytics, made once for the page (`practice/verdict-events.ts`). */
  readonly told: (slotId: string, answerKey: string, verdict: Verdict, facts: AnswerFacts) => void;
  /** Brings the page up on an address: how a run is opened again once it has more questions. */
  readonly onOpen: (href: string) => void;
}

/** How many questions one tap adds. */
export const QUESTIONS_ADDED = 5;

export function PracticeScreen({ boot, every, onOnline, onUpdateWanted, assessment, attemptId, told, onOpen }: PracticeScreenProps): JSX.Element {
  const practice = {
    feedback: (slotId: string) => assessment.getPracticeFeedback(attemptId, slotId),
    told,
    grow: async (): Promise<void> => {
      try {
        await assessment.growPracticeAttempt(attemptId, QUESTIONS_ADDED);
      } catch (error) {
        throw unreachable(error) ? new Error('More questions need a connection. Your run is as it was.') : error;
      }
      onOpen(screenHref({ practice: attemptId }));
    },
  };
  return <Root boot={boot} every={every} onOnline={onOnline} {...(onUpdateWanted === undefined ? {} : { onUpdateWanted })} leaveHref={screenHref({})} practice={practice} />;
}
