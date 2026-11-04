import type { JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import type { ExamPins } from '../home/exam-pins.js';
import { startDiagnosticOn } from '../practice/start-practice.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { useAction } from './use-remote.js';

/**
 * The one tap that starts the diagnostic (M8-32): a short run taken across what the learner has studied, made and started the way any run is, and opened by the host. It is the practice-run route with the
 * breadth strategy, so the event it says is the practice run starting, recommended, and naming no topic: the server chooses them, one for each, and the learner is told which when they answer.
 */
export function DiagnosticButton({
  exam,
  assessment,
  context,
  onOpen,
}: {
  readonly exam: ExamPins | null;
  readonly assessment: Pick<AssessmentApi, 'createDiagnosticAttempt' | 'startAttempt'>;
  readonly context: ScreenContext;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const action = useAction(
    () => startDiagnosticOn(assessment, { examProfileVersionId: (exam as ExamPins).examProfileVersionId, idempotencyKey: `${context.pageKey}:diagnostic` }),
    (run) => {
      context.analytics.emit('practice.session_started', { selection_strategy: 'breadth', source: 'recommendation', concept_ids: [], item_count: run.slotCount }, { attempt_id: run.attemptId });
      onOpen(screenHref({ practice: run.attemptId }));
    },
  );
  if (exam === null) {
    return (
      <p role="note">
        Choose your exam first. <a href={screenHref({ onboarding: true })}>Choose it now</a>
      </p>
    );
  }
  return (
    <>
      <button type="button" onClick={action.go} disabled={action.busy}>
        {action.busy ? 'Starting…' : 'Start'}
      </button>
      {action.failure === null ? null : <p role="alert">{action.failure}</p>}
    </>
  );
}
