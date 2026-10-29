import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ResultDto } from '../api/schemas.js';
import { FakeApi, FakeLearningApi } from '../testing/fakes.js';
import { concept, finding, pace, PROFILE, report, TAXONOMY } from '../testing/learning-fixtures.js';
import { ReportScreen } from './ReportScreen.js';
import { clientEnvelopeSchema, findPii } from '@questionbank/contracts/analytics';
import { NO_ANALYTICS, type ScreenAnalytics } from '../analytics/emitter.js';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import type { ScreenContext } from './screen-context.js';

afterEach(cleanup);

const context: ScreenContext = { examProfileVersionId: PROFILE, taxonomyVersionId: TAXONOMY, lastAttemptId: 'att-1', pageKey: 'page-1', analytics: NO_ANALYTICS };
const scored = (scoreRecordId: string, generation: number): ResultDto => ({
  attemptId: 'att-1',
  status: 'scored',
  score: { scoreRecordId, attemptId: 'att-1', generation, totalRaw: '10', totalMaxAvailable: '24', computedAt: 't', sectionScores: [], itemOutcomes: [] },
});

function open(options: { report?: ReturnType<typeof report> | Error; pace?: ReturnType<typeof pace> | Error; result?: ResultDto | Error; analytics?: ScreenAnalytics } = {}) {
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
  const element = () => <ReportScreen learning={learning} assessment={assessment} attemptId="att-1" context={{ ...context, analytics: options.analytics ?? NO_ANALYTICS }} onOpen={onOpen} />;
  const view = render(element());
  return { onOpen, assessment, learning, view, renderAgain: () => view.rerender(element()) };
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

  describe('what it says happened (M7-62)', () => {
    const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
    const computedTwoHoursAgo = (): ResultDto => ({ ...scored('score-1', 1), score: { ...scored('score-1', 1).score!, computedAt: '2026-10-29T06:00:30.000Z' } });

    it('says the report was viewed, once, with how many findings it showed and that it has no drill-down', async () => {
      const { analytics, sent } = analyticsRig();
      const { renderAgain } = open({ analytics });
      await screen.findByRole('region', { name: 'Findings' });
      await settle();
      renderAgain();
      await settle();
      expect(sent.map((event) => event.event_name)).toEqual(['mock.diagnostic_viewed']);
      expect(sent[0]).toMatchObject({ payload: { findings_shown: 2, deepest_drill_level: 0 }, context: { attempt_id: 'att-1' } });
      expectConforming(sent);
    });

    it('says the finding was tapped, with its rank and the hours since the score, and then that the run it made started, from a remediation', async () => {
      const { analytics, sent } = analyticsRig();
      const { onOpen } = open({ analytics, result: computedTwoHoursAgo() });
      const buttons = await screen.findAllByRole('button', { name: /^Practise Concept/u });
      await userEvent.click(buttons[1]!);
      await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
      await settle();
      expect(sent.map((event) => event.event_name)).toEqual(['mock.diagnostic_viewed', 'mock.remediation_clicked', 'practice.session_started']);
      expect(sent[1]).toMatchObject({ payload: { finding_rank: 2, hours_after_result: 1.99 }, context: { concept_identity_id: concept(2) } });
      expectConforming(sent);
      expect(sent[2]).toMatchObject({ payload: { selection_strategy: 'filtered', source: 'remediation', concept_ids: [concept(2)], item_count: expect.any(Number) }, context: { attempt_id: 'att-1' } });
    });

    it('says the hours are not known where the score\'s time could not be read, rather than a number', async () => {
      // the payload as the screen built it, before the emitter writes it down as JSON (where a NaN would quietly become null)
      const built: Array<{ name: string; payload: Record<string, unknown> }> = [];
      open({ analytics: { emit: (name, payload) => void built.push({ name, payload }), nowMs: () => Date.parse('2026-10-29T08:00:00.000Z'), flush: () => undefined } });
      await userEvent.click((await screen.findAllByRole('button', { name: /^Practise Concept/u }))[0]!);
      await settle();
      expect(built.find((event) => event.name === 'mock.remediation_clicked')!.payload).toEqual({ finding_rank: 1, hours_after_result: null });
    });

    it('emits only events whose envelope the contract accepts, with no personal data in any of them', async () => {
      const { analytics, sent } = analyticsRig();
      const { onOpen } = open({ analytics, result: computedTwoHoursAgo() });
      await userEvent.click((await screen.findAllByRole('button', { name: /^Practise Concept/u }))[0]!);
      await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
      await settle();
      expect(sent.length).toBe(3);
      for (const event of sent) {
        expect(clientEnvelopeSchema.safeParse(event).success, event.event_name).toBe(true);
        expect(findPii(event), event.event_name).toEqual([]);
      }
    });

    it('costs the learner nothing when the edge is down: the report is shown and the tap still opens the run', async () => {
      const { analytics } = analyticsRig({ send: async () => Promise.reject(new TypeError('Failed to fetch')) });
      const { onOpen, assessment } = open({ analytics });
      await userEvent.click((await screen.findAllByRole('button', { name: /^Practise Concept/u }))[0]!);
      await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
      expect(assessment.calls).toEqual(['createPracticeAttempt', 'startAttempt']);
    });
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
