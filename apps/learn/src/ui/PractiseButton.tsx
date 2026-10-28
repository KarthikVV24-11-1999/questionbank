import type { JSX } from 'react';
import type { AssessmentApi } from '../api/assessment-api.js';
import { startPracticeOn } from '../practice/start-practice.js';
import { screenHref, type ScreenContext } from './screen-context.js';
import { useAction } from './use-remote.js';

/**
 * The one tap (M7-58): pressing it makes a practice run about the concept and starts it, and the host then opens the run. Without an exam profile there is
 * nothing a run can be made under, and the button says so instead of making a request that can only fail.
 */
export function PractiseButton({
  conceptIdentityId,
  label,
  assessment,
  context,
  onOpen,
}: {
  readonly conceptIdentityId: string;
  readonly label: string;
  readonly assessment: Pick<AssessmentApi, 'createPracticeAttempt' | 'startAttempt'>;
  readonly context: ScreenContext;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const action = useAction(
    () => startPracticeOn(assessment, { examProfileVersionId: context.examProfileVersionId as string, conceptIdentityId, idempotencyKey: `${context.pageKey}:${conceptIdentityId}` }),
    (run) => onOpen(screenHref({ practice: run.attemptId }, context)),
  );
  if (context.examProfileVersionId === null) return <p role="note">This page was opened without an exam profile, so a practice run cannot be made from it.</p>;
  return (
    <>
      <button type="button" onClick={action.go} disabled={action.busy}>
        {action.busy ? 'Starting…' : label}
      </button>
      {action.failure === null ? null : <p role="alert">{action.failure}</p>}
    </>
  );
}
