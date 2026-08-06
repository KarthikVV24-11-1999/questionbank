import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ExamProfileVersionDetail, MarkingRuleSet } from '@questionbank/contracts';
import { ExamProfileViewer } from './ExamProfileViewer.js';
import { describeAward, describeCondition, describeRule } from './marking-rule-language.js';
import { FakeCurriculumClient } from '../../testing/fake-curriculum-client.js';
import { accessibilityViolations } from '../../testing/accessibility.js';

const JEE_MAIN_RULES: MarkingRuleSet = {
  schemaVersion: 1,
  rules: [
    { id: 'unattempted', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] }, condition: { kind: 'UNATTEMPTED' }, award: { kind: 'FIXED', marks: 0 } },
    { id: 'correct', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] }, condition: { kind: 'EXACT_MATCH' }, award: { kind: 'FIXED', marks: 4 } },
    { id: 'incorrect', appliesTo: { itemTypes: ['SINGLE_CORRECT_MCQ'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: -1 } },
  ],
};

const JEE_ADVANCED_RULES: MarkingRuleSet = {
  schemaVersion: 1,
  rules: [
    { id: 'unattempted', appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'] }, condition: { kind: 'UNATTEMPTED' }, award: { kind: 'FIXED', marks: 0 } },
    { id: 'any-incorrect', appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'] }, condition: { kind: 'ANY_INCORRECT_SELECTED' }, award: { kind: 'FIXED', marks: -2 } },
    { id: 'all-correct', appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'] }, condition: { kind: 'ALL_CORRECT_SELECTED' }, award: { kind: 'FIXED', marks: 4 } },
    { id: 'three-correct', appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'] }, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 3, noIncorrect: true }, award: { kind: 'FIXED', marks: 3 } },
    { id: 'two-correct', appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'] }, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 2, noIncorrect: true }, award: { kind: 'FIXED', marks: 2 } },
    { id: 'one-correct', appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'] }, condition: { kind: 'PARTIAL_CORRECT_SELECTED', minCorrect: 1, noIncorrect: true }, award: { kind: 'FIXED', marks: 1 } },
    { id: 'default', appliesTo: { itemTypes: ['MULTIPLE_CORRECT_MCQ'] }, condition: { kind: 'ALWAYS' }, award: { kind: 'FIXED', marks: 0 } },
  ],
};

const HASH = '11b9ca4d67217f27d5a594058ab68d061ee9bf2dae9ccf2154ca4ab9cc313012';

function aProfile(overrides: Partial<ExamProfileVersionDetail> = {}): ExamProfileVersionDetail {
  return {
    profileVersionId: '019fd4bc-0000-7000-8000-000000000aaa',
    examId: '019fd4bc-0000-7000-8000-000000000bbb',
    academicYear: '2026',
    state: 'published',
    taxonomyVersionId: '019fd4bc-0000-7000-8000-000000000ccc',
    totalMarks: 300,
    markingRuleSetHash: HASH,
    markingRuleSet: JEE_MAIN_RULES,
    sections: [
      { ordinal: 1, name: 'Physics', subject: 'physics', itemCount: 25, itemTypeMix: { SINGLE_CORRECT_MCQ: 20, NUMERIC: 5 }, maxMarks: 100, sectionTimingMinutes: null },
      { ordinal: 2, name: 'Chemistry', subject: 'chemistry', itemCount: 25, itemTypeMix: { SINGLE_CORRECT_MCQ: 20, NUMERIC: 5 }, maxMarks: 100, sectionTimingMinutes: null },
      { ordinal: 3, name: 'Mathematics', subject: 'mathematics', itemCount: 25, itemTypeMix: { SINGLE_CORRECT_MCQ: 20, NUMERIC: 5 }, maxMarks: 100, sectionTimingMinutes: null },
    ],
    itemTypeAllowances: [
      { itemType: 'SINGLE_CORRECT_MCQ', sectionOrdinals: [1, 2, 3] },
      { itemType: 'NUMERIC', sectionOrdinals: [1, 2, 3] },
    ],
    aggregateVersion: 4,
    ...overrides,
  };
}

function renderViewer(profile = aProfile(), copyToClipboard = vi.fn(async () => undefined)) {
  const client = new FakeCurriculumClient({ profile });
  const view = render(
    <ExamProfileViewer
      client={client}
      profileVersionId={profile.profileVersionId}
      copyToClipboard={copyToClipboard}
    />,
  );
  return { ...view, copyToClipboard };
}

describe('profile display', () => {
  it('shows sections in delivery order with their counts and marks', async () => {
    renderViewer();

    const table = await screen.findByRole('table', { name: 'Sections in delivery order' });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('cell')[1]?.textContent)).toEqual([
      'Physics',
      'Chemistry',
      'Mathematics',
    ]);
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[3]).toHaveTextContent('25');
    expect(within(rows[0] as HTMLElement).getAllByRole('cell')[4]).toHaveTextContent('100');
  });

  it('describes a single-timer profile as such', async () => {
    renderViewer();

    const table = await screen.findByRole('table', { name: 'Sections in delivery order' });
    expect(within(table).getAllByText('Single timer')).toHaveLength(3);
  });

  it('shows section timing when the profile locks sections', async () => {
    renderViewer(
      aProfile({
        sections: [
          { ordinal: 1, name: 'Physics', subject: 'physics', itemCount: 25, itemTypeMix: { SINGLE_CORRECT_MCQ: 25 }, maxMarks: 100, sectionTimingMinutes: 60 },
        ],
      }),
    );

    expect(await screen.findByText('60 minutes')).toBeInTheDocument();
  });

  it('lists item type allowances and the sections they apply to', async () => {
    renderViewer();

    const allowances = await screen.findByRole('region', { name: 'Item type allowances' });
    expect(within(allowances).getByText(/SINGLE_CORRECT_MCQ — sections 1, 2, 3/u)).toBeInTheDocument();
    expect(within(allowances).getByText(/NUMERIC — sections 1, 2, 3/u)).toBeInTheDocument();
  });

  it('marks a published profile read-only', async () => {
    renderViewer();

    expect(await screen.findByText(/Published — read only/u)).toBeInTheDocument();
  });

  it('shows no read-only notice for a draft', async () => {
    renderViewer(aProfile({ state: 'draft', markingRuleSetHash: null }));

    await screen.findByRole('heading', { name: 'Marking rules' });
    expect(screen.queryByText(/read only/u)).not.toBeInTheDocument();
  });
});

describe('marking rules in plain language', () => {
  it('renders the JEE Main set in evaluation order', async () => {
    renderViewer();

    const marking = await screen.findByRole('region', { name: 'Marking rules' });
    const rules = within(marking).getAllByRole('listitem');
    expect(rules.map((rule) => rule.textContent)).toEqual([
      'If the item is unattempted → 0 marks',
      'If the answer matches exactly → +4 marks',
      'If nothing above matched → -1 mark',
    ]);
  });

  it('renders the JEE Advanced partial-credit set in order', async () => {
    renderViewer(aProfile({ markingRuleSet: JEE_ADVANCED_RULES }));

    const marking = await screen.findByRole('region', { name: 'Marking rules' });
    expect(within(marking).getAllByRole('listitem').map((rule) => rule.textContent)).toEqual([
      'If the item is unattempted → 0 marks',
      'If any incorrect option is selected → -2 marks',
      'If every correct option is selected and no incorrect one is → +4 marks',
      'If at least 3 correct options are selected and no incorrect option is selected → +3 marks',
      'If at least 2 correct options are selected and no incorrect option is selected → +2 marks',
      'If at least 1 correct option is selected and no incorrect option is selected → +1 mark',
      'If nothing above matched → 0 marks',
    ]);
  });

  it('says that the first match wins', async () => {
    renderViewer();

    expect(await screen.findByText(/first match wins/u)).toBeInTheDocument();
  });

  it.each([
    [{ kind: 'UNATTEMPTED' as const }, 'the item is unattempted'],
    [{ kind: 'EXACT_MATCH' as const }, 'the answer matches exactly'],
    [{ kind: 'NO_MATCH' as const }, 'the answer is wrong'],
    [{ kind: 'ANY_INCORRECT_SELECTED' as const }, 'any incorrect option is selected'],
    [{ kind: 'MATCHING_PAIRS_CORRECT' as const, count: 4 }, 'exactly 4 pairs are matched correctly'],
    [{ kind: 'ALWAYS' as const }, 'nothing above matched'],
  ])('describes %j', (condition, expected) => {
    expect(describeCondition(condition)).toBe(expected);
  });

  it.each([
    [{ kind: 'FIXED' as const, marks: 4 }, '+4 marks'],
    [{ kind: 'FIXED' as const, marks: -1 }, '-1 mark'],
    [{ kind: 'FIXED' as const, marks: 0 }, '0 marks'],
    [{ kind: 'PER_CORRECT' as const, marks: 2 }, '2 marks for each correct selection'],
    [{ kind: 'FULL_MARKS' as const }, "the item's full marks"],
  ])('describes award %j', (award, expected) => {
    expect(describeAward(award)).toBe(expected);
  });

  it('reads a whole rule as one sentence', () => {
    expect(describeRule(JEE_MAIN_RULES.rules[1] as never)).toBe(
      'If the answer matches exactly → +4 marks',
    );
  });
});

describe('rule set hash', () => {
  it('shows the hash', async () => {
    renderViewer();

    expect(await screen.findByText(HASH)).toBeInTheDocument();
  });

  it('copies the hash on request', async () => {
    const { copyToClipboard } = renderViewer();
    await screen.findByText(HASH);

    await userEvent.click(screen.getByRole('button', { name: 'Copy rule set hash' }));

    expect(copyToClipboard).toHaveBeenCalledWith(HASH);
    expect(await screen.findByText('Rule set hash copied.')).toBeInTheDocument();
  });

  it('explains that a draft has no frozen hash yet', async () => {
    renderViewer(aProfile({ state: 'draft', markingRuleSetHash: null }));

    expect(await screen.findByText(/Not yet frozen/u)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Copy rule set hash' })).not.toBeInTheDocument();
  });
});

describe('states', () => {
  it('shows an error when the profile cannot be loaded', async () => {
    const client = new FakeCurriculumClient();
    render(<ExamProfileViewer client={client} profileVersionId="missing" />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/could not be loaded/u);
  });
});

describe('accessibility', () => {
  it('passes the automated WCAG 2.2 AA scan', async () => {
    const { container } = renderViewer();
    await screen.findByRole('table', { name: 'Sections in delivery order' });

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);

  it('passes the scan for the JEE Advanced rule set', async () => {
    const { container } = renderViewer(aProfile({ markingRuleSet: JEE_ADVANCED_RULES }));
    await screen.findByRole('region', { name: 'Marking rules' });

    expect(await accessibilityViolations(container)).toEqual([]);
  }, 30_000);
});
