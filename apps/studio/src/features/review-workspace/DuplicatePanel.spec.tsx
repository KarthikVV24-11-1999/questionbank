import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { DuplicatePanel } from './DuplicatePanel.js';
import type { DuplicateGroups } from './review-workspace-model.js';

const GROUPS: DuplicateGroups = {
  state: 'evaluated',
  exact: [{ itemId: 'exact-1', itemVersionId: 'exact-v1', subject: 'physics' }],
  skeleton: [{ itemId: 'skel-1', itemVersionId: 'skel-v1', subject: 'physics' }],
  trigram: [{ itemId: 'trig-1', itemVersionId: 'trig-v1', subject: 'physics', similarity: 0.42 }],
  computedAt: '2026-08-26T11:00:00.000Z',
  asOf: '2026-08-26T12:00:00.000Z',
};

describe('three labelled groups, in order (M4-40, DEC-M4-2)', () => {
  it('labels exact, skeleton and trigram, in that order, never merged', () => {
    render(<DuplicatePanel duplicates={GROUPS} selectedItemId={null} onSelect={() => undefined} />);
    const headings = screen.getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(headings).toEqual(['Exact (1)', 'Same skeleton, different constants (1)', 'Similar (1)']);
  });

  it('shows similarity only on the trigram group', () => {
    render(<DuplicatePanel duplicates={GROUPS} selectedItemId={null} onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: /trig-1.*42% similar/u })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'physics — exact-1' })).toBeInTheDocument();
  });

  it('renders staleness — computedAt and asOf both, distinguishable', () => {
    render(<DuplicatePanel duplicates={GROUPS} selectedItemId={null} onSelect={() => undefined} />);
    expect(screen.getByText(/Computed 2026-08-26T11:00:00\.000Z, as of 2026-08-26T12:00:00\.000Z/u)).toBeInTheDocument();
  });

  it('reports not_evaluated honestly, never as zero candidates', () => {
    render(
      <DuplicatePanel
        duplicates={{ state: 'not_evaluated', exact: [], skeleton: [], trigram: [], asOf: '2026-08-26T12:00:00.000Z' }}
        selectedItemId={null}
        onSelect={() => undefined}
      />,
    );
    expect(screen.getByText('Duplicate detection has not run for this item yet.')).toBeInTheDocument();
    expect(screen.queryByText(/\(0\)/u)).toBeNull();
  });
});

describe('selecting a candidate cites it (M4-40)', () => {
  it('calls onSelect with the itemId, and toggles off on a second click', async () => {
    const user = userEvent.setup();
    const selections: (string | null)[] = [];
    const { rerender } = render(
      <DuplicatePanel duplicates={GROUPS} selectedItemId={null} onSelect={(id) => selections.push(id)} />,
    );
    await user.click(screen.getByRole('button', { name: 'physics — exact-1' }));
    expect(selections).toEqual(['exact-1']);

    rerender(<DuplicatePanel duplicates={GROUPS} selectedItemId="exact-1" onSelect={(id) => selections.push(id)} />);
    await user.click(screen.getByRole('button', { name: 'physics — exact-1' }));
    expect(selections).toEqual(['exact-1', null]);
  });

  it('marks the selected candidate pressed', () => {
    render(<DuplicatePanel duplicates={GROUPS} selectedItemId="skel-1" onSelect={() => undefined} />);
    expect(screen.getByRole('button', { name: 'physics — skel-1' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'physics — exact-1' })).toHaveAttribute('aria-pressed', 'false');
  });
});

describe('accessibility (FRONTEND §7, §10)', () => {
  it('scans clean with candidates in every group', async () => {
    const { container } = render(<DuplicatePanel duplicates={GROUPS} selectedItemId={null} onSelect={() => undefined} />);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with every group empty', async () => {
    const { container } = render(
      <DuplicatePanel
        duplicates={{ state: 'evaluated', exact: [], skeleton: [], trigram: [], asOf: '2026-08-26T12:00:00.000Z' }}
        selectedItemId={null}
        onSelect={() => undefined}
      />,
    );
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
