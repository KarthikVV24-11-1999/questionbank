import { useEffect, useState, type JSX } from 'react';
import type { AttemptSession } from '../session/attempt-session.js';
import type { FormPackage, PackageSlot } from '../package/types.js';
import { TOKENS } from '../tokens.js';
import { Palette } from './Palette.js';
import { QuestionPane } from './QuestionPane.js';
import { ResultPane } from './ResultPane.js';
import { SyncIndicator } from './SyncIndicator.js';
import { TimerBadge } from './TimerBadge.js';
import { useSession } from './use-session.js';

/**
 * The sitting (ASSESSMENT-ENGINE §7): chrome-less. There is no site navigation and no link out — the only way off this screen is to submit.
 *
 * **It holds no attempt state.** Everything it shows comes from `useSession`'s snapshot, which is derived from the engine's values; every
 * choice goes to the session, which gives it to the engine. Local state in this tree is limited to things that are not the attempt (the
 * confirmation dialog), and a rule fails the build on a component that keeps an answer, a log, a timer or a sync flag of its own.
 */
export interface LearnAppProps {
  readonly session: AttemptSession;
  readonly form: FormPackage;
  /** Called on a timer by the host to say time has passed; the app only asks for it. */
  readonly onPump?: () => void;
}

export function LearnApp({ session, form }: LearnAppProps): JSX.Element {
  const snapshot = useSession(session);
  const slots: PackageSlot[] = form.sections.flatMap((section) => section.slots);
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
    return <ResultPane result={snapshot.result} onRefresh={() => void session.refreshResult()} />;
  }

  const current = slots.find((slot) => slot.slotId === snapshot.currentSlot) ?? null;
  const submitting = snapshot.phase === 'submitting';

  return (
    <div style={{ background: TOKENS.surface, color: TOKENS.textPrimary }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', padding: TOKENS.spaceSmall, borderBottom: `1px solid ${TOKENS.borderSubtle}` }}>
        <TimerBadge remainingMs={snapshot.remainingMs} />
        <SyncIndicator status={snapshot.sync} pending={snapshot.pending} onRetry={() => void session.syncNow()} />
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
          <SubmitControl onSubmit={() => void session.submit('manual')} unanswered={slots.filter((slot) => answers.get(slot.slotId)?.answer == null).length} />
        </main>
      )}
    </div>
  );
}

/** The one thing here that is the shell's own: whether the confirmation is open. It is not about the attempt. */
function SubmitControl({ onSubmit, unanswered }: { readonly onSubmit: () => void; readonly unanswered: number }): JSX.Element {
  const [confirming, setConfirming] = useState(false);
  if (!confirming) {
    return (
      <button type="button" onClick={() => setConfirming(true)} style={{ margin: TOKENS.spaceMedium }}>
        Submit paper
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
