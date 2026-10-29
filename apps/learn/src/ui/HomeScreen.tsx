import type { JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import type { LearningApi } from '../api/learning-api.js';
import { chooseNextAction, type NextAction } from '../home/next-action.js';
import { TOKENS } from '../tokens.js';
import { PractiseButton } from './PractiseButton.js';
import { conceptLabel, screenHref, type ScreenContext } from './screen-context.js';
import { useRemote } from './use-remote.js';

const WHY: Record<'escalated' | 'due' | 'weakest', string> = {
  escalated: 'This concept keeps slipping, so more of the same will not fix it. Work on it directly.',
  due: 'This concept is due for review.',
  weakest: 'This is the concept you are weakest on.',
};

function Action({ action, assessment, context, onOpen }: { readonly action: NextAction; readonly assessment: Pick<AssessmentApi, 'createPracticeAttempt' | 'startAttempt'>; readonly context: ScreenContext; readonly onOpen: (href: string) => void }): JSX.Element {
  if (action.kind === 'practise') {
    return (
      <>
        <h2>{conceptLabel(action.conceptIdentityId)}</h2>
        <p>{WHY[action.why]}</p>
        <PractiseButton conceptIdentityId={action.conceptIdentityId} label="Practise this" source="recommendation" assessment={assessment} context={context} onOpen={onOpen} />
      </>
    );
  }
  if (action.kind === 'read-report') {
    return (
      <>
        <h2>Your last paper</h2>
        <p>Your report is ready.</p>
        <a href={screenHref({ report: action.attemptId }, context)}>Read your report</a>
      </>
    );
  }
  return <p>There is nothing to do right now. When you have sat a paper, what to work on next appears here.</p>;
}

/** The screen a learner opens (M7-57): one next action, chosen by the server's answers, and not a list of everything available. */
export function HomeScreen({
  learning,
  assessment,
  context,
  onOpen,
}: {
  readonly learning: LearningApi;
  readonly assessment: Pick<AssessmentApi, 'createPracticeAttempt' | 'startAttempt'>;
  readonly context: ScreenContext;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const next = useRemote(() => chooseNextAction({ learning, taxonomyVersionId: context.taxonomyVersionId, lastAttemptId: context.lastAttemptId }));
  return (
    <main aria-label="Home" style={{ padding: TOKENS.spaceMedium }}>
      <h1>What to do next</h1>
      {next.status === 'loading' ? <p role="status">Looking at where you are…</p> : null}
      {next.status === 'failed' ? <p role="alert">{next.message}</p> : null}
      {next.status === 'loaded' ? <Action action={next.value} assessment={assessment} context={context} onOpen={onOpen} /> : null}
    </main>
  );
}
