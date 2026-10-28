import type { JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import { TOKENS } from '../tokens.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { useRemote } from './use-remote.js';

/**
 * The practice run (M7-58), as far as the server lets a screen take it. A run is started by one tap and exists on the server with its questions chosen;
 * there is no route that gives a learner those questions or the slots to answer them in (D87), so this screen shows that the run has begun, how large it is,
 * and says plainly that its questions cannot be shown yet. It does not invent a way to show them.
 */
export function PracticeScreen({ assessment, attemptId, context }: { readonly assessment: Pick<AssessmentApi, 'getAttempt'>; readonly attemptId: string; readonly context: ScreenContext }): JSX.Element {
  const run = useRemote(() => assessment.getAttempt(attemptId));
  return (
    <main aria-label="Practice" style={{ padding: TOKENS.spaceMedium }}>
      <h1>Your practice run</h1>
      {run.status === 'loading' ? <p role="status">Opening your run…</p> : null}
      {run.status === 'failed' ? <p role="alert">{run.message}</p> : null}
      {run.status === 'loaded' && run.value.mode !== 'practice' ? <p role="alert">That is not a practice run.</p> : null}
      {run.status === 'loaded' && run.value.mode === 'practice' ? (
        <>
          <p>
            {run.value.slotCount} {run.value.slotCount === 1 ? 'question' : 'questions'} chosen for you. Your run is {run.value.state === 'in_progress' ? 'started' : run.value.state.replace('_', ' ')}.
          </p>
          <p role="note">The questions of a practice run cannot be shown in the app yet.</p>
        </>
      ) : null}
      <a href={screenHref({}, context)}>Back to what to do next</a>
    </main>
  );
}
