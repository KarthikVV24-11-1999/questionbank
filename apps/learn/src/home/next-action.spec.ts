import { describe, expect, it } from 'vitest';
import { FakeLearningApi } from '../testing/fakes.js';
import { concept, conceptMap, escalation, mapped, notFound, plan, report, scheduled, TAXONOMY, unreachable } from '../testing/learning-fixtures.js';
import { chooseNextAction, isNotFound } from './next-action.js';

const sources = (learning: FakeLearningApi, overrides: { taxonomyVersionId?: string | null; lastAttemptId?: string | null; declaredScope?: boolean } = {}) => ({ learning, taxonomyVersionId: TAXONOMY, lastAttemptId: null, ...overrides });

describe('the one next action (M7-57)', () => {
  it('puts an escalated concept first, before anything that is due', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ due: [scheduled(1)], escalated: [escalation(2)] });
    expect(await chooseNextAction(sources(learning))).toEqual({ kind: 'practise', why: 'escalated', conceptIdentityId: concept(2), taxonomyVersionId: TAXONOMY });
  });

  it('takes the first escalation the plan gives and the first due concept it gives, in the order the plan gives them', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(3), escalation(4)] });
    expect(await chooseNextAction(sources(learning))).toMatchObject({ why: 'escalated', conceptIdentityId: concept(3) });
    learning.plan = plan({ due: [scheduled(5), scheduled(6)] });
    expect(await chooseNextAction(sources(learning))).toMatchObject({ why: 'due', conceptIdentityId: concept(5) });
  });

  it('does not show a concept the plan no longer lists: a resolved escalation is what the server stopped sending, and nothing here remembers it', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ escalated: [escalation(2)] });
    expect(await chooseNextAction(sources(learning))).toMatchObject({ conceptIdentityId: concept(2) });
    learning.plan = plan({ escalated: [] });
    learning.weakest = [];
    expect(await chooseNextAction(sources(learning))).toEqual({ kind: 'nothing' });
  });

  it('asks for the weakest concept only when nothing is escalated or due, and only about a taxonomy it was told of', async () => {
    const learning = new FakeLearningApi();
    learning.weakest = [concept(7), concept(8)];
    expect(await chooseNextAction(sources(learning))).toEqual({ kind: 'practise', why: 'weakest', conceptIdentityId: concept(7), taxonomyVersionId: TAXONOMY });
    expect(learning.calls).toEqual(['getReviewPlan', `suggestRemediation ${TAXONOMY}`]);

    const quiet = new FakeLearningApi();
    quiet.weakest = [concept(7)];
    expect(await chooseNextAction(sources(quiet, { taxonomyVersionId: null }))).toEqual({ kind: 'nothing' });
    expect(quiet.calls).toEqual(['getReviewPlan']);
  });

  it('stops asking at the first source that has an answer', async () => {
    const learning = new FakeLearningApi();
    learning.plan = plan({ due: [scheduled(1)] });
    await chooseNextAction(sources(learning, { lastAttemptId: 'att-1' }));
    expect(learning.calls).toEqual(['getReviewPlan']);
  });

  it('points at the report of the last sitting when there is one and nothing else is asked of the learner', async () => {
    const learning = new FakeLearningApi();
    learning.reports.set('att-1', report());
    expect(await chooseNextAction(sources(learning, { lastAttemptId: 'att-1' }))).toEqual({ kind: 'read-report', attemptId: 'att-1' });
  });

  it('says there is nothing to do where there is no report either: a report the server does not have is not an error', async () => {
    const learning = new FakeLearningApi();
    learning.reports.set('att-1', notFound());
    expect(await chooseNextAction(sources(learning, { lastAttemptId: 'att-1' }))).toEqual({ kind: 'nothing' });
    expect(await chooseNextAction(sources(new FakeLearningApi()))).toEqual({ kind: 'nothing' });
  });

  it('lets every other failure through, rather than say there is nothing to do when it could not tell', async () => {
    const down = new FakeLearningApi();
    down.plan = unreachable();
    await expect(chooseNextAction(sources(down))).rejects.toThrow('Failed to fetch');
    const noWeakest = new FakeLearningApi();
    noWeakest.weakest = unreachable();
    await expect(chooseNextAction(sources(noWeakest))).rejects.toThrow('Failed to fetch');
    const noReport = new FakeLearningApi();
    noReport.reports.set('att-1', unreachable());
    await expect(chooseNextAction(sources(noReport, { lastAttemptId: 'att-1' }))).rejects.toThrow('Failed to fetch');
  });

  describe('the diagnostic (M8-32, FR-STU-03)', () => {
    const answered = conceptMap([mapped(1, { kind: 'tentative', leaning: 'weak' })]);

    it('is offered to a learner who has declared what they have studied and has answered nothing', async () => {
      const learning = new FakeLearningApi();
      expect(await chooseNextAction(sources(learning, { declaredScope: true }))).toEqual({ kind: 'diagnostic' });
      expect(learning.calls).toEqual(['getReviewPlan', `suggestRemediation ${TAXONOMY}`, 'getConceptMap']);
    });

    it('is not offered without a declared scope, which is what a short run is taken across, and the map is not read for it', async () => {
      const learning = new FakeLearningApi();
      expect(await chooseNextAction(sources(learning))).toEqual({ kind: 'nothing' });
      expect(await chooseNextAction(sources(learning, { declaredScope: false }))).toEqual({ kind: 'nothing' });
      expect(learning.calls.includes('getConceptMap')).toBe(false);
    });

    it('is not offered to a learner with any answer on the map, who has begun, and is not offered when the exam\'s syllabus is not known', async () => {
      const learning = new FakeLearningApi();
      learning.map = answered;
      expect(await chooseNextAction(sources(learning, { declaredScope: true }))).toEqual({ kind: 'nothing' });
      const unknown = new FakeLearningApi();
      expect(await chooseNextAction(sources(unknown, { declaredScope: true, taxonomyVersionId: null }))).toEqual({ kind: 'nothing' });
      expect(unknown.calls.includes('getConceptMap')).toBe(false);
    });

    it('comes after what the evidence says to do: an escalated topic, one that is due, the weakest', async () => {
      const learning = new FakeLearningApi();
      learning.plan = plan({ escalated: [escalation(2)] });
      expect(await chooseNextAction(sources(learning, { declaredScope: true }))).toMatchObject({ kind: 'practise', why: 'escalated' });
      expect(learning.calls.includes('getConceptMap')).toBe(false);
      const weak = new FakeLearningApi();
      weak.weakest = [concept(3)];
      expect(await chooseNextAction(sources(weak, { declaredScope: true }))).toMatchObject({ kind: 'practise', why: 'weakest' });
    });

    it('comes before the report of a sitting', async () => {
      const learning = new FakeLearningApi();
      learning.reports.set('att-1', report());
      expect(await chooseNextAction(sources(learning, { declaredScope: true, lastAttemptId: 'att-1' }))).toEqual({ kind: 'diagnostic' });
      learning.map = answered;
      expect(await chooseNextAction(sources(learning, { declaredScope: true, lastAttemptId: 'att-1' }))).toEqual({ kind: 'read-report', attemptId: 'att-1' });
    });

    it('is left out, and not an error, when the map cannot be read: the invitation is never why home does not open', async () => {
      const learning = new FakeLearningApi();
      learning.map = unreachable();
      expect(await chooseNextAction(sources(learning, { declaredScope: true }))).toEqual({ kind: 'nothing' });
    });
  });

  it('knows a not-found by the problem the server gave, and by nothing a message happens to say', () => {
    expect(isNotFound(notFound())).toBe(true);
    expect(isNotFound(Object.assign(new Error('not found'), { problem: { status: 503 } }))).toBe(false);
    expect(isNotFound(new Error('404'))).toBe(false);
  });
});
