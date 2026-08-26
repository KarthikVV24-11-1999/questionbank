/// <reference lib="dom" />
import { useCallback, useEffect, useMemo, useState, type JSX } from 'react';
import { REJECTION_REASONS, type RejectionReasonCode } from '@questionbank/contracts/review-taxonomy';
import { useUndoBuffer } from './undo-buffer.js';
import type { DecisionSubmission, ReviewOutcome, ReviewerEdits } from './review-workspace-model.js';

/**
 * The decision bar (M4-39, DEC-M4-10, DEC-M4-11).
 *
 * **Four single-keystroke outcomes.** No shortcut for these four is named
 * in a ratified document, so this file names them once, here: `g` approve,
 * `e` approve with edits, `r` request changes, `j` reject — a sound,
 * reversible UI choice, not a domain fact, and deliberately disjoint from
 * every key `REJECTION_REASONS` uses (`f k a d s n x c l y`) — `a` would
 * otherwise collide with `AMBIGUOUS_STEM`'s own key the moment a reason
 * step is showing. The **rejection reason**, once a
 * non-approving outcome is chosen, is a second single keystroke read
 * straight from `REJECTION_REASONS` (`@questionbank/contracts/review-taxonomy`,
 * M4-06/M4-11) — never typed, never a second list.
 *
 * **Nothing reaches `onCommit` until the 5-second window elapses**
 * (`useUndoBuffer`). Pressing an outcome key only opens the draft — reason,
 * justification, the duplicate citation where `DUPLICATE` requires one —
 * and a separate, explicit commit (the `Commit decision` button, or Enter)
 * starts the countdown. Two affordances for everything: outcome selection
 * and commit are both a labelled button (mouse) and a keystroke (keyboard),
 * never only one.
 */

const OUTCOME_KEYS: Readonly<Record<string, ReviewOutcome>> = {
  g: 'approve',
  e: 'approve_with_edits',
  r: 'request_changes',
  j: 'reject',
};

const OUTCOME_LABELS: Readonly<Record<ReviewOutcome, string>> = {
  approve: 'Approve',
  approve_with_edits: 'Approve with edits',
  request_changes: 'Request changes',
  reject: 'Reject',
};

const NON_APPROVING: ReadonlySet<ReviewOutcome> = new Set(['request_changes', 'reject']);
const DUPLICATE_CODE: RejectionReasonCode = 'DUPLICATE';

export interface DecisionBarProps {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly assignmentId: string;
  readonly candidatesShownIds: readonly string[];
  readonly selectedDuplicateId: string | null;
  readonly pendingEdits: ReviewerEdits | null;
  readonly undoWindowMs?: number;
  readonly onCommit: (submission: DecisionSubmission) => void;
}

const DEFAULT_UNDO_WINDOW_MS = 5000;

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable;
}

export function DecisionBar(props: DecisionBarProps): JSX.Element {
  const { itemId, itemVersionId, assignmentId, candidatesShownIds, selectedDuplicateId, pendingEdits, onCommit } =
    props;
  const undoWindowMs = props.undoWindowMs ?? DEFAULT_UNDO_WINDOW_MS;

  const [outcome, setOutcome] = useState<ReviewOutcome | null>(null);
  const [reasonCode, setReasonCode] = useState<RejectionReasonCode | null>(null);
  const [justification, setJustification] = useState('');

  const undo = useUndoBuffer<DecisionSubmission>((submission) => onCommit(submission), undoWindowMs);

  const reset = useCallback((): void => {
    setOutcome(null);
    setReasonCode(null);
    setJustification('');
  }, []);

  const chooseOutcome = useCallback(
    (next: ReviewOutcome): void => {
      if (undo.pending !== null) return;
      setOutcome(next);
      setReasonCode(null);
      setJustification('');
    },
    [undo.pending],
  );

  const eligibleReasons = useMemo(() => {
    if (outcome === null || !NON_APPROVING.has(outcome)) return [];
    return REJECTION_REASONS.filter((reason) =>
      (reason.eligibleOutcomes as readonly string[]).includes(outcome),
    );
  }, [outcome]);

  const requiresJustification = outcome !== null && NON_APPROVING.has(outcome);
  const requiresDuplicateCitation = reasonCode === DUPLICATE_CODE;
  const canCommit =
    outcome !== null &&
    (!requiresJustification || justification.trim().length > 0) &&
    (!requiresJustification || reasonCode !== null) &&
    (!requiresDuplicateCitation || selectedDuplicateId !== null);

  const commit = useCallback((): void => {
    if (outcome === null || !canCommit) return;
    const submission: DecisionSubmission = {
      itemId,
      itemVersionId,
      assignmentId,
      outcome,
      candidatesShownIds,
      ...(requiresJustification ? { justification: justification.trim() } : {}),
      ...(reasonCode === null ? {} : { reasonCode }),
      ...(requiresDuplicateCitation && selectedDuplicateId !== null
        ? { duplicateOfItemId: selectedDuplicateId }
        : {}),
      ...(outcome === 'approve_with_edits' && pendingEdits !== null ? { edits: pendingEdits } : {}),
    };
    undo.hold(submission);
    reset();
  }, [
    outcome,
    canCommit,
    itemId,
    itemVersionId,
    assignmentId,
    candidatesShownIds,
    requiresJustification,
    justification,
    reasonCode,
    requiresDuplicateCitation,
    selectedDuplicateId,
    pendingEdits,
    undo,
    reset,
  ]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent): void {
      if (isTypingTarget(event.target)) {
        // Enter still commits even while the justification field has focus —
        // that is the one keystroke a reviewer typing a reason expects to work.
        if (event.key === 'Enter' && !event.shiftKey && outcome !== null && undo.pending === null) {
          event.preventDefault();
          commit();
        }
        return;
      }

      if (undo.pending !== null) {
        if (event.key.toLowerCase() === 'z' || event.key === 'Escape') {
          event.preventDefault();
          undo.undo();
        }
        return;
      }

      if (event.key === 'Enter' && outcome !== null) {
        event.preventDefault();
        commit();
        return;
      }

      const outcomeForKey = OUTCOME_KEYS[event.key.toLowerCase()];
      if (outcomeForKey !== undefined) {
        event.preventDefault();
        chooseOutcome(outcomeForKey);
        return;
      }

      if (outcome !== null && NON_APPROVING.has(outcome)) {
        const reason = eligibleReasons.find((candidate) => candidate.key === event.key.toLowerCase());
        if (reason !== undefined) {
          event.preventDefault();
          setReasonCode(reason.code);
        }
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [chooseOutcome, commit, eligibleReasons, outcome, undo]);

  return (
    <section aria-labelledby="decision-bar-heading">
      <h2 id="decision-bar-heading">Decision</h2>

      {undo.pending !== null ? (
        <div role="status">
          <p>{`${OUTCOME_LABELS[undo.pending.outcome]} — sending in ${Math.ceil(undo.remainingMs / 1000)}s`}</p>
          <button type="button" onClick={undo.undo}>
            Undo (Z)
          </button>
        </div>
      ) : (
        <>
          <div role="group" aria-label="Outcome">
            {(Object.entries(OUTCOME_KEYS) as [string, ReviewOutcome][]).map(([key, value]) => (
              <button
                key={value}
                type="button"
                aria-pressed={outcome === value}
                onClick={() => chooseOutcome(value)}
              >
                {`${OUTCOME_LABELS[value]} (${key.toUpperCase()})`}
              </button>
            ))}
          </div>

          {outcome !== null && NON_APPROVING.has(outcome) ? (
            <div role="group" aria-label="Reason">
              {eligibleReasons.map((reason) => (
                <button
                  key={reason.code}
                  type="button"
                  aria-pressed={reasonCode === reason.code}
                  onClick={() => setReasonCode(reason.code)}
                >
                  {`${reason.code.replace(/_/gu, ' ')} (${reason.key.toUpperCase()})`}
                </button>
              ))}
              {requiresDuplicateCitation && selectedDuplicateId === null ? (
                <p role="alert">Select a duplicate candidate below before this decision can be sent.</p>
              ) : null}

              <label htmlFor="decision-justification">Justification</label>
              <textarea
                id="decision-justification"
                value={justification}
                onChange={(event) => setJustification(event.target.value)}
                required
              />
            </div>
          ) : null}

          {outcome !== null ? (
            <button type="button" onClick={commit} disabled={!canCommit}>
              Commit decision (Enter)
            </button>
          ) : null}
        </>
      )}
    </section>
  );
}
