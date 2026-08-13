import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { ItemBrowser } from './ItemBrowser.js';
import {
  LIFECYCLE_STATES,
  NO_FILTERS,
  browserSearchParams,
  describeDuplicateCheck,
  effectiveFilters,
  filtersFromSearch,
  filtersToSearch,
  versionHistoryPath,
  type ItemBrowserApi,
  type ItemFilters,
  type ItemRow,
  type SearchParamStore,
  type ValidationReport,
} from './item-browser-model.js';

const ME = 'principal-me';
const SOMEBODY_ELSE = 'principal-other';

const DRAFT_ROW: ItemRow = {
  itemId: 'item-1',
  label: 'Apparent weight in a lift',
  lifecycleState: 'draft',
  subject: 'Physics',
  authorPrincipalId: ME,
  publishedVersionNo: null,
};

const PUBLISHED_ROW: ItemRow = {
  itemId: 'item-2',
  label: 'Terminal velocity of a sphere',
  lifecycleState: 'published',
  subject: 'Physics',
  authorPrincipalId: SOMEBODY_ELSE,
  publishedVersionNo: 3,
};

const REPORT: ValidationReport = {
  findings: [
    {
      code: 'SOLUTION_MISSING',
      severity: 'blocking',
      message: 'This item has no published solution.',
      location: 'version.solution',
    },
    {
      code: 'DIFFICULTY_UNUSUAL',
      severity: 'warning',
      message: 'The difficulty estimate is unusual for this concept.',
      location: 'version.difficultyEstimate',
    },
  ],
  maySubmit: false,
  duplicateCheckState: 'not_evaluated',
};

function fakeSearchParams(initial = ''): SearchParamStore & { current(): string } {
  let search = initial;
  return {
    read: () => search,
    write: (next) => {
      search = next;
    },
    current: () => search,
  };
}

function harness(options: { readonly rows?: readonly ItemRow[]; readonly report?: ValidationReport } = {}): {
  readonly api: ItemBrowserApi;
  readonly queries: ItemFilters[];
} {
  const queries: ItemFilters[] = [];
  const api: ItemBrowserApi = {
    async list(filters) {
      queries.push(filters);
      return options.rows ?? [DRAFT_ROW, PUBLISHED_ROW];
    },
    async validationReport() {
      return options.report ?? REPORT;
    },
  };
  return { api, queries };
}

function renderBrowser(
  api: ItemBrowserApi,
  searchParams: SearchParamStore = fakeSearchParams(),
  myPrincipalId = ME,
) {
  return render(<ItemBrowser api={api} searchParams={searchParams} myPrincipalId={myPrincipalId} />);
}

describe('filters are typed, validated search state (FRONTEND §5, §8)', () => {
  it('round-trips every filter through the query string', () => {
    const filters: ItemFilters = {
      lifecycleStates: ['draft', 'published'],
      subject: 'Physics',
      conceptIdentityId: 'concept-7',
      authorPrincipalId: ME,
    };
    expect(filtersFromSearch(filtersToSearch(filters))).toEqual(filters);
  });

  it('round-trips the empty filter set as an empty search', () => {
    expect(filtersToSearch(NO_FILTERS)).toBe('');
    expect(filtersFromSearch('')).toEqual(NO_FILTERS);
  });

  it('round-trips every lifecycle state, so none is quietly unfilterable', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(filtersFromSearch(filtersToSearch({ ...NO_FILTERS, lifecycleStates: [state] })), state)
        .toEqual({ ...NO_FILTERS, lifecycleStates: [state] });
    }
    expect(LIFECYCLE_STATES.length).toBe(8);
  });

  // A hand-edited URL is untrusted input, and a filter nobody can name is a
  // query whose result nobody can explain.
  it('drops an unrecognised state rather than forwarding it', () => {
    expect(filtersFromSearch('?state=draft&state=marinated').lifecycleStates).toEqual(['draft']);
  });

  it('treats an empty parameter as absent', () => {
    expect(filtersFromSearch('?subject=&concept=&author=')).toEqual(NO_FILTERS);
  });
});

describe('drafts are scoped to their author (FR-TCH-06 rule 1)', () => {
  it('forces the author filter onto the asking principal when drafts are included', () => {
    expect(
      effectiveFilters({ ...NO_FILTERS, lifecycleStates: ['draft'], authorPrincipalId: SOMEBODY_ELSE }, ME),
    ).toEqual({ ...NO_FILTERS, lifecycleStates: ['draft'], authorPrincipalId: ME });
  });

  it('leaves the author filter alone when drafts are not included', () => {
    const filters: ItemFilters = {
      ...NO_FILTERS,
      lifecycleStates: ['published'],
      authorPrincipalId: SOMEBODY_ELSE,
    };
    expect(effectiveFilters(filters, ME)).toEqual(filters);
  });

  it('never asks the server for another author’s drafts, and says why', async () => {
    const user = userEvent.setup();
    const { api, queries } = harness();
    renderBrowser(api);

    await user.type(screen.getByLabelText('Author'), SOMEBODY_ELSE);
    await user.click(screen.getByLabelText('draft'));

    await waitFor(() => expect(queries[queries.length - 1]?.lifecycleStates).toEqual(['draft']));
    expect(queries[queries.length - 1]?.authorPrincipalId).toBe(ME);

    const authorField = screen.getByLabelText('Author');
    expect(authorField).toBeDisabled();
    expect(authorField).toHaveValue(ME);
    expect(authorField).toHaveAccessibleDescription(/Drafts are visible only to their author/u);
  });
});

describe('the filters reach the URL', () => {
  it('writes them on every change', async () => {
    const user = userEvent.setup();
    const store = fakeSearchParams();
    renderBrowser(harness().api, store);

    await user.click(screen.getByLabelText('in review'));
    expect(store.current()).toBe('?state=in_review');

    await user.type(screen.getByLabelText('Subject'), 'P');
    expect(store.current()).toBe('?state=in_review&subject=P');
  });

  it('reads them back on first render, so a shared link opens the same screen', async () => {
    const { api, queries } = harness();
    renderBrowser(api, fakeSearchParams('?state=published&subject=Chemistry'));

    expect(screen.getByLabelText('published')).toBeChecked();
    expect(screen.getByLabelText('Subject')).toHaveValue('Chemistry');
    await waitFor(() => expect(queries[0]?.subject).toBe('Chemistry'));
  });

  // The port is what a router replaces (DEC-5); the real one is exercised here
  // so it is not the untested half of the seam.
  it('round-trips through the real query string', async () => {
    const user = userEvent.setup();
    window.history.replaceState(null, '', '/authoring/items');
    renderBrowser(harness().api, browserSearchParams());

    await user.click(screen.getByLabelText('suspended'));
    expect(window.location.search).toBe('?state=suspended');
    expect(filtersFromSearch(window.location.search).lifecycleStates).toEqual(['suspended']);
  });

  it('clears back to an empty search', async () => {
    const user = userEvent.setup();
    const store = fakeSearchParams('?state=draft&subject=Physics');
    renderBrowser(harness().api, store);

    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(store.current()).toBe('');
    expect(screen.getByLabelText('draft')).not.toBeChecked();
  });
});

describe('the empty state is designed, not defaulted (UX §12)', () => {
  it('offers a way out when a filter matched nothing', async () => {
    const user = userEvent.setup();
    renderBrowser(harness({ rows: [] }).api, fakeSearchParams('?state=rejected'));

    expect(await screen.findByText('No items match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Show every item instead' }));
    expect(screen.getByLabelText('rejected')).not.toBeChecked();
  });

  it('says what will fill an empty corpus rather than showing the same dead end', async () => {
    renderBrowser(harness({ rows: [] }).api);
    expect(
      await screen.findByText('No items yet. The first draft you create will appear here.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Show every item instead' })).toBeNull();
  });
});

describe('a published row shows its version and links to the history (FR-QM-02 rule 4)', () => {
  it('names the published version number and the diff link', async () => {
    renderBrowser(harness().api);

    const items = await screen.findByRole('list', { name: 'Items' });
    expect(within(items).getByText('Published version 3')).toBeInTheDocument();
    expect(
      within(items).getByRole('link', {
        name: 'Version history and diffs for Terminal velocity of a sphere',
      }),
    ).toHaveAttribute('href', versionHistoryPath('item-2'));
  });

  it('shows neither on a row with no published version', async () => {
    renderBrowser(harness({ rows: [DRAFT_ROW] }).api);

    const items = await screen.findByRole('list', { name: 'Items' });
    expect(within(items).queryByText(/Published version/u)).toBeNull();
    expect(within(items).queryByRole('link')).toBeNull();
  });
});

describe('the validation panel (FR-TCH-07, DEC-7)', () => {
  it('groups blocking and warning findings separately, each with its location', async () => {
    const user = userEvent.setup();
    renderBrowser(harness().api);

    await user.click(await screen.findByRole('button', { name: 'Apparent weight in a lift — draft' }));

    const blocking = await screen.findByRole('list', { name: 'Blocking findings' });
    expect(within(blocking).getAllByRole('listitem').map((entry) => entry.textContent)).toEqual([
      'This item has no published solution. (version.solution)',
    ]);

    const warnings = screen.getByRole('list', { name: 'Warning findings' });
    expect(within(warnings).getAllByRole('listitem').map((entry) => entry.textContent)).toEqual([
      'The difficulty estimate is unusual for this concept. (version.difficultyEstimate)',
    ]);
  });

  // A report claiming no duplicates when nothing ran is a claim a reviewer
  // acts on, so the wording must carry no "none".
  it('states plainly that duplicate detection has not run', async () => {
    const user = userEvent.setup();
    renderBrowser(harness().api);

    await user.click(await screen.findByRole('button', { name: 'Apparent weight in a lift — draft' }));
    const said = describeDuplicateCheck('not_evaluated');
    expect(said).toContain('has not run');
    expect(said.toLowerCase()).not.toContain('none');
    expect(await screen.findByText(said)).toBeInTheDocument();
  });

  it('distinguishes a check that ran and found nothing from one that never ran', () => {
    expect(describeDuplicateCheck('none_found')).toContain('found no candidates');
    expect(describeDuplicateCheck('candidates_found')).toContain('found candidates');
  });

  it('says nothing about an item nobody selected', async () => {
    renderBrowser(harness().api);
    expect(await screen.findByText('Choose an item to see its findings.')).toBeInTheDocument();
  });

  it('reports an item with no findings without implying it was not checked', async () => {
    const user = userEvent.setup();
    renderBrowser(
      harness({ report: { findings: [], maySubmit: true, duplicateCheckState: 'not_evaluated' } }).api,
    );

    await user.click(await screen.findByRole('button', { name: 'Apparent weight in a lift — draft' }));
    expect(await screen.findByText('Nothing blocking.')).toBeInTheDocument();
    expect(screen.getByText('No warnings.')).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('scans clean with results and a selected item', async () => {
    const user = userEvent.setup();
    const { container } = renderBrowser(harness().api);

    await user.click(await screen.findByRole('button', { name: 'Apparent weight in a lift — draft' }));
    await screen.findByRole('list', { name: 'Blocking findings' });
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean on the empty state with the author filter locked', async () => {
    const user = userEvent.setup();
    const { container } = renderBrowser(harness({ rows: [] }).api);

    await user.click(screen.getByLabelText('draft'));
    await screen.findByText('No items match these filters.');
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
