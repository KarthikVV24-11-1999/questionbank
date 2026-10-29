import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptDto, FakeApi, FakeLearningApi } from '../testing/fakes.js';
import { concept, escalation, notFound, plan, PROFILE, report, scheduled, TAXONOMY, unreachable } from '../testing/learning-fixtures.js';
import { HomeScreen } from './HomeScreen.js';
import { NO_ANALYTICS } from '../analytics/emitter.js';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import type { ScreenContext } from './screen-context.js';

afterEach(cleanup);

const context = (overrides: Partial<ScreenContext> = {}): ScreenContext => ({ examProfileVersionId: PROFILE, taxonomyVersionId: TAXONOMY, lastAttemptId: null, pageKey: 'page-1', analytics: NO_ANALYTICS, ...overrides });
const server = () => new FakeApi({} as never, new Error('no key'));

function open(learning: FakeLearningApi, overrides: Partial<ScreenContext> = {}, assessment = server()) {
  const onOpen = vi.fn();
  render(<HomeScreen learning={learning} assessment={assessment} context={context(overrides)} onOpen={onOpen} />);
  return { onOpen, assessment };
}

describe('the home screen (M7-57)', () => {
  it('names one next action, an escalated concept first, and not a list of what is available', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ due: [scheduled(1)], escalated: [escalation(2)] });
    open(learning);
    expect(await screen.findByRole('heading', { name: `Concept ${concept(2).slice(0, 8)}` })).toBeInTheDocument();
    expect(screen.getByText(/keeps slipping/u)).toBeInTheDocument();
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText(`Concept ${concept(1).slice(0, 8)}`)).toBeNull();
  });

  it('says what is due when nothing is escalated, and the weakest concept when nothing is either', async () => {
    const due = new FakeLearningApi();
    due.plan = plan({ due: [scheduled(1)] });
    open(due);
    expect(await screen.findByText('This concept is due for review.')).toBeInTheDocument();
    cleanup();

    const weakest = new FakeLearningApi();
    weakest.weakest = [concept(3)];
    open(weakest);
    expect(await screen.findByText('This is the concept you are weakest on.')).toBeInTheDocument();
  });

  it('says a practice run started from the next action was a recommendation, and says nothing of a finding having been tapped', async () => {
    const { analytics, sent } = analyticsRig();
    const learning = new FakeLearningApi();
    learning.plan = plan({ due: [scheduled(1)] });
    const { onOpen } = open(learning, { analytics });
    await userEvent.click(await screen.findByRole('button', { name: 'Practise this' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(sent.map((event) => event.event_name)).toEqual(['practice.session_started']);
    expectConforming(sent);
    expect(sent[0]!.payload).toMatchObject({ selection_strategy: 'filtered', source: 'recommendation', concept_ids: [concept(1)] });
  });

  it('shows a concept whose escalation was resolved no more, because the plan no longer lists it', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [] });
    open(learning);
    expect(await screen.findByText(/nothing to do right now/u)).toBeInTheDocument();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('links to the report of the last sitting when there is one and nothing is waiting on the learner', async () => {
    const learning = new FakeLearningApi();
    learning.reports.set('att-1', report());
    open(learning, { lastAttemptId: 'att-1' });
    const link = await screen.findByRole('link', { name: 'Read your report' });
    expect(link).toHaveAttribute('href', `?report=att-1&profile=${PROFILE}&taxonomy=${TAXONOMY}`);
  });

  it('on one tap makes the run, starts it, and opens it', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const { onOpen, assessment } = open(learning);
    await userEvent.click(await screen.findByRole('button', { name: 'Practise this' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(assessment.calls).toEqual(['createPracticeAttempt', 'startAttempt']);
    expect(assessment.practiceRequests[0]).toEqual({ request: { examProfileVersionId: PROFILE, conceptIdentityIds: [concept(2)], count: 10 }, key: `page-1:${concept(2)}` });
    expect(onOpen).toHaveBeenCalledWith(`?practice=att-1&profile=${PROFILE}&taxonomy=${TAXONOMY}`);
    // the run is made; a tap before the page is left makes no second ask
    expect(screen.getByRole('button', { name: 'Starting…' })).toBeDisabled();
  });

  it('says what went wrong when the run could not be made, and lets the learner try again', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const assessment = server();
    const create = assessment.createPracticeAttempt.bind(assessment);
    let failing = true;
    assessment.createPracticeAttempt = async (...args) => {
      if (failing) throw new Error('no published item matches what was asked for');
      return create(...args);
    };
    const { onOpen } = open(learning, {}, assessment);
    await userEvent.click(await screen.findByRole('button', { name: 'Practise this' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('no published item matches');
    expect(onOpen).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Practise this' })).toBeEnabled();

    failing = false;
    await userEvent.click(screen.getByRole('button', { name: 'Practise this' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('does not start a second run while the first tap is still being answered', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const assessment = server();
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    const create = assessment.createPracticeAttempt.bind(assessment);
    assessment.createPracticeAttempt = async (...args) => (await held, create(...args));
    open(learning, {}, assessment);
    const button = await screen.findByRole('button', { name: 'Practise this' });
    await userEvent.click(button);
    expect(await screen.findByRole('button', { name: 'Starting…' })).toBeDisabled();
    release();
    await vi.waitFor(() => expect(assessment.practiceRequests).toHaveLength(1));
  });

  it('makes one run of two taps that arrive before the screen has changed', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const { assessment } = open(learning);
    const button = await screen.findByRole('button', { name: 'Practise this' });
    act(() => {
      button.click();
      button.click();
    });
    await vi.waitFor(() => expect(assessment.practiceRequests.length).toBeGreaterThan(0));
    expect(assessment.practiceRequests).toHaveLength(1);
  });

  it('says a run cannot be made, instead of trying, when the page was opened without an exam profile', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    open(learning, { examProfileVersionId: null });
    expect(await screen.findByRole('note')).toHaveTextContent('without an exam profile');
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('says it is looking, and says plainly when it could not look', async () => {
    const learning = new FakeLearningApi();
    learning.plan = unreachable();
    open(learning);
    expect(screen.getByRole('status')).toHaveTextContent('Looking at where you are');
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });

  it('says that something went wrong, without making up a reason, when what failed was not an error', async () => {
    const learning = new FakeLearningApi();
    learning.getReviewPlan = async () => Promise.reject('refused');
    open(learning);
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
    cleanup();

    const planned = new FakeLearningApi();
    planned.plan = plan({ escalated: [escalation(2)] });
    const assessment = server();
    assessment.createPracticeAttempt = async () => Promise.reject('refused');
    open(planned, {}, assessment);
    await userEvent.click(await screen.findByRole('button', { name: 'Practise this' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Something went wrong.');
  });

  it('shows a report that is not there as nothing to do, and a report that failed some other way as the failure', async () => {
    const missing = new FakeLearningApi();
    missing.reports.set('att-1', notFound());
    open(missing, { lastAttemptId: 'att-1' });
    expect(await screen.findByText(/nothing to do right now/u)).toBeInTheDocument();
  });

  it('has no accessibility violation in any state it shows', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const view = render(<HomeScreen learning={learning} assessment={server()} context={context()} onOpen={() => undefined} />);
    await screen.findByRole('button', { name: 'Practise this' });
    const result = await axe.run(view.container);
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
    expect(attemptDto).toBeDefined();
  });
});
