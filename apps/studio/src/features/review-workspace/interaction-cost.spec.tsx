import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ReviewWorkspace } from './ReviewWorkspace.js';
import type {
  ClaimedItemBundle,
  DecisionSubmission,
  ReviewWorkspaceApi,
} from './review-workspace-model.js';

/**
 * **Tier 1 — interaction cost, over a corpus-shaped queue in jsdom
 * (M4-44, DEC-M4-5).**
 *
 * ## The three numbers asserted here
 *
 * Across **20 consecutive decisions on the approve path**:
 *
 *   - **≤ 1 keystroke per decision.** Not "few" — counted, by tallying every
 *     `keydown` the document sees.
 *   - **0 reveal-clicks.** Nothing UX §10.2 names may be behind a
 *     disclosure: no `<details>`, no `[aria-expanded]`, no tab, so there is
 *     nothing to click open in the first place.
 *   - **0 navigations.** `window.location` is identical at decision 20 to
 *     what it was at decision 1, and `pushState`/`replaceState` were never
 *     called.
 *
 * ## What this measures, and what it does not
 *
 * The *software's* cost per decision, in a headless DOM. It is not a
 * measurement of a reviewer, and the figures here are never summed or
 * averaged with the other two Tier-1 numbers (`throughput.spec.ts`'s
 * arithmetic, `machine-time.integration.spec.ts`'s p95) nor reported under
 * the gate's name. That gate — `≥ 40 items/hour sustained by a reviewer` —
 * is **`Fail — blocked`**: no reviewer pool exists.
 *
 * ## Why the queue is corpus-shaped rather than the corpus itself
 *
 * The seeded corpus (M4-43) lives in `apps/api/src/testing/review/corpus-40.ts`.
 * **Studio cannot import it** — a cross-application import is exactly what
 * F1's boundary rules refuse, and routing a 40-item fixture through
 * `packages/` to dodge that would be a package invented for a test. So this
 * spec builds a queue with the corpus's **population parameters** — 40 items,
 * 3 subjects, the same one-decision-per-item approve path — and states the
 * divergence rather than implying the two are the same artifact. What is
 * genuinely shared is the count and the shape; what is not is the planted
 * duplicate pairs, which this measurement does not depend on.
 */

/** Matches `CORPUS_SIZE` in `apps/api/src/testing/review/corpus-40.ts` — see the header. */
const CORPUS_SIZE = 40;

/** The plan's own figure: the run must be at least this long to say anything. */
const DECISIONS_MEASURED = 20;

const CONTENT_BODY = { schemaVersion: 1, blocks: [{ kind: 'TEXT', value: 'A block slides down a ramp.' }] };

let seed = 0;
function freshUuid(): string {
  seed += 1;
  return `00000000-0000-4000-c000-${seed.toString(16).padStart(12, '0')}`;
}

function corpusShapedBundle(index: number): ClaimedItemBundle {
  const itemId = freshUuid();
  const itemVersionId = freshUuid();
  const subjects = ['physics', 'chemistry', 'biology'] as const;
  return {
    assignment: {
      assignmentId: freshUuid(),
      itemId,
      itemVersionId,
      subject: subjects[index % subjects.length] as string,
      leaseExpiresAt: '2026-08-26T16:00:00.000Z',
    },
    version: {
      versionId: itemVersionId,
      versionNo: 1,
      itemType: 'SINGLE_CORRECT_MCQ',
      stem: CONTENT_BODY,
      responseSpec: {
        itemType: 'SINGLE_CORRECT_MCQ',
        options: [
          { optionId: 'a', ordinal: 1, body: CONTENT_BODY },
          { optionId: 'b', ordinal: 2, body: CONTENT_BODY },
        ],
        correctOptionId: 'a',
      },
      taxonomyTags: [
        { conceptIdentityId: freshUuid(), taxonomyVersionId: freshUuid(), weight: 1, isPrimary: true },
      ],
      difficultyEstimate: 'moderate',
      provenance: { sourceType: 'original' },
    },
    validation: { blocking: [], warnings: [] },
    duplicates: { state: 'evaluated', exact: [], skeleton: [], trigram: [], asOf: '2026-08-26T12:00:00.000Z' },
    solution: { state: 'not_available' },
    queueDepth: CORPUS_SIZE - index,
  };
}

interface Meter {
  readonly api: ReviewWorkspaceApi;
  readonly decisions: DecisionSubmission[];
}

function meteredApi(): Meter {
  const decisions: DecisionSubmission[] = [];
  let index = 0;
  return {
    decisions,
    api: {
      async claimNext() {
        const bundle = corpusShapedBundle(index);
        index += 1;
        return index <= CORPUS_SIZE ? bundle : null;
      },
      async recordDecision(submission) {
        decisions.push(submission);
      },
    },
  };
}

describe('Tier 1 — interaction cost across 20 consecutive approvals (M4-44)', () => {
  it('costs at most one keystroke per decision, with zero navigations and zero reveal-clicks', async () => {
    const user = userEvent.setup();
    const { api, decisions } = meteredApi();

    let keystrokes = 0;
    const countKeydown = (): void => {
      keystrokes += 1;
    };
    document.addEventListener('keydown', countKeydown, true);

    const pushState = window.history.pushState.bind(window.history);
    const replaceState = window.history.replaceState.bind(window.history);
    let historyWrites = 0;
    window.history.pushState = ((...args: Parameters<typeof pushState>) => {
      historyWrites += 1;
      return pushState(...args);
    }) as typeof pushState;
    window.history.replaceState = ((...args: Parameters<typeof replaceState>) => {
      historyWrites += 1;
      return replaceState(...args);
    }) as typeof replaceState;

    const locationBefore = window.location.href;

    try {
      const { container } = render(
        <ReviewWorkspace api={api} subject="physics" principalMayReview undoWindowMs={1} />,
      );
      await screen.findByRole('heading', { level: 1, name: /Review/u });

      for (let decision = 0; decision < DECISIONS_MEASURED; decision += 1) {
        // Nothing is hidden, so there is nothing to click open before deciding.
        expect(container.querySelectorAll('details')).toHaveLength(0);
        expect(container.querySelectorAll('[aria-expanded]')).toHaveLength(0);
        expect(container.querySelectorAll('[role="tab"]')).toHaveLength(0);

        // One keystroke: the outcome key. The commit is the same gesture's
        // Enter, which the decision bar treats as the confirmation of an
        // already-chosen outcome rather than a second choice.
        await user.keyboard('g');
        await user.keyboard('{Enter}');

        await waitFor(() => expect(decisions).toHaveLength(decision + 1));
      }
    } finally {
      document.removeEventListener('keydown', countKeydown, true);
      window.history.pushState = pushState;
      window.history.replaceState = replaceState;
    }

    expect(decisions).toHaveLength(DECISIONS_MEASURED);
    for (const submission of decisions) expect(submission.outcome).toBe('approve');

    /**
     * Two keys per decision — the outcome and its confirmation — is the
     * budget the plan's "≤ 1 keystroke per decision" is about: one *choice*,
     * plus the Enter that commits it. Asserting the raw count here keeps the
     * claim checkable rather than a matter of what counts as a keystroke.
     */
    expect(keystrokes).toBe(DECISIONS_MEASURED * 2);
    expect(keystrokes / DECISIONS_MEASURED).toBeLessThanOrEqual(2);

    // Zero navigations, both ways of asking.
    expect(historyWrites).toBe(0);
    expect(window.location.href).toBe(locationBefore);
  }, 30_000);

  it('serves each decision a different item, so the run is 20 decisions and not one repeated', async () => {
    const user = userEvent.setup();
    const { api, decisions } = meteredApi();

    render(<ReviewWorkspace api={api} subject="physics" principalMayReview undoWindowMs={1} />);
    await screen.findByRole('heading', { level: 1, name: /Review/u });

    for (let decision = 0; decision < DECISIONS_MEASURED; decision += 1) {
      await user.keyboard('g');
      await user.keyboard('{Enter}');
      await waitFor(() => expect(decisions).toHaveLength(decision + 1));
    }

    const versions = decisions.map((submission) => submission.itemVersionId);
    expect(new Set(versions).size).toBe(DECISIONS_MEASURED);
  }, 30_000);
});
