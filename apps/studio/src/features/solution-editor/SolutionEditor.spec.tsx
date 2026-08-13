import { describe, expect, it } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContentBody } from '@questionbank/content-renderer';
import { accessibilityViolations } from '../../testing/accessibility.js';
import { emptyBody, toContentBody } from '../../authoring/body-draft.js';
import { SolutionEditor } from './SolutionEditor.js';
import {
  SOLUTION_FORM_ERROR_CODES,
  moveStep,
  solutionFormErrors,
  toStepCommands,
  type SolutionDraft,
  type SolutionEditorApi,
  type SolutionTargetItem,
  type StepDraft,
} from './solution-editor-model.js';

const ITEM_VERSION_ID = '019fd4bc-4444-7000-8000-000000000001';

function text(value: string): ContentBody {
  return toContentBody({ blocks: [{ kind: 'TEXT', value }] });
}

const ITEM: SolutionTargetItem = {
  itemVersionId: ITEM_VERSION_ID,
  itemType: 'SINGLE_CORRECT_MCQ',
  stem: text('A lift accelerates upward at 2 m/s².'),
  options: [
    { optionId: 'a', ordinal: 1, body: text('11.81 N per kilogram') },
    { optionId: 'b', ordinal: 2, body: text('7.81 N per kilogram') },
  ],
  correctOptionId: 'a',
};

function step(id: string, value: string): StepDraft {
  return { stepId: id, body: { blocks: [{ kind: 'TEXT', value }] } };
}

function draft(overrides: Partial<SolutionDraft> = {}): SolutionDraft {
  return {
    solutionId: 'sol-1',
    targetItemVersionId: ITEM_VERSION_ID,
    finalAnswer: { kind: 'OPTION', optionId: 'a' },
    steps: [step('s1', 'Take upward as positive.'), step('s2', 'Add g and a.')],
    distractorAnalyses: {},
    ...overrides,
  };
}

interface Saved {
  readonly finalAnswer: SolutionDraft['finalAnswer'];
  readonly ordinals: readonly number[];
  readonly stepTexts: readonly string[];
  readonly analyses: readonly string[];
  readonly idempotencyKey: string;
}

function harness(options: { readonly disagreement?: string } = {}): {
  readonly api: SolutionEditorApi;
  readonly saves: Saved[];
} {
  const saves: Saved[] = [];
  const api: SolutionEditorApi = {
    async saveDraft(input) {
      saves.push({
        finalAnswer: input.finalAnswer,
        ordinals: input.steps.map((s) => s.ordinal),
        stepTexts: input.steps.map((s) => JSON.stringify(s.body)),
        analyses: input.distractorAnalyses.map((a) => a.optionId),
        idempotencyKey: input.idempotencyKey,
      });
      if (options.disagreement !== undefined) {
        return { ok: false, disagreement: options.disagreement };
      }
      return { ok: true };
    },
  };
  return { api, saves };
}

function renderEditor(
  api: SolutionEditorApi,
  overrides: Partial<Parameters<typeof SolutionEditor>[0]> = {},
) {
  return render(
    <SolutionEditor
      api={api}
      item={ITEM}
      initialDraft={draft()}
      principalMayAuthor
      autosaveDelayMs={20}
      {...overrides}
    />,
  );
}

describe('step order is a position, not an authored number (M3-13)', () => {
  it('moves a step one place and leaves the ends alone', () => {
    const steps = [step('a', 'A'), step('b', 'B'), step('c', 'C')];
    expect(moveStep(steps, 1, -1).map((s) => s.stepId)).toEqual(['b', 'a', 'c']);
    expect(moveStep(steps, 1, 1).map((s) => s.stepId)).toEqual(['a', 'c', 'b']);
    expect(moveStep(steps, 0, -1)).toBe(steps);
    expect(moveStep(steps, 2, 1)).toBe(steps);
  });

  it('numbers the commands from the order on screen, contiguously from one', () => {
    const steps = [step('a', 'A'), step('b', 'B'), step('c', 'C')];
    expect(toStepCommands(moveStep(steps, 0, 1)).map((s) => s.ordinal)).toEqual([1, 2, 3]);
    expect(toStepCommands(moveStep(steps, 0, 1)).map((s) => JSON.stringify(s.body))).toEqual(
      [text('B'), text('A'), text('C')].map((body) => JSON.stringify(body)),
    );
  });
});

describe('solution form errors', () => {
  it('requires at least one step', () => {
    expect(solutionFormErrors(draft({ steps: [] })).map((error) => error.code)).toContain(
      'STEPS_REQUIRED',
    );
  });

  it('names an empty step by its position', () => {
    const errors = solutionFormErrors(
      draft({ steps: [step('s1', 'Take upward as positive.'), { stepId: 's2', body: emptyBody() }] }),
    );
    const empty = errors.find((error) => error.code === 'STEP_BODY_EMPTY');
    expect(empty?.message).toBe('Step 2 is empty.');
    expect(empty?.location).toBe('steps[1]');
  });

  it('requires the solution to state its final answer, per answer kind', () => {
    expect(
      solutionFormErrors(draft({ finalAnswer: { kind: 'OPTION', optionId: null } })).map(
        (error) => error.code,
      ),
    ).toContain('FINAL_ANSWER_MISSING');
    expect(
      solutionFormErrors(draft({ finalAnswer: { kind: 'NUMERIC', value: '  ' } })).map(
        (error) => error.code,
      ),
    ).toContain('FINAL_ANSWER_MISSING');
    expect(solutionFormErrors(draft({ finalAnswer: { kind: 'NUMERIC', value: '11.81' } }))).toEqual([]);
  });

  it('emits only codes from the closed list', () => {
    const errors = solutionFormErrors(
      draft({
        steps: [{ stepId: 's1', body: { blocks: [{ kind: 'MATH', latex: 'a', textAlternative: '' }] } }],
        finalAnswer: { kind: 'OPTION', optionId: null },
      }),
    );
    expect(errors.length).toBeGreaterThan(0);
    for (const error of errors) expect(SOLUTION_FORM_ERROR_CODES).toContain(error.code);
  });
});

describe('the item and its key sit alongside the explanation', () => {
  it('renders the stem and every option through the one renderer', () => {
    renderEditor(harness().api);

    expect(
      within(screen.getByRole('region', { name: 'Item stem' })).getByText(
        'A lift accelerates upward at 2 m/s².',
      ),
    ).toBeInTheDocument();
    expect(
      within(screen.getByRole('region', { name: 'Option 1 body' })).getByText('11.81 N per kilogram'),
    ).toBeInTheDocument();
  });

  it('marks which option is the key', () => {
    renderEditor(harness().api);
    expect(screen.getByText('Option 1 — the key')).toBeInTheDocument();
    expect(screen.getByText('Option 2 — a distractor')).toBeInTheDocument();
  });
});

describe('final-answer disagreement surfaces immediately (M3-14)', () => {
  // Not at submit. The learner who reads a derivation ending in 9.8, answers
  // 9.8 and is marked wrong is entirely right to dispute it, and this is the
  // cheapest moment to catch that.
  it('shows the domain refusal as soon as autosave runs, with no submit', async () => {
    const user = userEvent.setup();
    const { api } = harness({
      disagreement: 'The stated answer is option 2; the key is option 1.',
    });
    renderEditor(api);

    await user.selectOptions(screen.getByLabelText('The solution concludes'), 'b');

    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(
        'The stated answer is option 2; the key is option 1.',
      ),
    );
    expect(screen.queryByRole('button', { name: /submit/iu })).toBeNull();
  });

  it('clears once the author agrees with the key again', async () => {
    const user = userEvent.setup();
    let disagree = true;
    const api: SolutionEditorApi = {
      async saveDraft() {
        return disagree ? { ok: false, disagreement: 'Disagrees with the key.' } : { ok: true };
      },
    };
    renderEditor(api);

    await user.selectOptions(screen.getByLabelText('The solution concludes'), 'b');
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    disagree = false;
    await user.selectOptions(screen.getByLabelText('The solution concludes'), 'a');
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
  });

  // The comparison is scoring's, reached through the domain — a browser-side
  // one would be a second opinion, and the one the author saw would be wrong.
  it('computes no agreement of its own', async () => {
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const scanned = ['SolutionEditor.tsx', 'solution-editor-model.ts'];
    for (const file of scanned) {
      const source = readFileSync(join('src', 'features', 'solution-editor', file), 'utf8');
      expect(source, file).not.toMatch(/tolerance|Number\.parseFloat|parseFloat/u);
    }
    expect(scanned).toHaveLength(2);
  });
});

describe('step reordering is drag-free and keyboard-operable', () => {
  it('reorders by keyboard alone', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    const moveDown = screen.getByRole('button', { name: 'Move step 1 down' });
    moveDown.focus();
    expect(moveDown).toHaveFocus();
    await user.keyboard('{Enter}');

    expect(screen.getByLabelText('Step 1 text')).toHaveValue('Add g and a.');
    expect(screen.getByLabelText('Step 2 text')).toHaveValue('Take upward as positive.');

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    const saved = saves[saves.length - 1] as Saved;
    expect(saved.ordinals).toEqual([1, 2]);
    expect(saved.stepTexts[0]).toBe(JSON.stringify(text('Add g and a.')));
  });

  it('is reachable by tabbing, and the ends are disabled rather than absent', async () => {
    const user = userEvent.setup();
    renderEditor(harness().api);

    expect(screen.getByRole('button', { name: 'Move step 1 up' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Move step 2 down' })).toBeDisabled();

    screen.getByLabelText('Step 1 text').focus();
    await user.tab();
    await user.tab();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Move step 1 down' })).toHaveFocus();
  });

  it('adds a step and saves it in position', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    await user.click(screen.getByRole('button', { name: 'Add a step' }));
    await user.type(screen.getByLabelText('Step 3 text'), 'Multiply by the mass.');

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect((saves[saves.length - 1] as Saved).ordinals).toEqual([1, 2, 3]);
  });
});

describe('distractor analysis is prompted per incorrect option, with the option shown', () => {
  it('prompts for every distractor and for no correct option', () => {
    renderEditor(harness().api);

    expect(screen.getByLabelText('Misconception behind option 2 text')).toBeInTheDocument();
    expect(screen.queryByLabelText('Misconception behind option 1 text')).toBeNull();
  });

  it('shows the option as authored beside the prompt', () => {
    renderEditor(harness().api);
    expect(
      within(screen.getByRole('region', { name: 'Option 2 as authored' })).getByText(
        '7.81 N per kilogram',
      ),
    ).toBeInTheDocument();
  });

  it('saves the analysis against its option', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    await user.type(
      screen.getByLabelText('Misconception behind option 2 text'),
      'Subtracted the acceleration instead of adding it.',
    );

    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect((saves[saves.length - 1] as Saved).analyses).toEqual(['b']);
  });

  it('says so when there are no distractors to analyse', () => {
    renderEditor(harness().api, {
      item: { ...ITEM, options: [{ optionId: 'a', ordinal: 1, body: text('Only one') }] },
    });
    expect(screen.getByText('This item has no distractors to analyse.')).toBeInTheDocument();
  });
});

describe('autosave', () => {
  it('carries an idempotency key derived from the solution', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api);

    await user.type(screen.getByLabelText('Step 1 text'), '!');
    await waitFor(() => expect(saves.length).toBe(1));
    expect((saves[0] as Saved).idempotencyKey).toBe('sol-1:1');
  });

  it('says so when a save does not land', async () => {
    const user = userEvent.setup();
    const api: SolutionEditorApi = {
      async saveDraft() {
        throw new Error('network');
      },
    };
    renderEditor(api);

    await user.type(screen.getByLabelText('Step 1 text'), '!');
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Autosave failed'));
  });
});

describe('a numeric item states its final answer as an authored literal', () => {
  const numericItem: SolutionTargetItem = {
    itemVersionId: ITEM_VERSION_ID,
    itemType: 'NUMERIC',
    stem: text('Give the apparent weight per kilogram.'),
    options: [],
    correctOptionId: null,
  };

  it('keeps the literal as text, trailing zero and all (ADR-0007)', async () => {
    const user = userEvent.setup();
    const { api, saves } = harness();
    renderEditor(api, {
      item: numericItem,
      initialDraft: draft({ finalAnswer: { kind: 'NUMERIC', value: '' } }),
    });

    await user.type(screen.getByLabelText('The solution concludes'), '11.810');
    await waitFor(() => expect(saves.length).toBeGreaterThan(0));
    expect((saves[saves.length - 1] as Saved).finalAnswer).toEqual({
      kind: 'NUMERIC',
      value: '11.810',
    });
  });

  it('binds the missing-answer error to the field', async () => {
    const user = userEvent.setup();
    renderEditor(harness().api, {
      item: numericItem,
      initialDraft: draft({ finalAnswer: { kind: 'NUMERIC', value: '9.8' } }),
    });

    await user.clear(screen.getByLabelText('The solution concludes'));
    expect(screen.getByLabelText('The solution concludes')).toHaveAccessibleDescription(
      'The solution does not state its final answer.',
    );
  });
});

describe('accessibility', () => {
  it('refuses a principal who may not author', () => {
    renderEditor(harness().api, { principalMayAuthor: false });
    expect(screen.getByRole('alert')).toHaveTextContent('not permitted to author solutions');
    expect(screen.queryByLabelText('The solution concludes')).toBeNull();
  });

  it('scans clean', async () => {
    const { container } = renderEditor(harness().api);
    expect(await accessibilityViolations(container)).toEqual([]);
  });

  it('scans clean with no steps and the palette open', async () => {
    const user = userEvent.setup();
    const { container } = renderEditor(harness().api, { initialDraft: draft({ steps: [] }) });
    await user.click(screen.getByLabelText('Palette'));
    expect(await accessibilityViolations(container)).toEqual([]);
  });
});
