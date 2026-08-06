import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ConceptNode } from '@questionbank/contracts';
import { TaxonomyDraftEditor, type DraftEditorApi } from './TaxonomyDraftEditor.js';
import { draftViolations, moveWouldCreateCycle, publicationPreconditions } from './draft-editor-model.js';
import { aTaxonomyTree } from '../../testing/fake-curriculum-client.js';
import { accessibilityViolations } from '../../testing/accessibility.js';

function fakeApi(overrides: Partial<DraftEditorApi> = {}): DraftEditorApi {
  return {
    createDraft: vi.fn(async (source) => ({
      taxonomyVersionId: 'tv-draft',
      aggregateVersion: 1,
      nodes: source.cloneOf === undefined ? [] : aTaxonomyTree(),
    })),
    saveDraft: vi.fn(async () => ({ ok: true as const, aggregateVersion: 2 })),
    publish: vi.fn(async () => ({ ok: true as const })),
    ...overrides,
  };
}

function renderEditor(api = fakeApi()) {
  const view = render(<TaxonomyDraftEditor api={api} examFamily="JEE" academicYear="2027" />);
  return { api, ...view };
}

async function startEmptyDraft(api = fakeApi()) {
  const view = renderEditor(api);
  await userEvent.click(screen.getByRole('button', { name: 'Create empty draft' }));
  return view;
}

async function addConcept(name: string): Promise<void> {
  await userEvent.clear(screen.getByLabelText('Concept name'));
  await userEvent.type(screen.getByLabelText('Concept name'), name);
  await userEvent.click(screen.getByRole('button', { name: 'Add concept' }));
}

describe('creating a draft', () => {
  it('creates an empty draft from scratch', async () => {
    const { api } = await startEmptyDraft();

    expect(api.createDraft).toHaveBeenCalledWith({ examFamily: 'JEE', academicYear: '2027' });
    expect(screen.getByRole('heading', { name: 'Publication' })).toBeInTheDocument();
  });

  it('creates a draft by cloning a published version', async () => {
    renderEditor();

    await userEvent.click(screen.getByRole('button', { name: 'Clone published version' }));

    const tree = screen.getByRole('navigation', { name: 'Draft concepts' });
    expect(within(tree).getByRole('button', { name: 'Physics' })).toBeInTheDocument();
    expect(within(tree).getByRole('button', { name: 'Kinematics' })).toBeInTheDocument();
  });
});

describe('edit operations', () => {
  it('adds a concept', async () => {
    await startEmptyDraft();

    await addConcept('Physics');

    const tree = screen.getByRole('navigation', { name: 'Draft concepts' });
    expect(within(tree).getByRole('button', { name: 'Physics' })).toBeInTheDocument();
  });

  it('adds a child under the selected concept', async () => {
    await startEmptyDraft();
    await addConcept('Physics');
    await userEvent.click(screen.getByRole('button', { name: 'Physics' }));

    await addConcept('Mechanics');

    const tree = screen.getByRole('navigation', { name: 'Draft concepts' });
    expect(within(tree).getAllByRole('button')).toHaveLength(2);
  });

  it('renames a concept', async () => {
    await startEmptyDraft();
    await addConcept('Physcis');
    await userEvent.click(screen.getByRole('button', { name: 'Physcis' }));

    await userEvent.type(screen.getByLabelText('Concept name'), 'Physics');
    await userEvent.click(screen.getByRole('button', { name: 'Rename concept' }));

    expect(screen.getByRole('button', { name: 'Physics' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Physcis' })).not.toBeInTheDocument();
  });

  it('removes a concept', async () => {
    await startEmptyDraft();
    await addConcept('Physics');
    await userEvent.click(screen.getByRole('button', { name: 'Physics' }));

    await userEvent.click(screen.getByRole('button', { name: 'Remove concept' }));

    const tree = screen.getByRole('navigation', { name: 'Draft concepts' });
    expect(within(tree).queryAllByRole('button')).toHaveLength(0);
  });

  it('moves a concept under a new parent', async () => {
    await startEmptyDraft();
    await addConcept('Physics');
    await addConcept('Mechanics');
    await userEvent.click(screen.getByRole('button', { name: 'Mechanics' }));

    await userEvent.selectOptions(screen.getByLabelText('Move under'), ['Physics']);

    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('adds a prerequisite edge', async () => {
    await startEmptyDraft();
    await addConcept('Mechanics');
    await addConcept('Kinematics');
    await userEvent.click(screen.getByRole('button', { name: 'Mechanics' }));

    await userEvent.selectOptions(
      screen.getByLabelText('Add prerequisite from selected concept to'),
      ['Kinematics'],
    );

    expect(screen.getByText('No problems found.')).toBeInTheDocument();
  });

  it('disables edit controls that need a selection', async () => {
    await startEmptyDraft();
    await addConcept('Physics');

    expect(screen.getByRole('button', { name: 'Rename concept' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Remove concept' })).toBeDisabled();
    expect(screen.getByLabelText('Move under')).toBeDisabled();
  });
});

describe('invariant violations surface inline', () => {
  it('blocks a move that would put a concept inside its own subtree', async () => {
    renderEditor();
    await userEvent.click(screen.getByRole('button', { name: 'Clone published version' }));
    await userEvent.click(screen.getByRole('button', { name: 'Physics' }));

    await userEvent.selectOptions(screen.getByLabelText('Move under'), ['Mechanics']);

    expect(screen.getByRole('alert')).toHaveTextContent(/inside its own subtree/u);
  });

  it('reports a prerequisite cycle as soon as it is drawn', async () => {
    await startEmptyDraft();
    await addConcept('Mechanics');
    await addConcept('Kinematics');
    await userEvent.click(screen.getByRole('button', { name: 'Mechanics' }));
    await userEvent.selectOptions(
      screen.getByLabelText('Add prerequisite from selected concept to'),
      ['Kinematics'],
    );

    await userEvent.click(screen.getByRole('button', { name: 'Kinematics' }));
    await userEvent.selectOptions(
      screen.getByLabelText('Add prerequisite from selected concept to'),
      ['Mechanics'],
    );

    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(within(problems).getByText(/Prerequisites form a loop/u)).toBeInTheDocument();
  });

  it('reports a self-prerequisite', async () => {
    await startEmptyDraft();
    await addConcept('Mechanics');
    await userEvent.click(screen.getByRole('button', { name: 'Mechanics' }));

    await userEvent.selectOptions(
      screen.getByLabelText('Add prerequisite from selected concept to'),
      ['Mechanics'],
    );

    expect(screen.getByText(/cannot be a prerequisite of itself/u)).toBeInTheDocument();
  });

  it('announces problems politely rather than interrupting', async () => {
    await startEmptyDraft();
    await addConcept('Mechanics');
    await userEvent.click(screen.getByRole('button', { name: 'Mechanics' }));
    await userEvent.selectOptions(
      screen.getByLabelText('Add prerequisite from selected concept to'),
      ['Mechanics'],
    );

    const problems = screen.getByRole('region', { name: 'Problems' });
    expect(within(problems).getByRole('list')).toHaveAttribute('aria-live', 'polite');
  });
});

describe('publication', () => {
  it('shows every unmet precondition and keeps publish disabled', async () => {
    await startEmptyDraft();

    const publication = screen.getByRole('region', { name: 'Publication' });
    expect(within(publication).getByText(/✗ The version has at least one concept/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('enables publish once every precondition is met', async () => {
    await startEmptyDraft();
    await addConcept('Physics');

    expect(screen.getByRole('button', { name: 'Publish' })).toBeEnabled();
  });

  it('publishes and then shows the version as read-only', async () => {
    const { api } = await startEmptyDraft();
    await addConcept('Physics');

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(api.publish).toHaveBeenCalledWith('tv-draft', 1);
    expect(screen.getByText(/now read-only/u)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add concept' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Publish' })).toBeDisabled();
  });

  it('surfaces a publication refusal from the server', async () => {
    const api = fakeApi({
      publish: vi.fn(async () => ({ ok: false as const, message: 'Chemistry has no root concept.' })),
    });
    await startEmptyDraft(api);
    await addConcept('Physics');

    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(screen.getByRole('alert')).toHaveTextContent('Chemistry has no root concept.');
  });
});

describe('optimistic concurrency', () => {
  it('shows a clear conflict rather than overwriting silently', async () => {
    const api = fakeApi({ saveDraft: vi.fn(async () => ({ ok: false as const, conflict: true as const })) });
    await startEmptyDraft(api);
    await addConcept('Physics');

    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));

    expect(screen.getByRole('alert')).toHaveTextContent(/changed this version while you were editing/u);
    expect(screen.getByRole('alert')).toHaveTextContent(/have not been applied/u);
  });

  it('advances the aggregate version on a successful save', async () => {
    const { api } = await startEmptyDraft();
    await addConcept('Physics');

    await userEvent.click(screen.getByRole('button', { name: 'Save draft' }));
    await userEvent.click(screen.getByRole('button', { name: 'Publish' }));

    expect(api.publish).toHaveBeenCalledWith('tv-draft', 2);
  });
});

describe('editing rules', () => {
  const tree = aTaxonomyTree();

  it('detects a move into a descendant', () => {
    const physics = tree[0] as ConceptNode;
    const kinematics = tree[2] as ConceptNode;

    expect(moveWouldCreateCycle(tree, physics.conceptNodeId, kinematics.conceptNodeId)).toBe(true);
    expect(moveWouldCreateCycle(tree, kinematics.conceptNodeId, physics.conceptNodeId)).toBe(false);
    expect(moveWouldCreateCycle(tree, physics.conceptNodeId, physics.conceptNodeId)).toBe(true);
  });

  it('detects a duplicate concept identity', () => {
    const duplicate = { ...(tree[1] as ConceptNode), conceptNodeId: 'copy' };

    const violations = draftViolations({ nodes: [...tree, duplicate], prerequisites: [] });

    expect(violations.map((violation) => violation.code)).toContain('DUPLICATE_CONCEPT_IDENTITY');
  });

  it('detects an orphan', () => {
    const orphan = { ...(tree[2] as ConceptNode), parentNodeId: 'missing' };

    const violations = draftViolations({ nodes: [orphan], prerequisites: [] });

    expect(violations.map((violation) => violation.code)).toEqual(['ORPHAN_NODE']);
  });

  it('accepts a well-formed draft', () => {
    expect(draftViolations({ nodes: tree, prerequisites: [] })).toEqual([]);
    expect(publicationPreconditions({ nodes: tree, prerequisites: [] }).every((entry) => entry.met)).toBe(true);
  });
});

describe('accessibility', () => {
  it('passes the automated WCAG 2.2 AA scan', async () => {
    const { container } = await startEmptyDraft();
    await addConcept('Physics');

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);

  it('passes the scan with violations displayed', async () => {
    const { container } = await startEmptyDraft();
    await addConcept('Mechanics');
    await userEvent.click(screen.getByRole('button', { name: 'Mechanics' }));
    await userEvent.selectOptions(
      screen.getByLabelText('Add prerequisite from selected concept to'),
      ['Mechanics'],
    );

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);

  it('is fully keyboard operable', async () => {
    renderEditor();

    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Create empty draft' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');

    await userEvent.tab();
    expect(screen.getByLabelText('Concept name')).toHaveFocus();
    await userEvent.keyboard('Physics');
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');

    expect(screen.getByRole('button', { name: 'Physics' })).toBeInTheDocument();
  });
});
