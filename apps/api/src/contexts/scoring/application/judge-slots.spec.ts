import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createAnswerKey } from '../domain/answer-key.js';
import { DEFAULT_AGGREGATION } from '../domain/aggregation-data.js';
import { createScoringInput, type CreateScoredSlot } from '../domain/scoring-input.js';
import { JEE_MAIN_RULE_SET } from '../../../testing/marking-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { JudgeSlotsHandler } from './handlers/judge-handler.js';

/**
 * M7-29 — `JudgeSlots` applies the marking rules to some responses and writes nowhere. It is the same pure function that scores an attempt, so what it says
 * of an answer is what a score would; and it answers with a slot and a word.
 */
const HASH = 'pinned-hash';
const key = expectValue(createAnswerKey({ kind: 'SINGLE_CORRECT', optionId: 'B' }));
const ctx = (role: string) => ({ principal: { kind: 'system' as const, id: randomUUID(), roleContext: [role] }, correlationId: 'c' });

const slot = (response: CreateScoredSlot['response'], slotId = 'a'): CreateScoredSlot => ({
  slotId, ordinal: 1, itemType: 'SINGLE_CORRECT_MCQ', itemVersionId: randomUUID(), marksAvailable: 1, answerKey: key, ...(response === undefined ? {} : { response }),
});
const command = (response: CreateScoredSlot['response'], hash = HASH) => ({
  input: expectValue(
    createScoringInput({
      attemptId: randomUUID(),
      pin: { examProfileVersionId: randomUUID(), markingRuleSetHash: HASH, ruleSchemaVersion: 1, taxonomyVersionId: randomUUID(), itemVersionIds: [randomUUID()] },
      sections: [{ ordinal: 1, slots: [slot(response)] }],
      overrides: [],
    }),
  ),
  ruleSet: JEE_MAIN_RULE_SET,
  ruleSetHash: hash,
  aggregation: DEFAULT_AGGREGATION,
});
let ids = 0;
const handler = () => new JudgeSlotsHandler({ clock: { now: () => new Date('2026-10-27T09:00:00.000Z') }, identifiers: { next: () => `id-${(ids += 1)}` } });

describe('JudgeSlots', () => {
  it('says correct, incorrect and unattempted as the rules attribute them, and nothing else about the slot', async () => {
    const verdict = async (response: CreateScoredSlot['response']) => expectValue(await handler().handle(command(response), ctx('system')));
    expect(await verdict({ kind: 'OPTION_SELECTION', optionIds: ['B'] })).toEqual([{ slotRef: 'a', outcome: 'correct' }]);
    expect(await verdict({ kind: 'OPTION_SELECTION', optionIds: ['C'] })).toEqual([{ slotRef: 'a', outcome: 'incorrect' }]);
    expect(await verdict(undefined)).toEqual([{ slotRef: 'a', outcome: 'unattempted' }]);
    expect(Object.keys((await verdict({ kind: 'OPTION_SELECTION', optionIds: ['B'] }))[0]!)).toEqual(['slotRef', 'outcome']);
  });

  it('is the system\'s alone', async () => {
    for (const role of ['learner', 'content_ops', 'ops', 'admin']) {
      expect(expectError(await handler().handle(command(undefined), ctx(role))).kind, role).toBe('Authorization');
    }
  });

  it('refuses rules the attempt was not pinned to, as scoring does', async () => {
    expect(expectError(await handler().handle(command({ kind: 'OPTION_SELECTION', optionIds: ['B'] }, 'another-hash'), ctx('system'))).code).toBe('RULE_SET_NOT_PINNED');
  });

  it('agrees with scoring over a shared set of responses, since both call the one function', async () => {
    const { scoreAttempt } = await import('../domain/score-attempt.js');
    for (const response of [{ kind: 'OPTION_SELECTION' as const, optionIds: ['B'] }, { kind: 'OPTION_SELECTION' as const, optionIds: ['D'] }, undefined]) {
      const c = command(response);
      const scored = expectValue(scoreAttempt({ ...c, computedAt: '2026-10-27T09:00:00.000Z', scoreRecordId: 'r' }));
      const judged = expectValue(await handler().handle(c, ctx('system')));
      expect(judged.map((entry) => entry.outcome)).toEqual(scored.itemOutcomes.map((outcome) => outcome.correctness));
    }
  });
});
