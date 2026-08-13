import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { emptyBody } from '../../authoring/body-draft.js';
import { StimulusEditor } from './StimulusEditor.js';
import {
  STIMULUS_FORM_ERROR_CODES,
  stimulusFormErrors,
  type ReferencingItem,
  type StimulusEditorApi,
  type StimulusSummary,
} from './stimulus-editor-model.js';

const ITEM_ID = '019fd4bc-3333-7000-8000-000000000001';

const PASSAGE: StimulusSummary = {
  stimulusId: 'stim-1',
  stimulusType: 'passage',
  label: 'Kinematics of a lift',
  publishedVersionNo: 2,
  latestVersionNo: 3,
};

interface Harness {
  readonly api: StimulusEditorApi;
  readonly attachments: { readonly itemId: string; readonly stimulusId: string }[];
  readonly created: { readonly stimulusType: string; readonly blockKinds: readonly string[] }[];
}

function harness(options: {
  readonly matches?: readonly StimulusSummary[];
  readonly referencing?: readonly ReferencingItem[];
  readonly pinnedVersionNo?: number;
} = {}): Harness {
  const attachments: { itemId: string; stimulusId: string }[] = [];
  const created: { stimulusType: string; blockKinds: readonly string[] }[] = [];

  const api: StimulusEditorApi = {
    async search() {
      return options.matches ?? [PASSAGE];
    },
    async referencingItems() {
      return options.referencing ?? [];
    },
    async attachToItem(input) {
      attachments.push(input);
      return { pinnedVersionNo: options.pinnedVersionNo ?? 2 };
    },
    async createDraft(input) {
      created.push({
        stimulusType: input.stimulusType,
        blockKinds: input.body.blocks.map((block) => block.kind),
      });
      return { stimulusId: 'stim-new' };
    },
  };

  return { api, attachments, created };
}

function renderEditor(api: StimulusEditorApi, overrides: Partial<Parameters<typeof StimulusEditor>[0]> = {}) {
  return render(<StimulusEditor api={api} itemId={ITEM_ID} principalMayAuthor {...overrides} />);
}

describe('stimulus form errors', () => {
  it('reports an empty stimulus and notation with no alternative', () => {
    expect(
      stimulusFormErrors({ stimulusType: 'passage', body: emptyBody() }).map((error) => error.code),
    ).toEqual(['STIMULUS_BODY_EMPTY']);

    const errors = stimulusFormErrors({
      stimulusType: 'passage',
      body: {
        blocks: [
          { kind: 'TEXT', value: 'Consider' },
          { kind: 'MATH', latex: 'a', textAlternative: ' ' },
        ],
      },
    });
    expect(errors.map((error) => error.code)).toEqual(['NOTATION_ALTERNATIVE_MISSING']);
    expect(errors[0]?.location).toBe('body.blocks[1]');
  });

  it('emits only codes from the closed list', () => {
    const errors = stimulusFormErrors({ stimulusType: 'passage', body: emptyBody() });
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(STIMULUS_FORM_ERROR_CODES).toContain(error.code);
  });
});

describe('attach-existing is offered before create-new (UX §10.1)', () => {
  // Asserted by document position, because "which one is first" is the whole
  // decision and the next person to edit the layout will not remember it.
  it('puts the attach section ahead of the create section in the document', () => {
    renderEditor(harness().api);

    const attach = screen.getByRole('heading', { name: 'Attach an existing stimulus' });
    const create = screen.getByRole('heading', { name: 'None of these — create a new stimulus' });
    expect(attach.compareDocumentPosition(create) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  it('says why, so the ordering is not just a layout accident', () => {
    renderEditor(harness().api);
    expect(screen.getByText(/Look for it before writing it again/u)).toBeInTheDocument();
  });
});

describe('the attach flow shows what already references the stimulus (FR-TCH-03)', () => {
  it('lists the referencing items before the attach button', async () => {
    const user = userEvent.setup();
    const { api } = harness({
      referencing: [
        { itemId: 'i1', label: 'Lift accelerating upward' },
        { itemId: 'i2', label: 'Apparent weight in a lift' },
      ],
    });
    renderEditor(api);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'Kinematics of a lift (passage)' }));

    const list = screen.getByRole('list', { name: 'Items already using this stimulus' });
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);

    const attachButton = screen.getByRole('button', { name: 'Attach to this item' });
    expect(list.compareDocumentPosition(attachButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeGreaterThan(0);
  });

  it('says plainly when nothing uses it yet', async () => {
    const user = userEvent.setup();
    renderEditor(harness().api);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'Kinematics of a lift (passage)' }));
    expect(screen.getByText('No item uses this yet.')).toBeInTheDocument();
  });

  // FR-TCH-03 rule 2: the attachment pins a version, and the author is told
  // which one — otherwise "the passage changed" is an unexplained surprise.
  it('attaches and reports the pinned version', async () => {
    const user = userEvent.setup();
    const { api, attachments } = harness({ pinnedVersionNo: 2 });
    renderEditor(api);

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'Kinematics of a lift (passage)' }));
    await user.click(screen.getByRole('button', { name: 'Attach to this item' }));

    expect(attachments).toEqual([{ itemId: ITEM_ID, stimulusId: 'stim-1' }]);
    expect(screen.getByRole('status')).toHaveTextContent(
      'pinned to version 2; editing the stimulus later will not move it',
    );
  });

  it('sends the author to create-new only when the search finds nothing', async () => {
    const user = userEvent.setup();
    renderEditor(harness({ matches: [] }).api);

    expect(screen.queryByText('Nothing matches that. Create one below.')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Search' }));
    expect(screen.getByText('Nothing matches that. Create one below.')).toBeInTheDocument();
  });
});

describe('creating a new stimulus', () => {
  it('is refused while the body is empty, and offered once it is not', async () => {
    const user = userEvent.setup();
    const { api, created } = harness();
    renderEditor(api);

    expect(screen.getByRole('button', { name: 'Create stimulus' })).toBeDisabled();

    await user.type(screen.getByLabelText('Stimulus text'), 'A lift accelerates upward at 2 m/s².');
    await user.click(screen.getByRole('button', { name: 'Create stimulus' }));

    expect(created).toEqual([{ stimulusType: 'passage', blockKinds: ['PARAGRAPH'] }]);
    expect(screen.getByRole('status')).toHaveTextContent('Stimulus created as a draft.');
  });

  it('carries the chosen stimulus type', async () => {
    const user = userEvent.setup();
    const { api, created } = harness();
    renderEditor(api);

    await user.selectOptions(screen.getByLabelText('Stimulus type'), 'reaction_scheme');
    await user.type(screen.getByLabelText('Stimulus text'), 'Esterification.');
    await user.click(screen.getByRole('button', { name: 'Create stimulus' }));

    expect(created[0]?.stimulusType).toBe('reaction_scheme');
  });

  it('refuses to create notation with no authored alternative (ACC-02)', async () => {
    const user = userEvent.setup();
    const { api, created } = harness();
    renderEditor(api);

    await user.type(screen.getByLabelText('Stimulus text'), 'Consider');
    await user.click(screen.getByRole('button', { name: 'Add an equation to stimulus' }));
    await user.type(screen.getByLabelText('Stimulus notation'), 'a = 2');

    expect(screen.getByRole('button', { name: 'Create stimulus' })).toBeDisabled();
    expect(screen.getByLabelText('Stimulus description')).toHaveAccessibleDescription(
      /Describe this expression in words/u,
    );

    await user.type(screen.getByLabelText('Stimulus description'), 'a equals two');
    await user.click(screen.getByRole('button', { name: 'Create stimulus' }));
    expect(created[0]?.blockKinds).toEqual(['PARAGRAPH', 'MATH_BLOCK']);
  });

  it('previews through the one renderer at the minimum device profile', async () => {
    const user = userEvent.setup();
    renderEditor(harness().api);

    await user.type(screen.getByLabelText('Stimulus text'), 'A lift accelerates.');
    expect(
      within(screen.getByRole('region', { name: 'Stimulus preview output' })).getByText(
        'A lift accelerates.',
      ),
    ).toBeInTheDocument();
  });
});

describe('accessibility', () => {
  it('refuses a principal who may not author', () => {
    renderEditor(harness().api, { principalMayAuthor: false });
    expect(screen.getByRole('alert')).toHaveTextContent('not permitted to author stimuli');
    expect(screen.queryByLabelText('Search stimuli')).toBeNull();
  });

  it('scans clean', async () => {
    const { container } = renderEditor(harness().api);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with a candidate selected and the palette open', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor(
      harness({ referencing: [{ itemId: 'i1', label: 'Lift accelerating upward' }] }).api,
    );

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.click(screen.getByRole('button', { name: 'Kinematics of a lift (passage)' }));
    await user.click(screen.getByLabelText('Palette'));
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
