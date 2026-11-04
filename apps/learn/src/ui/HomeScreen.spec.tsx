import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { attemptDto, FakeApi, FakeLearningApi } from '../testing/fakes.js';
import { concept, conceptMap, mapped, escalation, notFound, plan, PROFILE, report, scheduled, TAXONOMY, unreachable } from '../testing/learning-fixtures.js';
import { HomeScreen } from './HomeScreen.js';
import { NO_ANALYTICS } from '../analytics/emitter.js';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import type { ScreenContext } from './screen-context.js';
import { chosenProfile, emptyProfile, FakeProfileApi, scopedProfile } from '../testing/profile-fakes.js';
import { expectNoDomainVocabulary } from '../testing/vocabulary.js';

afterEach(cleanup);

const context = (overrides: Partial<ScreenContext> = {}): ScreenContext => ({ lastAttemptId: null, pageKey: 'page-1', analytics: NO_ANALYTICS, ...overrides });
/** A learner who has chosen their exam: where the exam profile and the taxonomy come from. */
const chosen = (): FakeProfileApi => Object.assign(new FakeProfileApi(), { profile: chosenProfile() });
const server = () => new FakeApi({} as never, new Error('no key'));

function open(learning: FakeLearningApi, overrides: Partial<ScreenContext> = {}, assessment = server(), profiles: FakeProfileApi = chosen()) {
  const onOpen = vi.fn();
  const view = render(<HomeScreen learning={learning} assessment={assessment} profiles={profiles} context={context(overrides)} onOpen={onOpen} />);
  return { onOpen, assessment, view };
}

describe('the home screen (M7-57)', () => {
  it('names one next action, an escalated concept first, and not a list of what is available', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ due: [scheduled(1)], escalated: [escalation(2)] });
    open(learning);
    expect(await screen.findByRole('heading', { name: 'Ray optics' })).toBeInTheDocument();
    expect(screen.getByText(/keeps slipping/u)).toBeInTheDocument();
    expect(screen.getByLabelText('Where it sits in the syllabus')).toHaveTextContent('Physics › Optics');
    expect(screen.getAllByRole('button')).toHaveLength(1);
    expect(screen.queryByText('Kinematics')).toBeNull();
  });

  it('says what is due when nothing is escalated, and the weakest topic when nothing is either', async () => {
    const due = new FakeLearningApi();
    due.plan = plan({ due: [scheduled(1)] });
    open(due);
    expect(await screen.findByText('This topic is due for review.')).toBeInTheDocument();
    cleanup();

    const weakest = new FakeLearningApi();
    weakest.weakest = [concept(3)];
    open(weakest);
    expect(await screen.findByText('This is the topic you are weakest on.')).toBeInTheDocument();
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
    expect(link).toHaveAttribute('href', '?report=att-1');
  });

  it('on one tap makes the run, starts it, and opens it', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const { onOpen, assessment } = open(learning);
    await userEvent.click(await screen.findByRole('button', { name: 'Practise this' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    expect(assessment.calls).toEqual(['createPracticeAttempt', 'startAttempt']);
    expect(assessment.practiceRequests[0]).toEqual({ request: { examProfileVersionId: PROFILE, conceptIdentityIds: [concept(2)], count: 10 }, key: `page-1:${concept(2)}` });
    expect(onOpen).toHaveBeenCalledWith('?practice=att-1');
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

  it('says to choose an exam, instead of trying a run, when the learner has not chosen one', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    open(learning, {}, server(), new FakeProfileApi());
    expect(await screen.findByRole('note')).toHaveTextContent('Choose your exam to practise');
    expect(screen.getByRole('link', { name: 'Choose it now' })).toHaveAttribute('href', '?onboarding=1');
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

  it('invites the learner to say who they are, as a link, and only while onboarding has something to ask and has not been skipped', async () => {
    const profiles = new FakeProfileApi();
    const learning = new FakeLearningApi();
    render(<HomeScreen learning={learning} assessment={server()} profiles={profiles} context={context()} onOpen={() => undefined} />);
    const link = await screen.findByRole('link', { name: 'Tell us about your exam' });
    expect(link).toHaveAttribute('href', '?onboarding=1');
    cleanup();

    profiles.profile = { ...emptyProfile(), onboarding: { steps: [], next: 'class', skipped: true } };
    render(<HomeScreen learning={learning} assessment={server()} profiles={profiles} context={context()} onOpen={() => undefined} />);
    await screen.findByText(/nothing to do right now/u);
    expect(screen.queryByRole('link', { name: 'Tell us about your exam' })).toBeNull();
    cleanup();

    profiles.profile = { ...emptyProfile(), onboarding: { steps: [], next: null, skipped: false } };
    render(<HomeScreen learning={learning} assessment={server()} profiles={profiles} context={context()} onOpen={() => undefined} />);
    await screen.findByText(/nothing to do right now/u);
    expect(screen.queryByRole('link', { name: 'Tell us about your exam' })).toBeNull();
  });

  it('is exactly as it was when nothing is given to read a profile from, and stays so once that has been settled', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ due: [scheduled(1)] });
    render(<HomeScreen learning={learning} assessment={server()} context={context()} onOpen={() => undefined} />);
    expect(await screen.findByRole('heading', { name: 'Kinematics' })).toBeInTheDocument();
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    });
    expect(screen.getByRole('heading', { name: 'Kinematics' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tell us about your exam' })).toBeNull();
  });

  it('is exactly as it was when the profile cannot be read: the invitation is never why a learner cannot get on', async () => {
    const profiles = new FakeProfileApi();
    profiles.offline = true;
    const learning = new FakeLearningApi();
    learning.plan = plan({ due: [scheduled(1)] });
    render(<HomeScreen learning={learning} assessment={server()} profiles={profiles} context={context()} onOpen={() => undefined} />);
    expect(await screen.findByRole('heading', { name: 'Kinematics' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Tell us about your exam' })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('has no accessibility violation in any state it shows', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const view = render(<HomeScreen learning={learning} assessment={server()} profiles={chosen()} context={context()} onOpen={() => undefined} />);
    await screen.findByRole('button', { name: 'Practise this' });
    const result = await axe.run(view.container);
    expect(result.violations.map((violation) => violation.id)).toEqual([]);
    expect(attemptDto).toBeDefined();
  });

  it('asks what is weakest about the taxonomy of the learner\'s own exam, and does not ask when they have chosen none', async () => {
    const learning = new FakeLearningApi();
    learning.weakest = [concept(3)];
    open(learning);
    expect(await screen.findByRole('heading', { name: 'Gravitation' })).toBeInTheDocument();
    expect(learning.calls).toContain(`suggestRemediation ${TAXONOMY}`);
    cleanup();

    const without = new FakeLearningApi();
    without.weakest = [concept(3)];
    open(without, {}, server(), new FakeProfileApi());
    await screen.findByText(/nothing to do right now/u);
    expect(without.calls.some((call) => call.startsWith('suggestRemediation'))).toBe(false);
  });

  it('names the topic in the syllabus version it came from, once, and never asks to name when there is no topic', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    open(learning);
    await screen.findByRole('heading', { name: 'Ray optics' });
    expect(learning.calls.filter((call) => call.startsWith('conceptNames'))).toEqual([`conceptNames ${TAXONOMY} ${concept(2)}`]);
    cleanup();

    const nothing = new FakeLearningApi();
    open(nothing);
    await screen.findByText(/nothing to do right now/u);
    expect(nothing.calls.some((call) => call.startsWith('conceptNames'))).toBe(false);
  });

  it('calls a topic whose name could not be read "This topic", and never by what it is filed under', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    learning.namesFail = unreachable();
    const { view } = open(learning);
    expect(await screen.findByRole('heading', { name: 'This topic' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Where it sits in the syllabus')).toBeNull();
    expect(screen.getByRole('button', { name: 'Practise this' })).toBeInTheDocument();
    expectNoDomainVocabulary(view.container);
  });

  it('links to where the learner stands', async () => {
    const learning = new FakeLearningApi();
    open(learning);
    expect(await screen.findByRole('link', { name: 'See where you stand' })).toHaveAttribute('href', '?map=1');
  });

  it('shows a learner nothing in our vocabulary, in any state it has: an escalation, a due review, the weakest, a report, nothing, a failure, no exam', async () => {
    const states: Array<(learning: FakeLearningApi) => void> = [
      (l) => (l.plan = plan({ escalated: [escalation(2)] })),
      (l) => (l.plan = plan({ due: [scheduled(1)] })),
      (l) => (l.weakest = [concept(3)]),
      (l) => l.reports.set('att-1', report()),
      () => undefined,
      (l) => (l.plan = unreachable()),
      (l) => ((l.plan = plan({ escalated: [escalation(2)] })), (l.namesFail = unreachable())),
    ];
    for (const [index, arrange] of states.entries()) {
      const learning = new FakeLearningApi();
      arrange(learning);
      const { view } = open(learning, { lastAttemptId: index === 3 ? 'att-1' : null });
      await vi.waitFor(() => expect(screen.queryByRole('status')).toBeNull());
      expectNoDomainVocabulary(view.container);
      cleanup();
    }
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    const { view } = open(learning, {}, server(), new FakeProfileApi());
    await screen.findByRole('note');
    expectNoDomainVocabulary(view.container);
  });

  describe('the diagnostic (M8-32)', () => {
    const scoped = (): FakeProfileApi => Object.assign(new FakeProfileApi(), { profile: scopedProfile() });

    it('is offered to a learner who has said what they have studied and answered nothing, in their words', async () => {
      open(new FakeLearningApi(), {}, server(), scoped());
      expect(await screen.findByRole('heading', { name: 'See where you stand' })).toBeInTheDocument();
      expect(screen.getByText(/Answer 10 short questions across the chapters you have studied/u)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Start' })).toBeInTheDocument();
    });

    it('on one tap makes the short run, starts it, says it started, and opens it', async () => {
      const { analytics, sent } = analyticsRig();
      const { onOpen, assessment } = open(new FakeLearningApi(), { analytics }, server(), scoped());
      await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
      await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?practice=att-1'));
      expect(assessment.calls).toEqual(['createDiagnosticAttempt', 'startAttempt']);
      expect(assessment.diagnosticRequests).toEqual([{ request: { examProfileVersionId: PROFILE, count: 10 }, key: 'page-1:diagnostic' }]);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(sent.map((event) => event.event_name)).toEqual(['practice.session_started']);
      expectConforming(sent);
      expect(sent[0]!.payload).toMatchObject({ selection_strategy: 'breadth', source: 'recommendation', concept_ids: [] });
    });

    it('says what went wrong when it could not be made, and lets the learner try again', async () => {
      const assessment = server();
      const create = assessment.createDiagnosticAttempt.bind(assessment);
      let failing = true;
      assessment.createDiagnosticAttempt = async (...args) => {
        if (failing) throw new Error('no published item matches what was asked for');
        return create(...args);
      };
      const { onOpen } = open(new FakeLearningApi(), {}, assessment, scoped());
      await userEvent.click(await screen.findByRole('button', { name: 'Start' }));
      expect(await screen.findByRole('alert')).toHaveTextContent('no published item matches');
      failing = false;
      await userEvent.click(screen.getByRole('button', { name: 'Start' }));
      await vi.waitFor(() => expect(onOpen).toHaveBeenCalledTimes(1));
    });

    it('is not offered without a declared scope, nor to a learner whose map already holds an answer', async () => {
      open(new FakeLearningApi(), {}, server());
      await screen.findByText(/nothing to do right now/u);
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
      cleanup();
      const answered = new FakeLearningApi();
      answered.map = conceptMap([mapped(1, { kind: 'tentative', leaning: 'weak' })]);
      open(answered, {}, server(), scoped());
      await screen.findByText(/nothing to do right now/u);
      expect(screen.queryByRole('button', { name: 'Start' })).toBeNull();
    });

    it('shows a learner nothing in our vocabulary, and has no accessibility violation', async () => {
      const { view } = open(new FakeLearningApi(), {}, server(), scoped());
      await screen.findByRole('button', { name: 'Start' });
      expectNoDomainVocabulary(view.container);
      expect((await axe.run(view.container)).violations.map((violation) => violation.id)).toEqual([]);
    });
  });
});
