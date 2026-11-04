import type { JSX } from 'react';
import type { BootResult } from '../bootstrap.js';
import { screenHref } from './screen-context.js';
import { Root } from './Root.js';

/**
 * The practice run, sat (M8-24, closes D87; DEC-M8-15 in docs/IMPLEMENTATION-DECISIONS.md; what the screen does not do yet is D111 in docs/DEBT.md). It is the same screen a paper is sat on, one question at a time with the palette, the sync indicator and the confirmation before
 * it is finished, over a run's own package: the answers go into the response log the paper's go into, by the same writer, and are sent by the same session after the commit
 * that holds them. Nothing about delivery is rebuilt here; a second runtime for practice would have been the second set of bugs.
 *
 * What differs is stated, not hidden. A run has no clock, so none is shown and none submits it. It can be put down and picked up (the link above the question), which a paper cannot. It
 * is finished through the attempt routes like a paper, and its result is read the same way and says `pending` until it has been scored.
 */
export interface PracticeScreenProps {
  readonly boot: () => Promise<BootResult>;
  readonly every: (ms: number, fn: () => void) => () => void;
  readonly onOnline: (fn: () => void) => () => void;
  readonly onUpdateWanted?: () => void;
}

export function PracticeScreen({ boot, every, onOnline, onUpdateWanted }: PracticeScreenProps): JSX.Element {
  return <Root boot={boot} every={every} onOnline={onOnline} {...(onUpdateWanted === undefined ? {} : { onUpdateWanted })} leaveHref={screenHref({})} />;
}
