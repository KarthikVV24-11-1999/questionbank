import { cleanup, render, screen, within } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, describe, expect, it } from 'vitest';
import { clientEnvelopeSchema, findPii } from '@questionbank/contracts/analytics';
import { NO_ANALYTICS, type ScreenAnalytics } from '../analytics/emitter.js';
import { analyticsRig, expectConforming } from '../testing/analytics-rig.js';
import { FakeLearningApi } from '../testing/fakes.js';
import { concept, conceptMap, mapped, unreachable } from '../testing/learning-fixtures.js';
import { expectNoDomainVocabulary } from '../testing/vocabulary.js';
import { ConceptMapScreen } from './ConceptMapScreen.js';

afterEach(cleanup);

const WEAK = { kind: 'asserted', state: 'weak', confidence: 0.6 } as const;
const STRONG = { kind: 'asserted', state: 'strong', confidence: 0.9 } as const;
const EARLY = { kind: 'tentative', leaning: 'weak' } as const;

function open(configure: (learning: FakeLearningApi) => void = () => undefined, analytics: ScreenAnalytics = NO_ANALYTICS) {
  const learning = new FakeLearningApi();
  configure(learning);
  const view = render(<ConceptMapScreen learning={learning} context={{ lastAttemptId: null, pageKey: 'p', analytics }} />);
  return { learning, view };
}
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe('where the learner stands (M8-29, FR-STU-04)', () => {
  it('names each topic under the chapter it sits in, with how it stands, and a way into the answers behind it', async () => {
    open((l) => (l.map = conceptMap([mapped(1, WEAK), mapped(3, STRONG), mapped(2, WEAK)])));
    const mechanics = await screen.findByRole('region', { name: 'Physics › Mechanics' });
    expect(within(mechanics).getAllByRole('link').map((link) => link.textContent)).toEqual(['Kinematics', 'Gravitation']);
    expect(within(mechanics).getAllByRole('listitem').map((item) => item.textContent)).toEqual(['KinematicsWeak, from 8 answers', 'GravitationStrong, from 8 answers']);
    const optics = screen.getByRole('region', { name: 'Physics › Optics' });
    expect(within(optics).getByRole('link', { name: 'Ray optics' })).toHaveAttribute('href', `?topic=${concept(2)}`);
  });

  it('says a standing with too few answers is too early to say, and does not draw it as a state', async () => {
    open((l) => (l.map = conceptMap([mapped(1, EARLY, { evidenceCount: 2 }), mapped(3, WEAK)])));
    await screen.findByRole('region', { name: 'Physics › Mechanics' });
    const early = screen.getByText(/Too early to say/u);
    expect(early).toHaveTextContent('Too early to say. 2 answers so far, leaning weak');
    expect(screen.getAllByText(/^Weak, from/u)).toHaveLength(1);
    // and it is not counted as weak anywhere: one topic is stated weak, one is too early
    expect(screen.getByText('0 strong, 1 weak, 1 too early to say.')).toBeInTheDocument();
  });

  it('counts only the stated standings as weak or strong', async () => {
    open((l) => (l.map = conceptMap([mapped(1, WEAK), mapped(2, STRONG), mapped(3, EARLY), mapped(3, { kind: 'unassessed' })])));
    expect(await screen.findByText(/^1 strong, 1 weak, 1 too early to say\.$/u)).toBeInTheDocument();
  });

  it('marks a topic outside the chapters the learner said they have studied, and still shows it', async () => {
    open((l) => (l.map = conceptMap([mapped(1, WEAK, { inDeclaredScope: true }), mapped(2, WEAK, { inDeclaredScope: false }), mapped(3, WEAK, { inDeclaredScope: null })])));
    await screen.findByRole('region', { name: 'Physics › Optics' });
    expect(screen.getAllByText('Not in the chapters you told us you have studied.')).toHaveLength(1);
    expect(within(screen.getByRole('region', { name: 'Physics › Optics' })).getByText(/Not in the chapters/u)).toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(3);
  });

  it('counts the topics not started, in the singular for one', async () => {
    open((l) => (l.map = conceptMap([mapped(1, WEAK)], { unassessedCount: 7 })));
    expect(await screen.findByText('7 topics in your syllabus you have not started yet.')).toBeInTheDocument();
    cleanup();
    open((l) => (l.map = conceptMap([mapped(1, WEAK)], { unassessedCount: 1 })));
    expect(await screen.findByText('1 topic in your syllabus you have not started yet.')).toBeInTheDocument();
    cleanup();
    open((l) => (l.map = conceptMap([mapped(1, WEAK)], { unassessedCount: 0 })));
    await screen.findByRole('region', { name: 'Physics › Mechanics' });
    expect(screen.queryByText(/not started yet/u)).toBeNull();
  });

  it('groups a topic that sits at the top of the syllabus under subjects', async () => {
    open((l) => (l.map = conceptMap([{ ...mapped(1, WEAK), path: [], name: 'Physics' }])));
    expect(await screen.findByRole('region', { name: 'Subjects' })).toBeInTheDocument();
  });

  it('says plainly that nothing has been answered yet, and offers the way back', async () => {
    open((l) => (l.map = conceptMap([], { unassessedCount: 12 })));
    expect(await screen.findByText(/You have not answered anything yet/u)).toBeInTheDocument();
    expect(screen.getByText('12 topics in your syllabus you have not started yet.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to what to do next' })).toHaveAttribute('href', '?');
  });

  it('says it is opening, and says plainly when it could not', async () => {
    open((l) => (l.map = unreachable()));
    expect(screen.getByRole('status')).toHaveTextContent('Opening your progress');
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to fetch');
  });

  it('shows a learner nothing in our vocabulary, whatever the map holds', async () => {
    const { view } = open((l) => (l.map = conceptMap([mapped(1, WEAK, { inDeclaredScope: false }), mapped(2, EARLY), mapped(3, STRONG)], { unassessedCount: 4 })));
    await screen.findByRole('region', { name: 'Physics › Mechanics' });
    expectNoDomainVocabulary(view.container);
    cleanup();
    const empty = open((l) => (l.map = conceptMap([], { unassessedCount: 4 })));
    await screen.findByText(/not answered anything yet/u);
    expectNoDomainVocabulary(empty.view.container);
    cleanup();
    const failed = open((l) => (l.map = unreachable()));
    await screen.findByRole('alert');
    expectNoDomainVocabulary(failed.view.container);
  });

  it('has no accessibility violation', async () => {
    const { view } = open((l) => (l.map = conceptMap([mapped(1, WEAK, { inDeclaredScope: false }), mapped(2, EARLY), mapped(3, STRONG)])));
    await screen.findByRole('region', { name: 'Physics › Mechanics' });
    expect((await axe.run(view.container)).violations.map((violation) => violation.id)).toEqual([]);
  });

  describe('what it says happened (M8-29)', () => {
    it('says the map was viewed, once, counting the weak and the strong that are stated and not the ones that are early', async () => {
      const { analytics, sent } = analyticsRig();
      const first = open((l) => (l.map = conceptMap([mapped(1, WEAK), mapped(2, WEAK), mapped(3, STRONG), mapped(3, EARLY)])), analytics);
      await screen.findByRole('region', { name: 'Physics › Optics' });
      await settle();
      expect(sent.map((event) => event.event_name)).toEqual(['concept_map.viewed']);
      expect(sent[0]!.payload).toEqual({ weak_count: 2, strong_count: 1, drill_down: false });
      expectConforming(sent);
      expect(first.learning.calls).toEqual(['getConceptMap']);
    });

    it('says nothing while it is loading or after it failed, and emits only an event the contract accepts with no personal data in it', async () => {
      const failing = analyticsRig();
      open((l) => (l.map = unreachable()), failing.analytics);
      await screen.findByRole('alert');
      await settle();
      expect(failing.sent).toEqual([]);
      cleanup();
      const { analytics, sent } = analyticsRig();
      open((l) => (l.map = conceptMap([mapped(1, WEAK)])), analytics);
      await screen.findByRole('region', { name: 'Physics › Mechanics' });
      await settle();
      for (const event of sent) {
        expect(clientEnvelopeSchema.safeParse(event).success, event.event_name).toBe(true);
        expect(findPii(event), event.event_name).toEqual([]);
      }
    });
  });
});
