import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TaxonomyBrowser } from './TaxonomyBrowser.js';
import {
  A_DRAFT_VERSION,
  A_PUBLISHED_VERSION,
  FakeCurriculumClient,
  aLargeTree,
} from '../../testing/fake-curriculum-client.js';
import { accessibilityViolations } from '../../testing/accessibility.js';

function renderBrowser(client = new FakeCurriculumClient()) {
  const view = render(<TaxonomyBrowser client={client} examFamily="JEE" />);
  return { client, ...view };
}

describe('version selector', () => {
  it('lists the versions of the exam family and selects the first', async () => {
    renderBrowser();

    const selector = await screen.findByLabelText('Taxonomy version');
    expect(within(selector).getAllByRole('option')).toHaveLength(2);
    expect(selector).toHaveValue(A_PUBLISHED_VERSION.taxonomyVersionId);
  });

  it('marks a published version as read-only', async () => {
    renderBrowser();

    expect(await screen.findByText(/Published — read only/u)).toBeInTheDocument();
  });

  it('shows no read-only notice for a draft', async () => {
    const client = new FakeCurriculumClient({ versions: [A_DRAFT_VERSION] });
    renderBrowser(client);

    await screen.findByLabelText('Taxonomy version');
    expect(screen.queryByText(/read only/u)).not.toBeInTheDocument();
  });

  it('loads the newly selected version', async () => {
    const { client } = renderBrowser();
    await screen.findByRole('button', { name: 'Physics' });

    await userEvent.selectOptions(
      screen.getByLabelText('Taxonomy version'),
      A_DRAFT_VERSION.taxonomyVersionId,
    );

    await waitFor(() => {
      expect(client.calls).toContain(`getTaxonomyVersion:${A_DRAFT_VERSION.taxonomyVersionId}`);
    });
  });
});

describe('tree rendering and expansion', () => {
  it('renders roots expanded and deeper levels collapsed', async () => {
    renderBrowser();

    expect(await screen.findByRole('button', { name: 'Physics' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mechanics' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Kinematics' })).not.toBeInTheDocument();
  });

  it('expands a subtree on demand and collapses it again', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Mechanics' });

    await userEvent.click(screen.getByRole('button', { name: 'Expand Mechanics' }));
    expect(await screen.findByRole('button', { name: 'Kinematics' })).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Collapse Mechanics' }));
    expect(screen.queryByRole('button', { name: 'Kinematics' })).not.toBeInTheDocument();
  });

  it('reports expansion state to assistive technology', async () => {
    renderBrowser();

    const toggle = await screen.findByRole('button', { name: 'Expand Mechanics' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');

    await userEvent.click(toggle);
    expect(screen.getByRole('button', { name: 'Collapse Mechanics' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
  });

  it('offers no expand control for a leaf', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Optics' });

    expect(screen.queryByRole('button', { name: 'Expand Optics' })).not.toBeInTheDocument();
  });
});

describe('concept detail', () => {
  it('shows identity, weight, depth and prerequisites for the selected concept', async () => {
    const client = new FakeCurriculumClient({
      prerequisites: {
        conceptIdentityId: '019fd4bc-0000-7000-8000-0000000003ea',
        requires: [{ conceptIdentityId: 'ci-mechanics', strength: 0.9 }],
        requiredBy: [],
      },
    });
    renderBrowser(client);

    await userEvent.click(await screen.findByRole('button', { name: 'Mechanics' }));

    const detail = screen.getByRole('region', { name: 'Concept detail' });
    expect(within(detail).getByText('Mechanics')).toBeInTheDocument();
    expect(within(detail).getByText('0.3')).toBeInTheDocument();
    expect(within(detail).getByText('90')).toBeInTheDocument();
    expect(await within(detail).findByText('ci-mechanics')).toBeInTheDocument();
  });

  it('stubs the item count until content authoring ships', async () => {
    renderBrowser();
    await userEvent.click(await screen.findByRole('button', { name: 'Physics' }));

    expect(screen.getByText(/Not available until content authoring ships/u)).toBeInTheDocument();
  });

  it('prompts for a selection before anything is selected', async () => {
    renderBrowser();

    expect(await screen.findByText('Select a concept to see its detail.')).toBeInTheDocument();
  });
});

describe('search', () => {
  it('finds a concept anywhere in the version, including collapsed branches', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Physics' });

    await userEvent.type(screen.getByLabelText('Search concepts'), 'kinem');

    const results = screen.getByRole('region', { name: 'Search results' });
    expect(within(results).getByRole('button', { name: 'Kinematics' })).toBeInTheDocument();
  });

  it('reports an empty result set rather than showing nothing', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Physics' });

    await userEvent.type(screen.getByLabelText('Search concepts'), 'thermodynamics');

    expect(screen.getByText(/No concept matches/u)).toBeInTheDocument();
  });

  it('selects a concept straight from the results', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Physics' });
    await userEvent.type(screen.getByLabelText('Search concepts'), 'optics');

    await userEvent.click(screen.getByRole('button', { name: 'Optics' }));

    const detail = screen.getByRole('region', { name: 'Concept detail' });
    expect(within(detail).getByText('Optics')).toBeInTheDocument();
  });
});

describe('empty and error states', () => {
  it('shows an error when the taxonomy cannot be loaded', async () => {
    renderBrowser(new FakeCurriculumClient({ failListing: true }));

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/u);
  });

  it('shows an empty state for a version with no concepts', async () => {
    renderBrowser(new FakeCurriculumClient({ nodes: [] }));

    expect(await screen.findByText(/no concepts yet/u)).toBeInTheDocument();
  });
});

describe('performance budget', () => {
  it('renders a 600-node version and expands a branch well inside 200 ms', async () => {
    const client = new FakeCurriculumClient({ nodes: aLargeTree(600) });
    renderBrowser(client);
    await screen.findByRole('button', { name: 'Physics' });

    const startedAt = performance.now();
    await userEvent.click(screen.getByRole('button', { name: 'Collapse Physics' }));
    await userEvent.click(screen.getByRole('button', { name: 'Expand Physics' }));
    const elapsed = performance.now() - startedAt;

    expect(screen.getByRole('button', { name: 'Concept 42' })).toBeInTheDocument();
    expect(elapsed).toBeLessThan(200);
  }, 30_000);
});

describe('accessibility', () => {
  it('passes the automated WCAG 2.2 AA scan', async () => {
    const { container } = renderBrowser();
    await screen.findByRole('button', { name: 'Physics' });

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);

  it('passes the scan with a concept selected and a branch expanded', async () => {
    const { container } = renderBrowser();
    await userEvent.click(await screen.findByRole('button', { name: 'Expand Mechanics' }));
    await userEvent.click(screen.getByRole('button', { name: 'Kinematics' }));

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);

  it('is fully keyboard operable', async () => {
    renderBrowser();
    await screen.findByRole('button', { name: 'Physics' });

    await userEvent.tab();
    expect(screen.getByLabelText('Taxonomy version')).toHaveFocus();
    await userEvent.tab();
    expect(screen.getByLabelText('Search concepts')).toHaveFocus();

    // The third stop is the root's toggle, which starts expanded.
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Collapse Physics' })).toHaveFocus();

    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('button', { name: 'Expand Physics' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Mechanics' })).not.toBeInTheDocument();
  });
});
