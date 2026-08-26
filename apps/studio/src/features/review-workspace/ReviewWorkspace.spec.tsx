import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { ReviewWorkspace } from './ReviewWorkspace.js';
import type {
  ClaimedItemBundle,
  DecisionSubmission,
  ReviewWorkspaceApi,
} from './review-workspace-model.js';

const CONTENT_BODY = { schemaVersion: 1, blocks: [{ kind: 'TEXT', value: 'A block slides down a ramp.' }] };

let seed = 0;
function freshUuid(): string {
  seed += 1;
  return `00000000-0000-4000-a000-${seed.toString(16).padStart(12, '0')}`;
}

function bundle(overrides: Partial<ClaimedItemBundle> = {}): ClaimedItemBundle {
  const itemId = freshUuid();
  const itemVersionId = freshUuid();
  return {
    assignment: {
      assignmentId: freshUuid(),
      itemId,
      itemVersionId,
      subject: 'physics',
      leaseExpiresAt: '2026-08-26T13:00:00.000Z',
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
      taxonomyTags: [{ conceptIdentityId: freshUuid(), taxonomyVersionId: freshUuid(), weight: 1, isPrimary: true }],
      difficultyEstimate: 'moderate',
      provenance: { sourceType: 'original' },
    },
    validation: { blocking: [], warnings: [] },
    duplicates: { state: 'evaluated', exact: [], skeleton: [], trigram: [], asOf: '2026-08-26T12:00:00.000Z' },
    solution: { state: 'not_available' },
    queueDepth: 3,
    ...overrides,
  };
}

interface Harness {
  readonly claims: string[];
  readonly decisions: DecisionSubmission[];
  readonly api: ReviewWorkspaceApi;
}

/** An infinite queue: every `claimNext` returns a fresh bundle, unless `queue` is supplied (exhausted once consumed). */
function harness(options: { readonly queue?: readonly (ClaimedItemBundle | null)[]; readonly claimDelayMs?: number } = {}): Harness {
  const claims: string[] = [];
  const decisions: DecisionSubmission[] = [];
  let index = 0;

  const api: ReviewWorkspaceApi = {
    async claimNext(subject) {
      claims.push(subject);
      if (options.claimDelayMs !== undefined) {
        await new Promise((resolve) => setTimeout(resolve, options.claimDelayMs));
      }
      if (options.queue !== undefined) {
        const next = options.queue[index] ?? null;
        index += 1;
        return next;
      }
      return bundle();
    },
    async recordDecision(submission) {
      decisions.push(submission);
    },
  };

  return { claims, decisions, api };
}

function renderWorkspace(api: ReviewWorkspaceApi, overrides: Partial<Parameters<typeof ReviewWorkspace>[0]> = {}) {
  return render(
    <ReviewWorkspace api={api} subject="physics" principalMayReview undoWindowMs={20} {...overrides} />,
  );
}

async function approve(user: ReturnType<typeof userEvent.setup>): Promise<void> {
  await user.click(await screen.findByRole('button', { name: 'Approve (G)' }));
  await user.click(screen.getByRole('button', { name: 'Commit decision (Enter)' }));
}

describe('one item fills the screen, nothing behind a disclosure (M4-38)', () => {
  it('renders all seven regions with no interactive disclosure control', async () => {
    const { api } = harness();
    const { container } = renderWorkspace(api);

    for (const region of ['stem', 'options', 'solution', 'tags', 'provenance', 'findings', 'duplicates']) {
      await waitFor(() => expect(container.querySelector(`[data-region="${region}"]`)).not.toBeNull());
    }

    // Nothing that requires interaction to reveal a region's own content —
    // no <details>, no aria-expanded toggle, no [hidden] content block, no tab panel.
    expect(container.querySelectorAll('details')).toHaveLength(0);
    expect(container.querySelectorAll('[aria-expanded]')).toHaveLength(0);
    expect(container.querySelectorAll('[role="tab"], [role="tabpanel"]')).toHaveLength(0);
  });

  it('shows the answer key — an authoring-family surface — when the reviewer holds the role', async () => {
    const { api } = harness();
    renderWorkspace(api);
    expect(await screen.findByText(/\(correct\)/u)).toBeInTheDocument();
  });

  it('is unreachable without the reviewer policy — the key never renders', () => {
    const { api } = harness();
    render(<ReviewWorkspace api={api} subject="physics" principalMayReview={false} />);
    expect(screen.getByRole('alert')).toHaveTextContent('You do not have a reviewer role.');
    expect(screen.queryByText(/\(correct\)/u)).toBeNull();
  });

  it('shows a designed empty state for a cold queue, not a bare "no data"', async () => {
    const { api } = harness({ queue: [null] });
    renderWorkspace(api);
    expect(await screen.findByText(/Nothing is waiting for review in physics/u)).toBeInTheDocument();
  });
});

describe('auto-advance is a state swap, never a navigation (M4-38)', () => {
  it('produces zero route changes across ten consecutive decisions', async () => {
    const user = userEvent.setup();
    const { api, decisions } = harness();
    const startingPath = window.location.pathname + window.location.search;
    renderWorkspace(api);

    for (let i = 0; i < 10; i += 1) {
      await approve(user);
      await waitFor(() => expect(decisions).toHaveLength(i + 1));
      await screen.findByRole('button', { name: 'Approve (G)' });
    }

    expect(window.location.pathname + window.location.search).toBe(startingPath);
  });

  it('moves focus to the item heading on advance', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderWorkspace(api);
    await screen.findByRole('button', { name: 'Approve (G)' });

    await approve(user);
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 })).toHaveFocus());
  });
});

describe('the next item is prefetched — no request between decisions (M4-38)', () => {
  it('never shows a loading state on advance, because the next item was already fetched', async () => {
    const user = userEvent.setup();
    // Slow enough that a request started *at* advance time would still be
    // pending when this test checks — proving the swap used a value that was
    // already there, not one just requested.
    const { api, claims } = harness({ claimDelayMs: 80 });
    renderWorkspace(api);
    await screen.findByRole('button', { name: 'Approve (G)' });

    // Give the background prefetch (kicked off alongside the first claim)
    // time to resolve before deciding — exactly what "reads the current one"
    // buys in production.
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(claims.length).toBeGreaterThanOrEqual(2);

    await approve(user);
    // The undo window elapses (20ms) and the swap happens — assert no
    // "Claiming the next item…" status ever appears, which only the
    // *loading* branch renders.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Approve (G)' })).toBeInTheDocument());
    expect(screen.queryByText('Claiming the next item…')).toBeNull();
  });
});

describe('queue depth and pace are visible, with no per-reviewer comparison (DEC-M4-13)', () => {
  it('shows depth and a session counter, and names no reviewer, rank or leaderboard', async () => {
    const { api } = harness();
    renderWorkspace(api);
    expect(await screen.findByText(/Queue depth: 3\. Reviewed this session: 0\./u)).toBeInTheDocument();
    expect(screen.queryByText(/rank|leaderboard|reviewerId/iu)).toBeNull();
  });
});

describe('accessibility (FRONTEND §7, §10)', () => {
  it('scans clean while claiming', async () => {
    const { api } = harness({ claimDelayMs: 5000 });
    const { container } = renderWorkspace(api);
    await screen.findByRole('status');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with an item loaded', async () => {
    const { api } = harness();
    const { container } = renderWorkspace(api);
    await screen.findByRole('button', { name: 'Approve (G)' });
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean at the refusal', () => {
    const { api } = harness();
    const { container } = render(<ReviewWorkspace api={api} subject="physics" principalMayReview={false} />);
    return accessibilityViolations(container).then((violations) => expect(violations).toEqual([]));
  });

  it('scans clean at the empty queue state', async () => {
    const { api } = harness({ queue: [null] });
    const { container } = renderWorkspace(api);
    await screen.findByText(/Nothing is waiting/u);
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});

describe('the workspace imports no router (DEC-5)', () => {
  it('imports nothing from a router package, across every file in the feature', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files = [
      'ReviewWorkspace.tsx',
      'review-workspace-model.ts',
      'review-workspace-api.ts',
      'DecisionBar.tsx',
      'undo-buffer.ts',
      'DuplicatePanel.tsx',
      'InlineEditor.tsx',
    ];
    for (const file of files) {
      const source = readFileSync(join('src', 'features', 'review-workspace', file), 'utf8');
      expect(source, file).not.toMatch(/from '(react-router|@tanstack\/react-router|wouter)/u);
    }
    expect(files).toHaveLength(7);
  });
});
