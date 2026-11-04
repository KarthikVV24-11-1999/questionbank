import { useEffect, type JSX } from 'react';
import type { Verdict as VerdictWord } from '../api/schemas.js';
import { useRemote } from './use-remote.js';

/**
 * What a learner is told of the answer they gave in a practice run (M8-33, ADR-0050): one word, from the server, and nothing the server would not say. Not the marks, not the right answer, not why. The words
 * are the screen's own for the server's four: right, wrong, and for an answer the server could not judge (`indeterminate`) that it is marked when the run is scored; for `unattempted` there is no answer to tell.
 *
 * **What cannot be fetched is not guessed.** A run can be sat with no connection, and then there is no verdict: the screen says that the answer is saved and will be marked, and that is all. It never shows a
 * word it did not get, and it does not wait on one: a request that fails or is given up on ends in that sentence, not in a spinner.
 */
export function Verdict({ ask, onTold }: { readonly ask: () => Promise<VerdictWord>; readonly onTold: (verdict: VerdictWord) => void }): JSX.Element | null {
  const remote = useRemote(ask);
  useEffect(() => {
    if (remote.status === 'loaded') onTold(remote.value);
  }, [remote.status]);
  if (remote.status === 'loading') return <p role="status">Checking your answer…</p>;
  if (remote.status === 'failed') return <p role="note">Your answer is saved. It is marked when you are back online, and in your result when you finish.</p>;
  if (remote.value === 'correct') return <p role="status">Right</p>;
  if (remote.value === 'incorrect') return <p role="status">Wrong</p>;
  if (remote.value === 'indeterminate') return <p role="note">This one is marked when the run is scored.</p>;
  return null;
}
