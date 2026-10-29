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
  source,
  finding,
  assessment,
  context,
  onOpen,
}: {
  readonly conceptIdentityId: string;
  readonly label: string;
  /** Why the learner is being offered this: the report's finding (`remediation`), or the home screen's next action (`recommendation`). */
  readonly source: 'remediation' | 'recommendation';
  /** Set where the tap is on a report's finding: its rank, and when the score it is a finding of was computed. */
  readonly finding?: { readonly rank: number; readonly resultAt: string | null };
  readonly assessment: Pick<AssessmentApi, 'createPracticeAttempt' | 'startAttempt'>;
  readonly context: ScreenContext;
  readonly onOpen: (href: string) => void;
}): JSX.Element {
  const action = useAction(
    () => startPracticeOn(assessment, { examProfileVersionId: context.examProfileVersionId as string, conceptIdentityId, idempotencyKey: `${context.pageKey}:${conceptIdentityId}` }),
    (run) => {
      context.analytics.emit(
        'practice.session_started',
        { selection_strategy: 'filtered', source, concept_ids: [conceptIdentityId], item_count: run.slotCount },
        { attempt_id: run.attemptId, concept_identity_id: conceptIdentityId },
      );
      onOpen(screenHref({ practice: run.attemptId }, context));
    },
  );
  const tap = (): void => {
    if (finding !== undefined) {
      const since = finding.resultAt === null ? Number.NaN : (context.analytics.nowMs() - Date.parse(finding.resultAt)) / 3_600_000;
      const hours = Number.isFinite(since) ? Math.max(0, Math.round(since * 100) / 100) : null;
      context.analytics.emit('mock.remediation_clicked', { finding_rank: finding.rank, hours_after_result: hours }, { concept_identity_id: conceptIdentityId });
    }
    action.go();
  };
  if (context.examProfileVersionId === null) return <p role="note">This page was opened without an exam profile, so a practice run cannot be made from it.</p>;
  return (
    <>
      <button type="button" onClick={tap} disabled={action.busy}>
        {action.busy ? 'Starting…' : label}
      </button>
      {action.failure === null ? null : <p role="alert">{action.failure}</p>}
    </>
  );
}
