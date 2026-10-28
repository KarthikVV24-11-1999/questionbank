import { describe, expect, it } from 'vitest';
import { FakeLearningApi } from '../testing/fakes.js';
import { concept, escalation, notFound, plan, report, scheduled, TAXONOMY, unreachable } from '../testing/learning-fixtures.js';
import { chooseNextAction, isNotFound } from './next-action.js';

const sources = (learning: FakeLearningApi, overrides: { taxonomyVersionId?: string | null; lastAttemptId?: string | null } = {}) => ({ learning, taxonomyVersionId: TAXONOMY, lastAttemptId: null, ...overrides });

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

  it('knows a not-found by the problem the server gave, and by nothing a message happens to say', () => {
    expect(isNotFound(notFound())).toBe(true);
    expect(isNotFound(Object.assign(new Error('not found'), { problem: { status: 503 } }))).toBe(false);
    expect(isNotFound(new Error('404'))).toBe(false);
  });
});
