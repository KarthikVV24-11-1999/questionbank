import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { InlineEditor } from './InlineEditor.js';
import { EDITABLE_FIELDS, reviewerEditsWireFields, type ReviewerEdits } from './review-workspace-model.js';

function renderEditor(onChange: (edits: ReviewerEdits | null) => void = () => undefined) {
  return render(
    <InlineEditor
      stemPreview={<p>the claimed stem, read only</p>}
      currentTaxonomyTags={[{ conceptIdentityId: 'concept-1', taxonomyVersionId: 'taxonomy-1', weight: 1, isPrimary: true }]}
      currentDifficultyEstimate="moderate"
      onChange={onChange}
    />,
  );
}

describe('exactly M4-08\'s editable fields, by enumeration (M4-40)', () => {
  it('offers a toggle for every EDITABLE_FIELDS entry', () => {
    renderEditor();
    expect(screen.getByLabelText('Edit the stem')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit taxonomy tags')).toBeInTheDocument();
    expect(screen.getByLabelText('Edit difficulty estimate')).toBeInTheDocument();
    expect(EDITABLE_FIELDS).toEqual(['stem', 'taxonomyTags', 'difficultyEstimate']);
  });

  it('renders no control for a field the wire schema carries but EDITABLE_FIELDS excludes', () => {
    const forbidden = reviewerEditsWireFields().filter(
      (field) => !(EDITABLE_FIELDS as readonly string[]).includes(field),
    );
    // The wire schema is a strict superset — there is something to prove exclusion of.
    expect(forbidden.length).toBeGreaterThan(0);

    renderEditor();
    for (const field of forbidden) {
      expect(screen.queryByLabelText(new RegExp(field, 'iu'))).toBeNull();
      expect(document.querySelector(`[name="${field}"], #${field}, [id*="${field}" i]`)).toBeNull();
    }
  });
});

describe('an out-of-scope edit is refused, stated rather than silently disabled (M4-40)', () => {
  it('renders why the response spec cannot be edited here', () => {
    renderEditor();
    expect(
      screen.getByText(/The answer key and response options cannot be edited from this screen/u),
    ).toBeInTheDocument();
    expect(screen.getByText(/Request changes/u)).toBeInTheDocument();
  });
});

describe('edits flow to the caller as they are made', () => {
  it('emits difficultyEstimate once its toggle is on and a value chosen', async () => {
    const user = userEvent.setup();
    const seen: (ReviewerEdits | null)[] = [];
    renderEditor((edits) => seen.push(edits));

    await user.click(screen.getByLabelText('Edit difficulty estimate'));
    await user.selectOptions(screen.getByLabelText('Difficulty estimate'), 'challenging');

    expect(seen.at(-1)).toEqual({ difficultyEstimate: 'challenging' });
  });

  it('emits null once every toggle is switched back off', async () => {
    const user = userEvent.setup();
    const seen: (ReviewerEdits | null)[] = [];
    renderEditor((edits) => seen.push(edits));

    await user.click(screen.getByLabelText('Edit difficulty estimate'));
    await user.click(screen.getByLabelText('Edit difficulty estimate'));
    expect(seen.at(-1)).toBeNull();
  });

  it('adds and edits a taxonomy tag', async () => {
    const user = userEvent.setup();
    const seen: (ReviewerEdits | null)[] = [];
    renderEditor((edits) => seen.push(edits));

    await user.click(screen.getByLabelText('Edit taxonomy tags'));
    await user.click(screen.getByRole('button', { name: 'Add tag' }));
    const last = seen.at(-1);
    expect(last?.taxonomyTags).toHaveLength(2);
  });
});

describe('accessibility (FRONTEND §7, §10)', () => {
  it('scans clean collapsed', async () => {
    const { container } = renderEditor();
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with every editor expanded', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor();
    await user.click(screen.getByLabelText('Edit the stem'));
    await user.click(screen.getByLabelText('Edit taxonomy tags'));
    await user.click(screen.getByLabelText('Edit difficulty estimate'));
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
