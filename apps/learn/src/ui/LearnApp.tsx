import { useEffect, useState, type JSX } from 'react';
import type { AttemptSession } from '../session/attempt-session.js';
import type { Paper, SittableSlot } from '../package/types.js';
import { TOKENS } from '../tokens.js';
import { Palette } from './Palette.js';
import type { PracticeLinks } from './practice-links.js';
import { QuestionPane } from './QuestionPane.js';
import { ResultPane } from './ResultPane.js';
import { SyncIndicator } from './SyncIndicator.js';
import { TimerBadge } from './TimerBadge.js';
import { useSession } from './use-session.js';
import { Verdict } from './Verdict.js';
import { useAction } from './use-remote.js';

/**
 * The sitting (ASSESSMENT-ENGINE §7): chrome-less. There is no site navigation and no link out — the only way off this screen is to submit.
 *
 * **It holds no attempt state.** Everything it shows comes from `useSession`'s snapshot, which is derived from the engine's values; every
 * choice goes to the session, which gives it to the engine. Local state in this tree is limited to things that are not the attempt (the
 * confirmation dialog), and a rule fails the build on a component that keeps an answer, a log, a timer or a sync flag of its own.
 */
export interface LearnAppProps {
  readonly session: AttemptSession;
  readonly form: Paper;
  /** Where a practice run is put down: given, the screen offers the way off it and back (a paper has none, and the only way off it is to submit). */
  readonly leaveHref?: string;
  /** Given for a practice run, whose answers are judged while it is open and which can be added to; a paper has none of it. */
  readonly practice?: PracticeLinks;
  /** Called on a timer by the host to say time has passed; the app only asks for it. */
  readonly onPump?: () => void;
}

export function LearnApp({ session, form, leaveHref, practice }: LearnAppProps): JSX.Element {
  const snapshot = useSession(session);
  const slots: SittableSlot[] = form.sections.flatMap((section) => section.slots);
  const stimuli = new Map(form.stimuli.map((entry) => [entry.stimulusVersionId, entry.view.body]));
  const answers = new Map(snapshot.projection.slots.map((entry) => [entry.slot, entry]));

  // A first question is shown by visiting it, which is an event in the log like any other.
  const first = slots[0]?.slotId;
  useEffect(() => {
    if (snapshot.phase === 'in_progress' && snapshot.currentSlot === null && first !== undefined && snapshot.projection.slots.length === 0) session.goTo(first);
    // only when nothing has happened yet
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (snapshot.phase === 'submitted') {
    return (
      <>
        <ResultPane result={snapshot.result} onRefresh={() => void session.refreshResult()} />
        {leaveHref === undefined ? null : (
          <p style={{ padding: TOKENS.spaceMedium }}>
            <a href={leaveHref}>Back to what to do next</a>
          </p>
        )}
      </>
    );
  }

  const current = slots.find((slot) => slot.slotId === snapshot.currentSlot) ?? null;
  const submitting = snapshot.phase === 'submitting';

  return (
    <div style={{ background: TOKENS.surface, color: TOKENS.textPrimary }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: TOKENS.spaceSmall, borderBottom: `1px solid ${TOKENS.borderSubtle}` }}>
        {snapshot.remainingMs === null ? (
          leaveHref === undefined ? null : <a href={leaveHref}>Put this run down</a>
        ) : (
          <TimerBadge remainingMs={snapshot.remainingMs} />
        )}
        <SyncIndicator status={snapshot.sync} pending={snapshot.pending} unsaved={snapshot.unsaved} storageError={snapshot.storageError} onRetry={() => void session.syncNow()} />
      </header>

      {submitting ? (
        <p role="status" style={{ padding: TOKENS.spaceMedium }}>
          Submitting your paper… {snapshot.submissionNote ?? 'Your answers are being sent first.'}
        </p>
      ) : (
        <main>
          {current === null ? (
            <p style={{ padding: TOKENS.spaceMedium }}>Choose a question.</p>
          ) : (
            <QuestionPane
              slot={current}
              stimulus={current.stimulusVersionId === undefined ? undefined : stimuli.get(current.stimulusVersionId)}
              answer={answers.get(current.slotId)?.answer ?? null}
              onAnswer={(answer) => session.select(current.slotId, answer)}
              onClear={() => session.clear(current.slotId)}
            />
          )}
          {practice === undefined || current === null ? null : <Judged practice={practice} slotId={current.slotId} answered={answers.get(current.slotId)} saved={snapshot.pending === 0 && snapshot.unsaved === 0} />}
          <div style={{ padding: TOKENS.spaceSmall }}>
            {current === null ? null : (
              <button type="button" onClick={() => session.flag(current.slotId, !session.isFlagged(current.slotId))}>
                {session.isFlagged(current.slotId) ? 'Remove flag' : 'Flag for review'}
              </button>
            )}
          </div>
          <Palette
            entries={slots.map((slot) => ({
              slot,
              answered: answers.get(slot.slotId)?.answer != null,
              flagged: answers.get(slot.slotId)?.flagged ?? false,
              current: slot.slotId === snapshot.currentSlot,
            }))}
            onGo={(slotId) => session.goTo(slotId)}
          />
          {practice === undefined ? null : <GrowControl grow={practice.grow} />}
          <SubmitControl label={snapshot.remainingMs === null ? 'Finish run' : 'Submit paper'} onSubmit={() => void session.submit('manual')} unanswered={slots.filter((slot) => answers.get(slot.slotId)?.answer == null).length} />
        </main>
      )}
    </div>
  );
}

/** The one thing here that is the shell's own: whether the confirmation is open. It is not about the attempt. */
function SubmitControl({ label, onSubmit, unanswered }: { readonly label: string; readonly onSubmit: () => void; readonly unanswered: number }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} style={{ margin: TOKENS.spaceMedium }}>
        {label}
      </button>
    );
  }
  return (
    <div role="alertdialog" aria-label="Confirm submission" style={{ padding: TOKENS.spaceMedium }}>
      <p>
        Submit now?{unanswered > 0 ? ` ${unanswered} question${unanswered === 1 ? ' is' : 's are'} not answered.` : ''} You cannot change your answers afterwards.
      </p>
      <button type="button" onClick={onSubmit}>
        Yes, submit
      </button>{' '}
      <button type="button" onClick={() => setConfirming(false)}>
        Keep working
      </button>
    </div>
  );
}

/**
 * The verdict on the answer in front of the learner, when there is an answer and the server has it. An answer still on this device (not yet sent, or not yet on the disk) has nothing to be judged by, so it is not
 * asked about and the screen says it is saved; asking early would be answered "unattempted", which is a wrong word for an answer that was given. The verdict is asked for again when the answer changes, and not
 * otherwise: a changed answer is an event not yet sent, which unmounts this until it has been, and then the verdict is asked for afresh. Nothing here remembers the old one.
 */
function Judged({
  practice,
  slotId,
  answered,
  saved,
}: {
  readonly practice: PracticeLinks;
  readonly slotId: string;
  readonly answered: { readonly answer: unknown; readonly timeOnItemMs: number; readonly answerChanges: number; readonly flagged: boolean } | undefined;
  readonly saved: boolean;
}): JSX.Element | null {
  if (answered === undefined || answered.answer == null) return null;
  if (!saved) return <p role="note">Your answer is saved on this device. It is marked once it has been sent.</p>;
  const answerKey = JSON.stringify(answered.answer);
  return (
    <Verdict
      key={slotId}
      ask={() => practice.feedback(slotId)}
      onTold={(verdict) => practice.told(slotId, answerKey, verdict, { timeOnItemMs: answered.timeOnItemMs, answerChanges: answered.answerChanges, flagged: answered.flagged })}
    />
  );
}

/** One action that adds questions to the run. It succeeds by bringing the run up again with the questions it now has; it fails in words, and the run goes on as it was. */
function GrowControl({ grow }: { readonly grow: () => Promise<void> }): JSX.Element {
  const action = useAction(grow, () => undefined);
  return (
    <div style={{ padding: TOKENS.spaceSmall }}>
      <button type="button" onClick={action.go} disabled={action.busy}>
        {action.busy ? 'Adding questions…' : 'Add more questions'}
      </button>
      {action.failure === null ? null : <p role="alert">{action.failure}</p>}
    </div>
  );
}
