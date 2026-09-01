import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { DecisionBar } from './DecisionBar.js';
import type { DecisionSubmission } from './review-workspace-model.js';

/**
 * The decision bar (M4-39, DEC-M4-10, DEC-M4-11). Every test drives real
 * keyboard events (`userEvent.keyboard`) or real clicks — never calls into
 * `DecisionBar`'s internals — because keystroke/mouse parity is the thing
 * under test, not an implementation detail either could fake past.
 */

function renderBar(overrides: Partial<Parameters<typeof DecisionBar>[0]> = {}) {
  const commits: DecisionSubmission[] = [];
  const utils = render(
    <DecisionBar
      itemId="item-1"
      itemVersionId="version-1"
      assignmentId="assignment-1"
      candidatesShownIds={['cand-1']}
      selectedDuplicateId={null}
      pendingEdits={null}
      undoWindowMs={20}
      onCommit={(submission) => commits.push(submission)}
      {...overrides}
    />,
  );
  return { ...utils, commits };
}

describe('four single-keystroke outcomes (M4-39)', () => {
  it('selects Approve by key and by click, identically', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard('g');
    expect(screen.getByRole('button', { name: 'Approve (G)' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('selects each outcome by its own key', async () => {
    const user = userEvent.setup();
    const cases: readonly [string, string][] = [
      ['g', 'Approve (G)'],
      ['e', 'Approve with edits (E)'],
      ['r', 'Request changes (R)'],
      ['j', 'Reject (J)'],
    ];
    for (const [key, label] of cases) {
      const { unmount } = renderBar();
      await user.keyboard(key);
      expect(screen.getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
      unmount();
    }
  });

  it('selects Reject by clicking the button too — mouse and keyboard parity', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.click(screen.getByRole('button', { name: 'Reject (J)' }));
    expect(screen.getByRole('button', { name: 'Reject (J)' })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('the rejection reason is chosen by key, from the shared taxonomy (M4-06, M4-11)', () => {
  it('lists only the reasons eligible for the chosen outcome', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard('r'); // request_changes
    expect(screen.getByRole('button', { name: /AMBIGUOUS STEM \(A\)/u })).toBeInTheDocument();
    // DUPLICATE is reject-only — not offered under request_changes.
    expect(screen.queryByRole('button', { name: /DUPLICATE/u })).toBeNull();
  });

  it('selects a reason by its key', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard('j'); // reject
    await user.keyboard('s'); // OUT_OF_SYLLABUS
    expect(screen.getByRole('button', { name: /OUT OF SYLLABUS \(S\)/u })).toHaveAttribute('aria-pressed', 'true');
  });
});

describe('justification is required on every non-approving outcome (M4-39)', () => {
  it('leaves Commit disabled until justification is typed, for request_changes', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard('r');
    await user.keyboard('a'); // AMBIGUOUS_STEM
    expect(screen.getByRole('button', { name: 'Commit decision (Enter)' })).toBeDisabled();

    await user.type(screen.getByLabelText('Justification'), 'The stem does not say frictionless.');
    expect(screen.getByRole('button', { name: 'Commit decision (Enter)' })).toBeEnabled();
  });

  it('never disables Commit for a plain approve, which takes no justification', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard('g');
    expect(screen.getByRole('button', { name: 'Commit decision (Enter)' })).toBeEnabled();
  });
});

describe('DUPLICATE cannot be submitted without a selected candidate (M4-39)', () => {
  it('leaves Commit disabled with DUPLICATE chosen and no citation', async () => {
    const user = userEvent.setup();
    renderBar({ selectedDuplicateId: null });
    await user.keyboard('j'); // reject
    await user.keyboard('d'); // DUPLICATE
    await user.type(screen.getByLabelText('Justification'), 'Same question as another item.');
    expect(screen.getByRole('button', { name: 'Commit decision (Enter)' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('Select a duplicate candidate');
  });

  it('enables Commit once a citation is selected, and sends it as duplicateOfItemId', async () => {
    const user = userEvent.setup();
    const { commits } = renderBar({ selectedDuplicateId: 'other-item-9' });
    await user.keyboard('j');
    await user.keyboard('d');
    await user.type(screen.getByLabelText('Justification'), 'Same question as another item.');
    expect(screen.getByRole('button', { name: 'Commit decision (Enter)' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));
    await waitFor(() => expect(commits).toHaveLength(1));
    expect(commits[0]?.duplicateOfItemId).toBe('other-item-9');
    expect(commits[0]?.reasonCode).toBe('DUPLICATE');
  });
});

/**
 * The undo window is the one behaviour here made of wall-clock time, so it is
 * the one place these tests drive the clock instead of racing it.
 *
 * The earlier shape — a 20 ms window, an `await user.click(Undo)`, then a
 * 40 ms sleep — asserted the right thing on a machine that happened to be fast
 * enough. It is not a valid assertion: nothing bounds how long `user.click`
 * takes, and on a loaded CI runner the window elapsed *between* the commit
 * click and the undo meant to cancel it, so the commit that arrived was
 * correct behaviour reported as a failure.
 *
 * Fake timers remove the race and strengthen the claim in the same move. Where
 * the old test waited 40 ms past a 20 ms window, these advance a full minute
 * past a 5 s one — "undo cancels the send" now means cancelled for good, not
 * merely not-yet-sent.
 */
describe('the undo window (DEC-M4-10)', () => {
  /**
   * Half a minute, and nothing here waits it out.
   *
   * `shouldAdvanceTime` keeps the fake clock moving in step with the real one,
   * so `userEvent`'s own delays still resolve — a click costs the window the
   * few milliseconds it actually took, out of thirty thousand. Elapsing the
   * rest is instant, which is what buys the margin: a click would have to hang
   * for a full second to eat 1/30th of the window.
   */
  const WINDOW_MS = 30_000;

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function setup(overrides: Partial<Parameters<typeof DecisionBar>[0]> = {}) {
    const user = userEvent.setup();
    return { user, ...renderBar({ undoWindowMs: WINDOW_MS, ...overrides }) };
  }

  function elapse(ms: number): void {
    act(() => {
      vi.advanceTimersByTime(ms);
    });
  }

  it('sends nothing while the window is counting down', async () => {
    const { user, commits } = setup();
    await user.keyboard('g');
    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));
    expect(screen.getByRole('status')).toHaveTextContent(/sending in/u);
    expect(commits).toHaveLength(0);

    elapse(WINDOW_MS - 1_000); // Deep into the window, still short of sending.
    expect(commits).toHaveLength(0);
  });

  it('undo inside the window sends nothing, asserted at the client boundary', async () => {
    const { user, commits } = setup();
    await user.keyboard('g');
    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));

    elapse(WINDOW_MS - 1_000);
    await user.click(screen.getByRole('button', { name: 'Undo (Z)' }));

    // Long past where the send would have fired: cancelled, not merely pending.
    elapse(WINDOW_MS * 10);
    expect(commits).toHaveLength(0);
    // Back to a fresh draft — no outcome pre-selected.
    expect(screen.getByRole('button', { name: 'Approve (G)' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('undo by the Z key works too — keyboard parity with the Undo button', async () => {
    const { user, commits } = setup();
    await user.keyboard('g');
    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));

    elapse(WINDOW_MS - 1_000);
    await user.keyboard('z');

    elapse(WINDOW_MS * 10);
    expect(commits).toHaveLength(0);
  });

  it('elapsing the window sends exactly one request', async () => {
    const { user, commits } = setup();
    await user.keyboard('g');
    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));

    elapse(WINDOW_MS);
    expect(commits).toHaveLength(1);
    expect(commits[0]?.outcome).toBe('approve');

    // Exactly one: the interval driving the countdown must not re-fire it.
    elapse(WINDOW_MS * 10);
    expect(commits).toHaveLength(1);
  });

  it('the countdown is visible while it runs', async () => {
    const { user } = setup({ undoWindowMs: 500 });
    await user.keyboard('g');
    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));
    expect(screen.getByRole('status').textContent).toMatch(/sending in \ds/u);
  });
});

describe('every keystroke is announced to assistive technology', () => {
  it('the pending decision is a live status region', async () => {
    const user = userEvent.setup();
    renderBar();
    await user.keyboard('g');
    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));
    expect(screen.getByRole('status')).toBeInTheDocument();
  });

  it('the citation requirement is announced as an alert', async () => {
    const user = userEvent.setup();
    renderBar({ selectedDuplicateId: null });
    await user.keyboard('j');
    await user.keyboard('d');
    expect(screen.getByRole('alert')).toBeInTheDocument();
  });
});

describe('accessibility (FRONTEND §7, §10)', () => {
  it('scans clean at the outcome-choice step', () => {
    const { container } = renderBar();
    return accessibilityViolations(container).then((violations) => expect(violations).toEqual([]));
  });

  it('scans clean with a reason and justification field showing', async () => {
    const user = userEvent.setup();
    const { container } = renderBar();
    await user.keyboard('r');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean while the undo countdown is running', async () => {
    const user = userEvent.setup();
    const { container } = renderBar({ undoWindowMs: 5000 });
    await user.keyboard('g');
    await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
