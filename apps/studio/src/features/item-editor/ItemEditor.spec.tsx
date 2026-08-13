import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MINIMUM_DEVICE_PROFILE, renderFor } from '@questionbank/content-renderer';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { ItemEditor } from './ItemEditor.js';
import { emptyBody, toContentBody } from '../../authoring/body-draft.js';
import {
  FORM_ERROR_CODES,
  itemEditorFormErrors,
  type ItemEditorApi,
  type ItemEditorDraft,
  type SaveDraftInput,
  type ValidationReport,
} from './item-editor-model.js';

const ITEM_ID = '019fd4bc-2222-7000-8000-000000000001';

function mcqDraft(overrides: Partial<ItemEditorDraft> = {}): ItemEditorDraft {
  return {
    itemId: ITEM_ID,
    itemType: 'SINGLE_CORRECT_MCQ',
    stem: { blocks: [{ kind: 'TEXT', value: 'A body accelerates uniformly.' }] },
    options: [
      { optionId: 'a', ordinal: 1, body: { blocks: [{ kind: 'TEXT', value: 'Two' }] }, misconception: '' },
      { optionId: 'b', ordinal: 2, body: { blocks: [{ kind: 'TEXT', value: 'Four' }] }, misconception: '' },
    ],
    correctOptionId: 'a',
    numeric: null,
    ...overrides,
  };
}

function numericDraft(overrides: Partial<ItemEditorDraft> = {}): ItemEditorDraft {
  return {
    itemId: ITEM_ID,
    itemType: 'NUMERIC',
    stem: { blocks: [{ kind: 'TEXT', value: 'Give g to two decimal places.' }] },
    options: [],
    correctOptionId: null,
    numeric: { expectedValue: '9.81', tolerance: '0.01', unit: 'm/s^2' },
    ...overrides,
  };
}

const CLEAN_REPORT: ValidationReport = {
  findings: [],
  maySubmit: true,
  duplicateCheckState: 'not_evaluated',
};

interface Harness {
  readonly saves: SaveDraftInput[];
  readonly submits: { readonly itemId: string; readonly expectedAggregateVersion: number }[];
  readonly api: ItemEditorApi;
}

function harness(options: {
  readonly report?: ValidationReport;
  readonly failSaves?: boolean;
  readonly holdFirstSave?: boolean;
  readonly submitOutcome?: { readonly ok: true } | { readonly ok: false; readonly message: string };
} = {}): Harness & { release(): void } {
  const saves: SaveDraftInput[] = [];
  const submits: { itemId: string; expectedAggregateVersion: number }[] = [];
  let release: () => void = () => undefined;
  let version = 3;

  const api: ItemEditorApi = {
    async saveDraft(input) {
      saves.push(input);
      if (options.holdFirstSave === true && saves.length === 1) {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      }
      if (options.failSaves === true) throw new Error('network');
      version += 1;
      return { aggregateVersion: version, report: options.report ?? CLEAN_REPORT };
    },
    async submitForReview(itemId, expectedAggregateVersion) {
      submits.push({ itemId, expectedAggregateVersion });
      return options.submitOutcome ?? { ok: true };
    },
  };

  return { saves, submits, api, release: () => release() };
}

function renderEditor(
  api: ItemEditorApi,
  overrides: Partial<Parameters<typeof ItemEditor>[0]> = {},
) {
  return render(
    <ItemEditor
      api={api}
      initialDraft={mcqDraft()}
      initialAggregateVersion={3}
      principalMayAuthor
      autosaveDelayMs={20}
      {...overrides}
    />,
  );
}

/* ------------------------------------------------------------------ *
 * The model
 * ------------------------------------------------------------------ */

describe('form errors name a field, never a governance rule', () => {
  it('reports an empty stem', () => {
    const errors = itemEditorFormErrors(mcqDraft({ stem: emptyBody() }));
    expect(errors.map((error) => error.code)).toContain('STEM_EMPTY');
  });

  it('reports an empty option body, naming which option', () => {
    const draft = mcqDraft({
      options: [
        { optionId: 'a', ordinal: 1, body: emptyBody(), misconception: '' },
        { optionId: 'b', ordinal: 2, body: { blocks: [{ kind: 'TEXT', value: 'Four' }] }, misconception: '' },
      ],
    });
    const error = itemEditorFormErrors(draft).find((candidate) => candidate.code === 'OPTION_BODY_EMPTY');
    expect(error?.location).toBe('options[a]');
    expect(error?.fieldId).toBe('option-a-block-0');
  });

  it('reports notation with no authored alternative, per block (ACC-02)', () => {
    const draft = mcqDraft({
      stem: {
        blocks: [
          { kind: 'TEXT', value: 'Solve' },
          { kind: 'MATH', latex: 'x^{2}', textAlternative: '   ' },
        ],
      },
    });
    const error = itemEditorFormErrors(draft).find(
      (candidate) => candidate.code === 'NOTATION_ALTERNATIVE_MISSING',
    );
    expect(error?.location).toBe('stem.blocks[1]');
  });

  it('reports an unchosen correct option, and nothing once one is chosen', () => {
    expect(
      itemEditorFormErrors(mcqDraft({ correctOptionId: null })).map((error) => error.code),
    ).toContain('CORRECT_OPTION_UNCHOSEN');
    expect(itemEditorFormErrors(mcqDraft())).toEqual([]);
  });

  it('reports a numeric answer that is missing or is not a decimal literal', () => {
    expect(
      itemEditorFormErrors(numericDraft({ numeric: { expectedValue: '', tolerance: '', unit: '' } })).map(
        (error) => error.code,
      ),
    ).toContain('NUMERIC_EXPECTED_VALUE_MISSING');
    expect(
      itemEditorFormErrors(
        numericDraft({ numeric: { expectedValue: 'nine', tolerance: '', unit: '' } }),
      ).map((error) => error.code),
    ).toContain('NUMERIC_EXPECTED_VALUE_NOT_DECIMAL');
    expect(itemEditorFormErrors(numericDraft())).toEqual([]);
  });

  it('accepts the decimal forms an author actually writes', () => {
    for (const literal of ['0.1', '0.10', '9.81', '-273.15', '+5', '.5', '6e23', '1.6E-19']) {
      expect(
        itemEditorFormErrors(
          numericDraft({ numeric: { expectedValue: literal, tolerance: '', unit: '' } }),
        ),
        literal,
      ).toEqual([]);
    }
  });

  it('emits only codes from the closed list', () => {
    const draft = mcqDraft({
      stem: { blocks: [{ kind: 'MATH', latex: 'x', textAlternative: '' }] },
      options: [{ optionId: 'a', ordinal: 1, body: emptyBody(), misconception: '' }],
      correctOptionId: null,
    });
    const errors = itemEditorFormErrors(draft);
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) {
      expect(FORM_ERROR_CODES, error.code).toContain(error.code);
      expect(error.location.length, error.code).toBeGreaterThan(0);
      expect(error.message, error.code).not.toBe('Invalid item');
    }
  });
});

/* ------------------------------------------------------------------ *
 * The surface
 * ------------------------------------------------------------------ */

describe('the authoring policy gates the surface (DEC-4)', () => {
  it('shows no answer key at all to a principal who may not author', () => {
    const { api } = harness();
    renderEditor(api, { principalMayAuthor: false });

    expect(screen.getByRole('alert')).toHaveTextContent('not permitted to author');
    expect(screen.queryByRole('group', { name: 'Correct option' })).toBeNull();
    expect(screen.queryByRole('radio', { name: 'Option 1 is correct' })).toBeNull();
  });

  it('offers the key to a principal who may', () => {
    const { api } = harness();
    renderEditor(api);
    expect(screen.getByRole('radio', { name: 'Option 1 is correct' })).toBeChecked();
  });
});

describe('the live preview is the delivery render (UX §10.1, INV-14)', () => {
  /**
   * Both sides through the CSSOM. `renderToStaticMarkup` writes a style
   * attribute as authored (`color:x`) while React's client render sets it
   * through the CSSOM and reads back `color: x;` — a spelling difference with
   * nothing diverged behind it. Re-setting the parsed attribute from
   * `style.cssText` puts the delivery side through the same normalization and
   * leaves every real difference standing; the planted-divergence test below
   * shows the instrument still fails.
   */
  const throughTheDom = (html: string): string => {
    const host = document.createElement('div');
    host.innerHTML = html;
    for (const element of host.querySelectorAll<HTMLElement>('[style]')) {
      element.setAttribute('style', element.style.cssText);
    }
    return host.innerHTML;
  };

  const previewHtml = (): string =>
    screen.getByRole('region', { name: 'Preview output' }).innerHTML;

  const deliveryHtml = (
    ...args: Parameters<typeof renderFor>
  ): string => throughTheDom(renderFor(...args).html);

  it('defaults to the minimum device profile, not desktop', () => {
    const { api } = harness();
    renderEditor(api);

    expect(screen.getByLabelText('Preview surface')).toHaveValue(MINIMUM_DEVICE_PROFILE);
    const stem = toContentBody(mcqDraft().stem);
    expect(previewHtml()).toBe(deliveryHtml(stem, MINIMUM_DEVICE_PROFILE));
    expect(previewHtml()).not.toBe(deliveryHtml(stem, 'web'));
  });

  it('renders through the one renderer, so the preview equals what a student is served', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), ' Find its speed.');

    const expected = toContentBody({
      blocks: [{ kind: 'TEXT', value: 'A body accelerates uniformly. Find its speed.' }],
    });
    expect(previewHtml()).toBe(deliveryHtml(expected, MINIMUM_DEVICE_PROFILE));
  });

  // The comparison is shown to fail before it is trusted to pass.
  it('catches a divergence between the two renders', () => {
    const { api } = harness();
    renderEditor(api);

    const diverged = toContentBody({ blocks: [{ kind: 'TEXT', value: 'Something else entirely.' }] });
    expect(previewHtml()).not.toBe(deliveryHtml(diverged, MINIMUM_DEVICE_PROFILE));
  });

  it('follows the surface the author selects', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api);

    await user.selectOptions(screen.getByLabelText('Preview surface'), 'print');
    expect(previewHtml()).toBe(deliveryHtml(toContentBody(mcqDraft().stem), 'print'));
  });
});

describe('dual-mode notation input, switchable mid-item (UX §10.1)', () => {
  const withMath = mcqDraft({
    stem: {
      blocks: [
        { kind: 'TEXT', value: 'Evaluate' },
        { kind: 'MATH', latex: '', textAlternative: 'the expression' },
      ],
    },
  });

  it('carries typed LaTeX into palette mode and back, unchanged', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api, { initialDraft: withMath });

    await user.type(screen.getByLabelText('Stem notation'), 'v = u + at');
    await user.click(screen.getByLabelText('Palette'));
    expect(screen.getByLabelText('Stem notation')).toHaveValue('v = u + at');

    await user.click(screen.getByLabelText('LaTeX'));
    expect(screen.getByLabelText('Stem notation')).toHaveValue('v = u + at');
  });

  it('carries a palette insertion into LaTeX mode and back, unchanged', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api, { initialDraft: withMath });

    await user.click(screen.getByLabelText('Palette'));
    await user.click(
      within(screen.getByRole('group', { name: 'Stem notation palette' })).getByRole('button', {
        name: 'Fraction',
      }),
    );
    expect(screen.getByLabelText('Stem notation')).toHaveValue('\\frac{}{}');

    await user.click(screen.getByLabelText('LaTeX'));
    await user.type(screen.getByLabelText('Stem notation'), 'g');
    await user.click(screen.getByLabelText('Palette'));
    expect(screen.getByLabelText('Stem notation')).toHaveValue('\\frac{}{}g');
  });

  it('shows the palette only in palette mode, so a fluent author is not crowded', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api, { initialDraft: withMath });

    expect(screen.queryByRole('group', { name: 'Stem notation palette' })).toBeNull();
    await user.click(screen.getByLabelText('Palette'));
    expect(screen.getByRole('group', { name: 'Stem notation palette' })).toBeInTheDocument();
  });

  it('names every part of the expression, including what it does not recognise', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api, { initialDraft: withMath });

    await user.type(screen.getByLabelText('Stem notation'), 'a\\theta');
    await user.click(screen.getByLabelText('Palette'));

    const parts = within(screen.getByRole('list', { name: 'Stem expression parts' })).getAllByRole(
      'listitem',
    );
    expect(parts.map((part) => part.textContent)).toEqual(['typed: a', 'theta']);
  });
});

describe('options are authored as ContentBody, so an option can be an equation', () => {
  it('adds an equation to an option and saves it as a MATH block', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    await user.click(screen.getByRole('button', { name: 'Add an equation to option 1' }));
    await user.type(screen.getByLabelText('Option 1 notation'), 'x^{2}');
    await user.type(screen.getByLabelText('Option 1 description'), 'x squared');

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    const saved = saves[saves.length - 1] as SaveDraftInput;
    const optionBody = toContentBody(
      (saved.draft.options[0] as NonNullable<(typeof saved.draft.options)[0]>).body,
    );
    expect(optionBody.blocks.map((block) => block.kind)).toEqual(['PARAGRAPH', 'MATH_BLOCK']);
  });
});

describe('distractor authoring prompts for the misconception (UX §10.1)', () => {
  it('prompts on every incorrect option and on no correct one', () => {
    const { api } = harness();
    renderEditor(api);

    expect(
      screen.getByLabelText('What misconception leads a student to option 2?'),
    ).toBeInTheDocument();
    expect(
      screen.queryByLabelText('What misconception leads a student to option 1?'),
    ).toBeNull();
  });

  it('carries the misconception to the save, addressed to its option', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    await user.type(
      screen.getByLabelText('What misconception leads a student to option 2?'),
      'Doubled instead of squaring.',
    );

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    const saved = saves[saves.length - 1] as SaveDraftInput;
    expect(saved.misconceptions).toEqual([
      { optionId: 'b', text: 'Doubled instead of squaring.' },
    ]);
  });
});

describe('autosave (FRONTEND §7, M3-25)', () => {
  it('debounces a burst of keystrokes into one save', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api, { autosaveDelayMs: 150 });

    await user.type(screen.getByLabelText('Stem text'), 'abcdef');
    await waitFor(() => expect(saves.length).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 250));
    expect(saves).toHaveLength(1);
  });

  it('carries an idempotency key on every save, so a retransmission is a no-op', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');
    await waitFor(() => expect(saves.length).toBe(1));
    await user.type(screen.getByLabelText('Stem text'), 'b');
    await waitFor(() => expect(saves.length).toBe(2));

    const keys = saves.map((save) => save.idempotencyKey);
    expect(new Set(keys).size).toBe(2);
    for (const key of keys) expect(key.startsWith(`${ITEM_ID}:`)).toBe(true);
  });

  it('advances the expected aggregate version, so the next save is not a stale write', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');
    await waitFor(() => expect(saves.length).toBe(1));
    await user.type(screen.getByLabelText('Stem text'), 'b');
    await waitFor(() => expect(saves.length).toBe(2));

    expect(saves[0]?.expectedAggregateVersion).toBe(3);
    expect(saves[1]?.expectedAggregateVersion).toBe(4);
  });

  // Losing forty minutes of equation authoring ends the relationship with that
  // author, and the way it happens is a keystroke landing mid-flight.
  it('does not lose a keystroke typed while a save is in flight', async () => {
    const user = userEvent.setup();
    const { api, saves, release } = harness({ holdFirstSave: true });
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'X');
    await waitFor(() => expect(saves.length).toBe(1));

    await user.type(screen.getByLabelText('Stem text'), 'Y');
    release();

    await waitFor(() => expect(saves.length).toBe(2));
    const first = saves[0] as SaveDraftInput;
    const second = saves[1] as SaveDraftInput;
    expect(first.draft.stem.blocks[0]).toEqual({
      kind: 'TEXT',
      value: 'A body accelerates uniformly.X',
    });
    expect(second.draft.stem.blocks[0]).toEqual({
      kind: 'TEXT',
      value: 'A body accelerates uniformly.XY',
    });
  });

  it('says so out loud when a save fails, rather than leaving a quiet "saved"', async () => {
    const user = userEvent.setup();
    const { api } = harness({ failSaves: true });
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('Autosave failed'),
    );
  });
});

describe('validation is continuous and inline, blocking only at submit (UX §10.1)', () => {
  const REPORT_WITH_FINDINGS: ValidationReport = {
    findings: [
      {
        code: 'SOLUTION_MISSING',
        severity: 'blocking',
        message: 'This item has no published solution.',
        location: 'version.solution',
      },
      {
        code: 'DISTRACTOR_ANALYSIS_MISSING',
        severity: 'warning',
        message: 'Option 2 has no distractor analysis.',
        location: 'version.responseSpec.options[b]',
      },
    ],
    maySubmit: false,
    duplicateCheckState: 'not_evaluated',
  };

  it('groups the domain findings as blocking and warning, each with its location', async () => {
    const user = userEvent.setup();
    const { api } = harness({ report: REPORT_WITH_FINDINGS });
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');

    const panel = screen.getByRole('region', { name: 'Validation' });
    await waitFor(() =>
      expect(
        within(panel).getByText(
          'This item has no published solution. (version.solution)',
        ),
      ).toBeInTheDocument(),
    );
    expect(
      within(panel).getByText(
        'Option 2 has no distractor analysis. (version.responseSpec.options[b])',
      ),
    ).toBeInTheDocument();
  });

  it('states that duplicate detection has not run, rather than implying none were found', async () => {
    const user = userEvent.setup();
    const { api } = harness({ report: REPORT_WITH_FINDINGS });
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');
    await waitFor(() =>
      expect(screen.getByText('Duplicate check: not evaluated.')).toBeInTheDocument(),
    );
  });

  it('surfaces a form error inline, bound to its field by aria-describedby', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api);

    await user.clear(screen.getByLabelText('Stem text'));

    const field = screen.getByLabelText('Stem text');
    expect(field).toHaveAccessibleDescription('The question stem is empty.');
  });

  it('does not block editing while a problem stands', async () => {
    const user = userEvent.setup();
    const { api } = harness();
    renderEditor(api);

    await user.clear(screen.getByLabelText('Stem text'));
    await user.type(screen.getByLabelText('Stem text'), 'Recovered.');
    expect(screen.getByLabelText('Stem text')).toHaveValue('Recovered.');
    expect(screen.getByLabelText('Stem text')).not.toHaveAccessibleDescription();
  });

  it('refuses submission on a blocking finding and does not call the command', async () => {
    const user = userEvent.setup();
    const { api, submits } = harness({ report: REPORT_WITH_FINDINGS });
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');
    await waitFor(() => expect(screen.getByText(/no published solution/u)).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(submits).toHaveLength(0);

    const summary = screen.getByRole('alert', { name: 'This item cannot be submitted yet' });
    expect(within(summary).getByText(/no published solution/u)).toBeInTheDocument();
  });

  it('moves focus to the error summary, which links to the field (FRONTEND §7)', async () => {
    const user = userEvent.setup();
    const { api, submits } = harness();
    renderEditor(api);

    await user.clear(screen.getByLabelText('Stem text'));
    await waitFor(() => expect(screen.getByLabelText('Stem text')).toHaveAccessibleDescription());

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(submits).toHaveLength(0);

    const summary = screen.getByRole('alert', { name: 'This item cannot be submitted yet' });
    expect(summary).toHaveFocus();
    expect(within(summary).getByRole('link', { name: /The question stem is empty/u })).toHaveAttribute(
      'href',
      '#stem-block-0',
    );
  });

  it('submits when the domain says it may, carrying the current aggregate version', async () => {
    const user = userEvent.setup();
    const { api, submits } = harness();
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');
    await waitFor(() => expect(screen.getByText('Duplicate check: not evaluated.')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() => expect(screen.getByRole('status')).toHaveTextContent('Submitted for review.'));
    expect(submits).toEqual([{ itemId: ITEM_ID, expectedAggregateVersion: 4 }]);
  });

  // The client check is a courtesy; the server is the authority, and when it
  // refuses the author is told what it said rather than being left guessing.
  it('reports a server refusal even when the client believed it was submittable', async () => {
    const user = userEvent.setup();
    const { api } = harness({
      submitOutcome: { ok: false, message: 'A reviewer signature is required.' },
    });
    renderEditor(api);

    await user.type(screen.getByLabelText('Stem text'), 'a');
    await waitFor(() => expect(screen.getByText('Duplicate check: not evaluated.')).toBeInTheDocument());

    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent('A reviewer signature is required.'),
    );
  });
});

describe('the editor derives no governance finding', () => {
  // The panel displays the domain's findings; it does not derive them. An
  // editor that named a blocking code would be a second validator, and the two
  // would disagree the first time either changed.
  it('names no domain finding code of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');

    const source = [
      readFileSync(join('src', 'features', 'item-editor', 'ItemEditor.tsx'), 'utf8'),
      readFileSync(join('src', 'features', 'item-editor', 'item-editor-model.ts'), 'utf8'),
    ].join('\n');

    const domainCodes = [
      'ANSWER_KEY_MISSING',
      'NUMERIC_TOLERANCE_MISSING',
      'CONCEPT_TAG_MISSING',
      'LICENSING_UNRESOLVED',
      'NOTATION_UNRENDERABLE',
      'SOLUTION_MISSING',
      'PROBABLE_DUPLICATE',
      'CONCEPT_OUT_OF_DECLARED_SCOPE',
      'DIFFICULTY_UNUSUAL',
      'DISTRACTOR_ANALYSIS_MISSING',
    ];
    expect(domainCodes.filter((code) => source.includes(code))).toEqual([]);
  });
});

describe('accessibility (FRONTEND §7, §10)', () => {
  it('labels every form control programmatically', () => {
    const { container } = renderEditor(harness().api);
    const controls = [...container.querySelectorAll('input, textarea, select')];
    expect(controls.length).toBeGreaterThan(5);

    for (const control of controls) {
      const id = control.getAttribute('id');
      const labelled =
        control.getAttribute('aria-label') !== null ||
        (id !== null && container.querySelector(`label[for="${id}"]`) !== null);
      expect(labelled, control.outerHTML).toBe(true);
    }
  });

  it('scans clean on an MCQ', async () => {
    const { container } = renderEditor(harness().api);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean on a numeric item', async () => {
    const { container } = renderEditor(harness().api, { initialDraft: numericDraft() });
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with the palette open and an error showing', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor(harness().api, {
      initialDraft: mcqDraft({
        stem: { blocks: [{ kind: 'MATH', latex: 'x', textAlternative: '' }] },
      }),
    });
    await user.click(screen.getByLabelText('Palette'));
    await user.click(screen.getByRole('button', { name: 'Submit for review' }));
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean at the refusal', async () => {
    const { container } = renderEditor(harness().api, { principalMayAuthor: false });
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});

describe('the editor keeps no timer running after it is gone', () => {
  it('clears a pending autosave on unmount', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    const { unmount } = renderEditor(api, { autosaveDelayMs: 200 });

    await user.type(screen.getByLabelText('Stem text'), 'a');
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(saves).toHaveLength(0);
  });
});

describe('the shell wiring stays absent (DEC-5)', () => {
  it('imports no router', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const scanned = ['ItemEditor.tsx', 'item-editor-model.ts'];
    for (const file of scanned) {
      const source = readFileSync(join('src', 'features', 'item-editor', file), 'utf8');
      expect(source, file).not.toMatch(/from '(react-router|@tanstack\/react-router|wouter)/u);
    }
    expect(scanned).toHaveLength(2);
  });
});
