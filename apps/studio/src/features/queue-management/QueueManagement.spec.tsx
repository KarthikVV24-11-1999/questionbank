import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { QueueManagement } from './QueueManagement.js';
import {
  SORT_KEYS,
  type QueueFilters,
  type QueueHealthView,
  type QueueManagementApi,
  type SearchParamStore,
} from './queue-management-model.js';

function healthView(overrides: Partial<QueueHealthView> = {}): QueueHealthView {
  return {
    depthBySubject: [
      { subject: 'physics', depth: 4 },
      { subject: 'chemistry', depth: 1 },
    ],
    ageHistogram: [
      { band: 'fresh', count: 3 },
      { band: 'warn', count: 1 },
      { band: 'escalated', count: 1 },
    ],
    overdue: [
      {
        itemId: 'item-1',
        itemVersionId: 'version-1',
        subject: 'physics',
        stateEnteredAt: '2026-08-23T09:00:00.000Z',
      },
    ],
    aggregateThroughput: { decisionCount: 12, decisionsPerHour: 0.5 },
    asOf: '2026-08-26T12:00:00.000Z',
    ...overrides,
  };
}

interface Harness {
  readonly queries: QueueFilters[];
  readonly reassignments: { itemVersionId: string; subject: string; reviewerId: string }[];
  readonly api: QueueManagementApi;
}

function harness(view: QueueHealthView = healthView()): Harness {
  const queries: QueueFilters[] = [];
  const reassignments: Harness['reassignments'] = [];
  const api: QueueManagementApi = {
    async getQueueHealth(filters) {
      queries.push(filters);
      return filters.subject === null
        ? view
        : { ...view, depthBySubject: view.depthBySubject.filter((r) => r.subject === filters.subject) };
    },
    async reassign(itemVersionId, subject, reviewerId) {
      reassignments.push({ itemVersionId, subject, reviewerId });
    },
  };
  return { queries, reassignments, api };
}

function memorySearchParams(initial = ''): SearchParamStore & { history: string[] } {
  let current = initial;
  const history: string[] = [];
  return {
    read: () => current,
    write: (search) => {
      current = search;
      history.push(search);
    },
    history,
  };
}

describe('depth and histogram (M4-41)', () => {
  it('renders the histogram matching the query', async () => {
    const { api } = harness();
    render(<QueueManagement api={api} searchParams={memorySearchParams()} />);
    await screen.findByText('physics');
    expect(screen.getByText('fresh: 3')).toBeInTheDocument();
    expect(screen.getByText('warn: 1')).toBeInTheDocument();
    expect(screen.getByText('escalated: 1')).toBeInTheDocument();
  });

  it('shows a designed empty state for a cold queue', async () => {
    const { api } = harness(healthView({ depthBySubject: [] }));
    render(<QueueManagement api={api} searchParams={memorySearchParams()} />);
    expect(await screen.findByText(/Nothing is in review yet/u)).toBeInTheDocument();
  });

  it('shows a designed empty state for a filter that matched nothing, distinct from a cold queue', async () => {
    const { api } = harness(healthView({ depthBySubject: [] }));
    render(<QueueManagement api={api} searchParams={memorySearchParams('?subject=biology')} />);
    expect(await screen.findByText('No subject matches this filter.')).toBeInTheDocument();
  });
});

describe('reassign reaches the handler (M4-41)', () => {
  it('sends the overdue item’s subject and the typed reviewer id', async () => {
    const user = userEvent.setup();
    const { api, reassignments } = harness();
    render(<QueueManagement api={api} searchParams={memorySearchParams()} />);

    await user.type(await screen.findByLabelText('Reassign physics item to reviewer'), 'reviewer-9');
    await user.click(screen.getByRole('button', { name: 'Reassign' }));

    await waitFor(() => expect(reassignments).toHaveLength(1));
    expect(reassignments[0]).toEqual({ itemVersionId: 'version-1', subject: 'physics', reviewerId: 'reviewer-9' });
  });

  it('leaves Reassign disabled with no reviewer id typed', async () => {
    const { api } = harness();
    render(<QueueManagement api={api} searchParams={memorySearchParams()} />);
    await screen.findByLabelText('Reassign physics item to reviewer');
    expect(screen.getByRole('button', { name: 'Reassign' })).toBeDisabled();
  });
});

describe('no ranking affordance exists (DEC-M4-13)', () => {
  it('SORT_KEYS names only subject and depth — nothing reviewer-shaped', () => {
    expect(SORT_KEYS).toEqual(['subject', 'depth']);
    expect(SORT_KEYS.some((key) => /reviewer/iu.test(key))).toBe(false);
  });

  it('renders no per-reviewer figure, no sort control, and the word "rank" nowhere', async () => {
    const { api } = harness();
    const { container } = render(<QueueManagement api={api} searchParams={memorySearchParams()} />);
    await screen.findByText('physics');

    expect(container.querySelectorAll('[aria-sort]')).toHaveLength(0);
    expect(screen.queryByText(/rank|leaderboard|reviewerId|per reviewer/iu)).toBeNull();
    // Aggregate only — one throughput figure for the whole team, not one row per reviewer.
    expect(screen.getByText(/12 decisions, 0\.50 per hour across the whole team\./u)).toBeInTheDocument();
  });
});

describe('filters round-trip through the URL (FRONTEND §5)', () => {
  it('reads the initial filter from the URL', async () => {
    const { api, queries } = harness();
    render(<QueueManagement api={api} searchParams={memorySearchParams('?subject=physics')} />);
    await waitFor(() => expect(queries).toHaveLength(1));
    expect(queries[0]).toEqual({ subject: 'physics' });
  });

  it('writes a typed filter back to the URL', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    const searchParams = memorySearchParams();
    render(<QueueManagement api={api} searchParams={searchParams} />);
    await screen.findByText('physics');

    await user.type(screen.getByLabelText('Subject'), 'chemistry');
    expect(searchParams.history.at(-1)).toBe('?subject=chemistry');
  });

  it('clearing filters clears the URL', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    const searchParams = memorySearchParams('?subject=physics');
    render(<QueueManagement api={api} searchParams={searchParams} />);
    await screen.findByText('physics');

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(searchParams.history.at(-1)).toBe('');
  });
});

describe('accessibility (FRONTEND §7, §10)', () => {
  it('scans clean while loading', async () => {
    const { api } = harness();
    const { container } = render(<QueueManagement api={api} searchParams={memorySearchParams()} />);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with data loaded', async () => {
    const { api } = harness();
    const { container } = render(<QueueManagement api={api} searchParams={memorySearchParams()} />);
    await screen.findByText('physics');
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean at the cold-queue empty state', async () => {
    const { api } = harness(healthView({ depthBySubject: [], overdue: [] }));
    const { container } = render(<QueueManagement api={api} searchParams={memorySearchParams()} />);
    await screen.findByText(/Nothing is in review yet/u);
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});

describe('the surface imports no router (DEC-5)', () => {
  it('imports nothing from a router package', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const files = ['QueueManagement.tsx', 'queue-management-model.ts', 'queue-management-api.ts'];
    for (const file of files) {
      const source = readFileSync(join('src', 'features', 'queue-management', file), 'utf8');
      expect(source, file).not.toMatch(/from '(react-router|@tanstack\/react-router|wouter)/u);
    }
    expect(files).toHaveLength(3);
  });
});
