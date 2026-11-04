import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { NO_ANALYTICS, type ScreenAnalytics } from '../analytics/emitter.js';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import { FakeLearningApi } from '../testing/fakes.js';
import { concept, evidence, notFound } from '../testing/learning-fixtures.js';
import { expectNoDomainVocabulary } from '../testing/vocabulary.js';
import { ANSWERS_PER_PAGE, TopicScreen } from './TopicScreen.js';

afterEach(cleanup);

function open(configure: (learning: FakeLearningApi) => void, from = 0, analytics: ScreenAnalytics = NO_ANALYTICS) {
  const learning = new FakeLearningApi();
  configure(learning);
  const view = render(<TopicScreen learning={learning} conceptIdentityId={concept(1)} from={from} context={{ lastAttemptId: null, pageKey: 'p', analytics }} />);
  return { learning, view };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
const serve = (total: number, standing?: Parameters<typeof evidence>[4]) => (l: FakeLearningApi) => l.evidenceOf.set(concept(1), (offset, limit) => evidence(1, total, offset, limit, standing));

describe('the answers behind a topic (M8-29, FR-STU-04 rule 1)', () => {
  it('names the topic and where it sits, says how it stands, and lists the answers newest first with when and how each went', async () => {
    const { learning } = open(serve(3));
    expect(await screen.findByRole('heading', { level: 1, name: 'Kinematics' })).toBeInTheDocument();
    expect(screen.getByLabelText('Where it sits in the syllabus')).toHaveTextContent('Physics › Mechanics');
    expect(screen.getByText('Weak, from 3 answers')).toBeInTheDocument();
    const answers = within(screen.getByRole('list', { name: 'Your answers, newest first' })).getAllByRole('listitem');
    expect(answers).toHaveLength(3);
    expect(answers.map((answer) => answer.textContent?.split(': ').at(-1))).toEqual(['right', 'wrong', 'right']);
    expect(answers[0]!.textContent).toMatch(/Nov 2026/u);
    expect(learning.calls).toEqual([`getConceptEvidence ${concept(1)} ${ANSWERS_PER_PAGE} 0`]);
  });

  it('says a standing with too few answers is too early to say', async () => {
    open(serve(2, { kind: 'tentative', leaning: 'developing' }));
    expect(await screen.findByText('Too early to say. 2 answers so far, leaning developing')).toBeInTheDocument();
  });

  it('pages by address: the first page links to earlier answers, a later one to newer and earlier, the last to newer only', async () => {
    open(serve(45));
    const earlier = await screen.findByRole('link', { name: 'Earlier answers' });
    expect(earlier).toHaveAttribute('href', `?topic=${concept(1)}&from=20`);
    expect(screen.queryByRole('link', { name: 'Newer answers' })).toBeNull();
    cleanup();

    open(serve(45), 20);
    expect(await screen.findByRole('link', { name: 'Earlier answers' })).toHaveAttribute('href', `?topic=${concept(1)}&from=40`);
    expect(screen.getByRole('link', { name: 'Newer answers' })).toHaveAttribute('href', `?topic=${concept(1)}`);
    expect(screen.getByRole('list', { name: 'Your answers, newest first' })).toHaveAttribute('start', '21');
    cleanup();

    open(serve(45), 40);
    await screen.findByRole('link', { name: 'Newer answers' });
    expect(screen.getByRole('link', { name: 'Newer answers' })).toHaveAttribute('href', `?topic=${concept(1)}&from=20`);
    expect(screen.queryByRole('link', { name: 'Earlier answers' })).toBeNull();
    expect(within(screen.getByRole('list', { name: 'Your answers, newest first' })).getAllByRole('listitem')).toHaveLength(5);
  });

  it('has no paging links when everything fits on one page, and always a way back', async () => {
    open(serve(ANSWERS_PER_PAGE));
    await screen.findByRole('heading', { level: 1, name: 'Kinematics' });
    expect(screen.queryByRole('link', { name: /answers$/u })).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to where you stand' })).toHaveAttribute('href', '?map=1');
  });

  it('says it is opening, and says plainly when there is nothing to show', async () => {
    open((l) => l.evidenceOf.set(concept(1), () => notFound()));
    expect(screen.getByRole('status')).toHaveTextContent('Opening your answers');
    expect(await screen.findByRole('alert')).toHaveTextContent('REPORT_NOT_FOUND');
    expect(screen.getByRole('heading', { level: 1, name: 'Your answers' })).toBeInTheDocument();
  });

  it('shows a learner nothing in our vocabulary: the answers, the early standing, the loading screen and the failure', async () => {
    const loading = open(serve(45));
    expectNoDomainVocabulary(loading.view.container);
    await screen.findByRole('heading', { level: 1, name: 'Kinematics' });
    expectNoDomainVocabulary(loading.view.container);
    cleanup();
    const early = open(serve(2, { kind: 'tentative', leaning: 'weak' }), 0);
    await screen.findByText(/Too early to say/u);
    expectNoDomainVocabulary(early.view.container);
    cleanup();
    const failed = open((l) => l.evidenceOf.set(concept(1), () => notFound()));
    await screen.findByRole('alert');
    expectNoDomainVocabulary(failed.view.container);
  });

  it('has no accessibility violation', async () => {
    const { view } = open(serve(45), 20);
    await screen.findByRole('heading', { level: 1, name: 'Kinematics' });
    expect((await axe.run(view.container)).violations.map((violation) => violation.id)).toEqual([]);
  });

  describe('what it says happened (M8-29)', () => {
    it('says the map was viewed as a drill-down, once, for this topic, counting its standing the way the map does', async () => {
      const weak = analyticsRig();
      open(serve(8), 0, weak.analytics);
      await screen.findByRole('heading', { level: 1, name: 'Kinematics' });
      await settle();
      expect(weak.sent.map((event) => event.event_name)).toEqual(['concept_map.viewed']);
      expect(weak.sent[0]).toMatchObject({ payload: { weak_count: 1, strong_count: 0, drill_down: true }, context: { concept_identity_id: concept(1) } });
      expectConforming(weak.sent);
      cleanup();

      const strong = analyticsRig();
      open(serve(8, { kind: 'asserted', state: 'strong', confidence: 0.9 }), 0, strong.analytics);
      await screen.findByRole('heading', { level: 1, name: 'Kinematics' });
      await settle();
      expect(strong.sent[0]!.payload).toEqual({ weak_count: 0, strong_count: 1, drill_down: true });
      cleanup();

      const early = analyticsRig();
      open(serve(2, { kind: 'tentative', leaning: 'weak' }), 0, early.analytics);
      await screen.findByText(/Too early to say/u);
      await settle();
      expect(early.sent[0]!.payload).toEqual({ weak_count: 0, strong_count: 0, drill_down: true });
    });

    it('says nothing when the answers could not be read', async () => {
      const { analytics, sent } = analyticsRig();
      open((l) => l.evidenceOf.set(concept(1), () => notFound()), 0, analytics);
      await screen.findByRole('alert');
      await settle();
      expect(sent).toEqual([]);
    });
  });
});
