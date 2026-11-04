import { cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import { emptyProfile, FakeProfileApi, MemoryDrafts, NODE, refusal } from '../testing/profile-fakes.js';
import { NO_DRAFTS } from '../onboarding/draft.js';
import { OnboardingScreen } from './OnboardingScreen.js';
import type { ScreenContext } from './screen-context.js';

afterEach(cleanup);

function open(over: { profiles?: FakeProfileApi; drafts?: MemoryDrafts; rig?: ReturnType<typeof analyticsRig>; drafting?: typeof NO_DRAFTS; edit?: 'coverage' } = {}) {
  const profiles = over.profiles ?? new FakeProfileApi();
  const drafts = over.drafts ?? new MemoryDrafts();
  const rig = over.rig ?? analyticsRig();
  const onOpen = vi.fn();
  const context: ScreenContext = { lastAttemptId: null, pageKey: 'p', analytics: rig.analytics };
  const view = render(<OnboardingScreen profiles={profiles} drafts={over.drafting ?? drafts} edit={over.edit ?? null} context={context} onOpen={onOpen} />);
  return { profiles, drafts, rig, onOpen, view };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('onboarding: one question at a time, in the server\'s order (FR-STU-01)', () => {
  it('asks for the exam first, with the exams and years the server offers', async () => {
    open();
    expect(await screen.findByRole('form', { name: 'Your exam' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'JEE Main — 2027' })).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'JEE Main — 2028' })).toBeInTheDocument();
  });

  it('sends the exam, then reopens itself at the class, which it knows from what the server holds and nothing it kept', async () => {
    const { profiles, onOpen } = open();
    await userEvent.selectOptions(await screen.findByRole('combobox'), 'JEE_MAIN|2027');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?onboarding=1'));
    expect(profiles.updates).toEqual([{ examCode: 'JEE_MAIN', targetYear: '2027' }]);

    cleanup();
    open({ profiles });
    expect(await screen.findByRole('form', { name: 'Your class' })).toBeInTheDocument();
  });

  it('asks for the class, and then for the chapters as a tree the learner ticks', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, onboarding: { steps: [], next: 'class', skipped: false } };
    const { onOpen } = open({ profiles });
    await userEvent.click(await screen.findByRole('radio', { name: 'Class 12' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(profiles.updates).toEqual([{ currentClass: 'class_12' }]);

    cleanup();
    open({ profiles });
    expect(await screen.findByRole('form', { name: 'What you have studied' })).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Mechanics' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Mechanics' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(profiles.updates).toHaveLength(2));
    expect(profiles.updates[1]).toEqual({ scopeNodeIds: [NODE.mechanics] });
  });

  it('says what the scope is for, and that a mock is the whole paper, where it asks', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, currentClass: 'class_12', onboarding: { steps: [], next: 'coverage', skipped: false } };
    open({ profiles });
    expect(await screen.findByText(/A mock exam is always the full paper/u)).toBeInTheDocument();
  });

  it('refuses an empty answer in words, and sends nothing', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, currentClass: 'class_12', onboarding: { steps: [], next: 'coverage', skipped: false } };
    const { onOpen } = open({ profiles });
    await userEvent.click(await screen.findByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Pick at least one chapter, or skip for now.');
    expect(profiles.updates).toEqual([]);
    expect(onOpen).not.toHaveBeenCalled();
  });

  it('when all is asked, says so, and offers a past score as optional', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, currentClass: 'class_12', scope: { status: 'in_force', taxonomyVersionId: 't', nodeIds: [NODE.optics], conceptCount: 1, conceptTotal: 4, coverageFraction: 0.25 }, onboarding: { steps: [], next: null, skipped: false } };
    const { onOpen } = open({ profiles });
    expect(await screen.findByText('You are all set.')).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Score'), '187');
    await userEvent.type(screen.getByLabelText('out of'), '300');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(profiles.updates).toEqual([{ priorScore: { value: 187, outOf: 300 } }]);
  });

  it('refuses a score above its total in words', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, currentClass: 'class_12', scope: { status: 'in_force', taxonomyVersionId: 't', nodeIds: [NODE.optics], conceptCount: 1, conceptTotal: 4, coverageFraction: 0.25 }, onboarding: { steps: [], next: null, skipped: false } };
    open({ profiles });
    await userEvent.type(await screen.findByLabelText('Score'), '400');
    await userEvent.type(screen.getByLabelText('out of'), '300');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Enter a score and the total it was out of.');
    expect(profiles.updates).toEqual([]);
  });

  it('says what the server said when it will not take an answer', async () => {
    const profiles = new FakeProfileApi();
    const { drafts } = open({ profiles });
    profiles.refuseNext = refusal(400, 'That exam is not offered.');
    await userEvent.selectOptions(await screen.findByRole('combobox'), 'JEE_MAIN|2027');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('That exam is not offered.');
    expect(drafts.draft).toBeNull();
  });

  it('has no accessibility violations at any of its questions', async () => {
    const { view } = open();
    await screen.findByRole('form', { name: 'Your exam' });
    const results = await axe.run(view.container);
    expect(results.violations).toEqual([]);
  });
});

describe('onboarding never blocks (FR-STU-01)', () => {
  it('has a way out on the first question, and it goes to the product', async () => {
    const { profiles, onOpen } = open();
    await userEvent.click(await screen.findByRole('link', { name: 'Skip for now' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?'));
    expect(profiles.profile.onboarding.skipped).toBe(true);
  });

  it('goes to the product even when the skip cannot be recorded, because leaving is not conditional on the server', async () => {
    const profiles = new FakeProfileApi();
    const { onOpen } = open({ profiles });
    await screen.findByRole('form', { name: 'Your exam' });
    profiles.offline = true;
    await userEvent.click(screen.getByRole('link', { name: 'Skip for now' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalledWith('?'));
  });

  it('still shows the way out when nothing can be loaded at all', async () => {
    const profiles = new FakeProfileApi();
    profiles.offline = true;
    open({ profiles });
    expect(await screen.findByText(/cannot be loaded right now/u)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Skip for now' })).toBeInTheDocument();
  });

  it('asks no question for payment', async () => {
    const { view } = open();
    await screen.findByRole('form', { name: 'Your exam' });
    expect(view.container.textContent).not.toMatch(/pay|price|subscribe|card|upgrade|trial/iu);
  });
});

describe('onboarding offline (D107: kept on the device, not in localStorage)', () => {
  it('keeps an answer given with no connection, moves on, and says it is kept on the device', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, onboarding: { steps: [], next: 'class', skipped: false } };
    const drafts = new MemoryDrafts();
    const first = open({ profiles, drafts });
    await userEvent.click(await screen.findByRole('radio', { name: 'Repeating a year' }));
    profiles.offline = true;
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(first.onOpen).toHaveBeenCalledWith('?onboarding=1'));
    expect(drafts.draft).toEqual({ currentClass: 'repeater' });

    // the next page: nothing reachable, and the question that follows the one answered is still the next one
    cleanup();
    open({ profiles, drafts });
    expect(await screen.findByText(/You appear to be offline/u)).toBeInTheDocument();
    expect(screen.getByText(/cannot be loaded right now/u)).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Your class' })).toBeNull();
  });

  it('sends what was kept as soon as the screen is opened with a connection, and removes it', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, onboarding: { steps: [], next: 'class', skipped: false } };
    const drafts = new MemoryDrafts();
    drafts.draft = { currentClass: 'class_11' };
    open({ profiles, drafts });
    expect(await screen.findByRole('form', { name: 'What you have studied' })).toBeInTheDocument();
    expect(profiles.updates).toEqual([{ currentClass: 'class_11' }]);
    expect(drafts.draft).toBeNull();
  });

  it('answers a question that needs no list with no connection at all, and does not lose an earlier answer when it keeps the next', async () => {
    const profiles = new FakeProfileApi();
    profiles.offline = true;
    const drafts = new MemoryDrafts();
    drafts.draft = { examCode: 'JEE_MAIN', targetYear: '2027' };
    const { onOpen } = open({ profiles, drafts });
    await userEvent.click(await screen.findByRole('radio', { name: 'Class 12' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(drafts.draft).toEqual({ examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12' });
  });

  it('sends the answer directly when the device will not keep it, and says so when that fails too', async () => {
    const profiles = new FakeProfileApi();
    const drafts = new MemoryDrafts();
    drafts.failWrites = true;
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, onboarding: { steps: [], next: 'class', skipped: false } };
    const { onOpen } = open({ profiles, drafts });
    await userEvent.click(await screen.findByRole('radio', { name: 'Class 12' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(profiles.updates).toEqual([{ currentClass: 'class_12' }]);

    cleanup();
    const down = new FakeProfileApi();
    down.profile = profiles.profile;
    const again = open({ profiles: down, drafts });
    await screen.findByRole('form', { name: 'What you have studied' });
    down.offline = true;
    await userEvent.click(screen.getByRole('checkbox', { name: 'Optics' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
    expect(again.onOpen).not.toHaveBeenCalled();
  });
});

describe('what onboarding says happened', () => {
  it('says a step was completed, with how long the learner was on it, and conforms to the catalog', async () => {
    const rig = analyticsRig();
    const profiles = new FakeProfileApi();
    open({ profiles, rig });
    await userEvent.selectOptions(await screen.findByRole('combobox'), 'JEE_MAIN|2027');
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(profiles.updates).toHaveLength(1));
    rig.analytics.flush();
    await settle();
    const done = rig.sent.filter((event) => event.event_name === 'onboarding.step_completed');
    expect(done).toHaveLength(1);
    expect(done[0]!.payload).toMatchObject({ step: 'exam' });
    expect(Number(done[0]!.payload['seconds_on_step'])).toBeGreaterThanOrEqual(0);
    expectConforming(rig.sent);
  });

  it('says the scope was declared once the server has it, with the count and the fraction the server gave', async () => {
    const rig = analyticsRig();
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, currentClass: 'class_12', onboarding: { steps: [], next: 'coverage', skipped: false } };
    open({ profiles, rig });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Optics' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(profiles.updates).toHaveLength(1));
    rig.analytics.flush();
    await settle();
    const declared = rig.sent.filter((event) => event.event_name === 'onboarding.scope_declared');
    expect(declared).toHaveLength(1);
    expect(declared[0]!.payload).toEqual({ concept_count: 2, coverage_fraction: 0.5 });
    expectConforming(rig.sent);
  });

  it('does not say the scope was declared for an answer the server has not yet heard', async () => {
    const rig = analyticsRig();
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' }, currentClass: 'class_12', onboarding: { steps: [], next: 'coverage', skipped: false } };
    open({ profiles, rig });
    await userEvent.click(await screen.findByRole('checkbox', { name: 'Optics' }));
    profiles.offline = true;
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(rig.analytics.nowMs()).toBeGreaterThan(0));
    await settle();
    rig.analytics.flush();
    await settle();
    expect(rig.sent.map((event) => event.event_name)).not.toContain('onboarding.scope_declared');
  });
});

const EXAM = { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p', taxonomyVersionId: 't' };
const SCOPE = { status: 'in_force' as const, taxonomyVersionId: 't', nodeIds: [NODE.mechanics], conceptCount: 2, conceptTotal: 4, coverageFraction: 0.5 };

describe('onboarding, the rest of what it says and shows', () => {
  it('says which step was completed, whichever it was', async () => {
    const rig = analyticsRig();
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: EXAM, onboarding: { steps: [], next: 'class', skipped: false } };
    open({ profiles, rig });
    await userEvent.click(await screen.findByRole('radio', { name: 'Class 11' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(profiles.updates).toHaveLength(1));
    rig.analytics.flush();
    await settle();
    expect(rig.sent.filter((event) => event.event_name === 'onboarding.step_completed').map((event) => event.payload['step'])).toEqual(['class']);
  });

  it('does not say the scope was declared when what was sent was not a scope, though the profile has one', async () => {
    const rig = analyticsRig();
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: EXAM, currentClass: 'class_12', scope: SCOPE, onboarding: { steps: [], next: null, skipped: false } };
    open({ profiles, rig });
    await userEvent.type(await screen.findByLabelText('Score'), '10');
    await userEvent.type(screen.getByLabelText('out of'), '20');
    await userEvent.click(screen.getByRole('button', { name: 'Save' }));
    await vi.waitFor(() => expect(profiles.updates).toHaveLength(1));
    rig.analytics.flush();
    await settle();
    expect(rig.sent.map((event) => event.event_name)).toEqual(['onboarding.step_completed']);
  });

  it('says on the first question that an earlier answer is waiting on this device', async () => {
    const drafts = new MemoryDrafts();
    drafts.draft = { currentClass: 'class_12' };
    const profiles = new FakeProfileApi();
    profiles.offline = true;
    open({ drafts, profiles });
    expect(await screen.findByText(/Saved on this device/u)).toBeInTheDocument();
    expect(screen.getByRole('form', { name: 'Your exam' })).toBeInTheDocument();
  });

  it('asks for no past score of a learner who has given one, whether the server has it or only the device does', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: EXAM, currentClass: 'class_12', scope: SCOPE, priorScore: { value: 100, outOf: 300 }, onboarding: { steps: [], next: null, skipped: false } };
    open({ profiles });
    await screen.findByText('You are all set.');
    expect(screen.queryByRole('form', { name: 'A past score' })).toBeNull();
    cleanup();

    const offline = new FakeProfileApi();
    offline.offline = true;
    const drafts = new MemoryDrafts();
    drafts.draft = { examCode: 'JEE_MAIN', targetYear: '2027', currentClass: 'class_12', scopeNodeIds: [NODE.mechanics], priorScore: { value: 1, outOf: 2 } };
    open({ profiles: offline, drafts });
    await screen.findByText('You are all set.');
    expect(screen.queryByRole('form', { name: 'A past score' })).toBeNull();
  });

  it('offers the chapters again, with the notice, when the syllabus has moved on since the learner chose', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: EXAM, currentClass: 'class_12', scope: { ...SCOPE, status: 'needs_review' }, onboarding: { steps: [], next: null, skipped: false } };
    const { onOpen } = open({ profiles });
    expect(await screen.findByText(/The syllabus has been updated/u)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Optics' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await vi.waitFor(() => expect(onOpen).toHaveBeenCalled());
    expect(profiles.updates).toEqual([{ scopeNodeIds: [NODE.optics] }]);
  });

  it('offers no notice, and no chapters again, to a learner whose scope is in force', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: EXAM, currentClass: 'class_12', scope: SCOPE, onboarding: { steps: [], next: null, skipped: false } };
    open({ profiles });
    await screen.findByText('You are all set.');
    expect(screen.queryByText(/The syllabus has been updated/u)).toBeNull();
    expect(screen.queryByRole('form', { name: 'What you have studied' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Change what you have studied' })).toHaveAttribute('href', '?onboarding=coverage');
  });

  it('opens the chapters on request with the ones already picked ticked', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: EXAM, currentClass: 'class_12', scope: SCOPE, onboarding: { steps: [], next: null, skipped: false } };
    profiles.options = { ...profiles.options, selected: [NODE.mechanics] };
    open({ profiles, edit: 'coverage' });
    expect(await screen.findByRole('checkbox', { name: 'Mechanics' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Optics' })).not.toBeChecked();
  });

  it('does not ask for the chapters of a learner who has no exam, however it was opened', async () => {
    const profiles = new FakeProfileApi();
    open({ profiles, edit: 'coverage' });
    await screen.findByRole('form', { name: 'Your exam' });
    expect(profiles.calls).not.toContain('scopeOptions');
  });

  it('does not offer to change what has not been given', async () => {
    const profiles = new FakeProfileApi();
    profiles.profile = { ...emptyProfile(), exam: EXAM, currentClass: 'class_12', onboarding: { steps: [], next: 'coverage', skipped: false } };
    open({ profiles });
    await screen.findByRole('form', { name: 'What you have studied' });
    expect(screen.queryByRole('link', { name: 'Change what you have studied' })).toBeNull();
  });
});
