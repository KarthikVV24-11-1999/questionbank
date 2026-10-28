import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultDto } from '../api/schemas.js';
import { FakeApi, FakeLearningApi } from '../testing/fakes.js';
import { concept, finding, pace, PROFILE, report, TAXONOMY } from '../testing/learning-fixtures.js';
import { ReportScreen } from './ReportScreen.js';
import type { ScreenContext } from './screen-context.js';

afterEach(cleanup);

const context: ScreenContext = { examProfileVersionId: PROFILE, taxonomyVersionId: TAXONOMY, lastAttemptId: 'att-1', pageKey: 'page-1' };
const scored = (scoreRecordId: string, generation: number): ResultDto => ({
  attemptId: 'att-1',
  status: 'scored',
  score: { scoreRecordId, attemptId: 'att-1', generation, totalRaw: '10', totalMaxAvailable: '24', computedAt: 't', sectionScores: [], itemOutcomes: [] },
});

function open(options: { report?: ReturnType<typeof report> | Error; pace?: ReturnType<typeof pace> | Error; result?: ResultDto | Error } = {}) {
  const learning = new FakeLearningApi();
  learning.reports.set('att-1', options.report ?? report());
  learning.paces.set('att-1', options.pace ?? pace());
  const assessment = new FakeApi({} as never, new Error('no key'));
  const answer = options.result ?? scored('score-1', 1);
  assessment.getResult = async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const onOpen = vi.fn();
  const view = render(<ReportScreen learning={learning} assessment={assessment} attemptId="att-1" context={context} onOpen={onOpen} />);
  return { onOpen, assessment, learning, view };
}

describe('the report screen (M7-59)', () => {
  it('lists the findings in the order the server ranked them, whatever order they arrive in, each with what it cost', async () => {
    open({ report: report({ findings: [finding(2, 2, '5'), finding(1, 1, '9')] }) });
    const items = within(await screen.findByRole('region', { name: 'Findings' })).getAllByRole('heading', { level: 3 });
    expect(items.map((heading) => heading.textContent)).toEqual([`Concept ${concept(1).slice(0, 8)}`, `Concept ${concept(2).slice(0, 8)}`]);
    expect(screen.getAllByText(/Lost 9 of 8 marks across 2 questions\./u)).toHaveLength(1);
  });

  it('says how many were skipped, only when some were, and a single question in the singular', async () => {
    open({ report: report({ findings: [{ ...finding(1, 1, '4'), slots: 1, skipped: 1 }] }) });
    expect(await screen.findByText('Lost 4 of 8 marks across 1 question, 1 skipped.')).toBeInTheDocument();
  });

  it('says nothing was lost where nothing was', async () => {
    open({ report: report({ findings: [] }) });
    expect(await screen.findByText('No marks were lost.')).toBeInTheDocument();
  });

  it('puts the one tap beside each finding: it makes the run about that finding\'s concept, starts it, and opens it', async () => {
    const { onOpen, assessment } = open();
    const buttons = await screen.findAllByRole('button', { name: /^Practise Concept/u });
    expect(buttons).toHaveLength(2);
    await userEvent.click(buttons[1]!);
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(assessment.calls).toEqual(['createPracticeAttempt', 'startAttempt']);
    expect(assessment.practiceRequests[0]!.request.conceptIdentityIds).toEqual([concept(2)]);
    expect(onOpen).toHaveBeenCalledWith(`?practice=att-1&profile=${PROFILE}&taxonomy=${TAXONOMY}`);
  });

  it('shows the pace beside the findings, and reads the questions whose time is not known as not known, never as fast or slow', async () => {
    open({
      pace: pace({
        slots: [
          { slotRef: 's1', conceptIdentityId: concept(1), outcome: 'correct', pace: 'unknown', atLeastMs: 120_000, atMostMs: 300_000 },
          { slotRef: 's2', conceptIdentityId: concept(1), outcome: 'incorrect', pace: 'unknown', atLeastMs: 90_000, atMostMs: null },
          { slotRef: 's3', conceptIdentityId: concept(2), outcome: 'correct', pace: 'fast', atLeastMs: 10_000, atMostMs: 20_000 },
        ],
      }),
    });
    const table = await screen.findByRole('table');
    expect(within(table).getAllByRole('columnheader').map((header) => header.textContent)).toEqual(['Concept', 'Slow and right', 'Slow and wrong', 'Fast and right', 'Fast and wrong', 'Not known']);
    expect(within(table).getAllByRole('cell').map((cell) => cell.textContent)).toEqual(['1', '2', '3', '4', '11']);
    const unknown = screen.getByRole('list', { name: 'Questions whose time is not known' });
    expect(within(unknown).getAllByRole('listitem').map((item) => item.textContent)).toEqual([
      `Concept ${concept(1).slice(0, 8)}: at least 120 s, at most 300 s`,
      `Concept ${concept(1).slice(0, 8)}: at least 90 s, no upper limit known`,
    ]);
    expect(screen.getByText(/could not be told apart from a long pause/u)).toBeInTheDocument();
  });

  it('has no list of unknown questions to show where every time is known', async () => {
    open({ pace: pace({ slots: [{ slotRef: 's3', conceptIdentityId: concept(2), outcome: 'correct', pace: 'fast', atLeastMs: 10_000, atMostMs: 20_000 }] }) });
    await screen.findByRole('table');
    expect(screen.queryByText('Not known', { selector: 'h3' })).toBeNull();
  });

  it('says the report stands without the pace where the pace could not be read', async () => {
    open({ pace: new Error('PACE_NOT_FOUND') });
    expect(await screen.findByText('The time analysis for this paper could not be read.')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: /^Practise/u })).toHaveLength(2);
  });

  it('says a report of a replaced score is of an earlier score, and which one stands', async () => {
    open({ result: scored('score-2', 2) });
    expect(await screen.findByRole('note')).toHaveTextContent('This report is of an earlier score. Your paper has since been re-scored (score 2), and a report for the new score has not been made yet.');
  });

  it('says a paper was re-scored when the report is for the score that stands and it is past the first', async () => {
    open({ report: report({ scoreRecordId: 'score-2' }), result: scored('score-2', 2) });
    expect(await screen.findByText('Your paper was re-scored. This report is for the score that stands (score 2).')).toBeInTheDocument();
  });

  it('says nothing of a re-score for a first score, or where the score could not be read', async () => {
    open();
    await screen.findByRole('table');
    expect(screen.queryByText(/re-scored/u)).toBeNull();
    cleanup();
    open({ result: new Error('not scored') });
    await screen.findByRole('table');
    expect(screen.queryByText(/re-scored/u)).toBeNull();
    cleanup();
    open({ result: { attemptId: 'att-1', status: 'pending' } });
    await screen.findByRole('table');
    expect(screen.queryByText(/re-scored/u)).toBeNull();
  });

  it('says it is opening, and says plainly when there is no report', async () => {
    open({ report: new Error('there is no report for that attempt') });
    expect(screen.getByRole('status')).toHaveTextContent('Opening your report');
    expect(await screen.findByRole('alert')).toHaveTextContent('there is no report');
    expect(screen.getByRole('link', { name: 'Back to what to do next' })).toBeInTheDocument();
  });

  it('has no accessibility violation', async () => {
    const { view } = open({ pace: pace({ slots: [{ slotRef: 's1', conceptIdentityId: concept(1), outcome: 'correct', pace: 'unknown', atLeastMs: 1000, atMostMs: null }] }), result: scored('score-2', 2) });
    await screen.findByRole('table');
    expect((await axe.run(view.container)).violations.map((violation) => violation.id)).toEqual([]);
  });
});
