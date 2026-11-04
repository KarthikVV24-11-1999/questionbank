import { describe, expect, it } from 'vitest';
import type { AnswerKeyData } from '../../../scoring/public/index.js';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../../platform/config/config.js';
import { InMemoryAttempts, StubCorpus, StubPins } from '../../../../testing/assessment-fakes.js';
import { TAG, id } from '../../../../testing/assessment-fixtures.js';
import { expectValue } from '../../../../testing/expect-result.js';
import type { AssemblyCandidate } from '../../domain/assembly.js';
import { startAttempt, submitAttempt, type Attempt } from '../../domain/attempt.js';
import { err, ok } from '../../domain/result.js';
import type { ResponseEvent } from '../../domain/response-event.js';
import { CreatePracticeAttemptHandler } from '../handlers/practice-handlers.js';
import { ScorePracticeAttemptConsumer, type PracticeScoringConsumerDependencies } from './practice-scoring-consumer.js';
import { SCORING_CONSUMER_PRINCIPAL_ID, ScoringFailure } from './scoring-consumer.js';

/** The practice consumer's decisions, branch by branch, against doubles. The whole path, through the relay and the real rules, is `practice-loop.integration.spec.ts`. */
const SINGLE: AnswerKeyData = { kind: 'SINGLE_CORRECT', optionId: 'b' };
const cand = (n: number): AssemblyCandidate => ({ itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), itemType: 'SINGLE_CORRECT_MCQ', difficultyBand: 'moderate', conceptIdentityIds: [id(0xc0, n)], stimulusVersionId: null, isPublished: true, isAnchor: false, anchorExposureCap: null });

async function submittedRun(): Promise<Attempt> {
  const attempts = new InMemoryAttempts();
  let n = 0;
  const created = expectValue(
    await new CreatePracticeAttemptHandler({
      attempts, corpus: new StubCorpus({ candidates: [1, 2, 3].map(cand), exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] }), practicePins: new StubPins(),
      intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS, clock: { now: () => new Date('2026-11-04T09:00:00.000Z') }, identifiers: { next: () => id(0xd0, (n += 1)) }, audit: { record: async () => undefined },
    }).handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 3, idempotencyKey: 'k' } as never, { principal: { kind: 'human', id: id(TAG.student, 1), roleContext: ['learner'] }, correlationId: 'c' }),
  );
  const run = attempts.stored.get(created.attempt.attemptId)!;
  const started = expectValue(startAttempt(run, '2026-11-04T09:01:00.000Z'));
  return expectValue(submitAttempt(started, { reason: 'manual', idempotencyKey: 'k' }, '2026-11-04T09:30:00.000Z'));
}

const event = (attempt: Attempt, n: number, answer: string, slotIndex: number): ResponseEvent => ({
  eventId: id(TAG.event, n), attemptId: attempt.attemptId, slotId: attempt.slots[slotIndex]!.slotId, itemVersionId: attempt.slots[slotIndex]!.itemVersionId, sequence: n, kind: 'select', answer,
  clientMonotonicMs: n * 1_000, serverReceivedAt: '2026-11-04T09:10:00.000Z', deviceRef: 'd', afterSubmission: false,
});

describe('scoring a submitted practice run (M8-25, D77)', () => {
  it('builds the input from the run\'s own slots, in one section, each worth what the profile pays per item, and scores it as the system', async () => {
    const attempt = await submittedRun();
    const calls: { command?: Record<string, unknown>; context?: unknown; keys?: unknown } = {};
    const consumer = new ScorePracticeAttemptConsumer({
      attempts: { findById: async () => ok(attempt) },
      responses: { findByAttempt: async () => ok([event(attempt, 1, 'b', 0), event(attempt, 2, 'a', 1)]) },
      keys: { handle: async (query: unknown) => ((calls.keys = query), ok(attempt.slots.map((slot) => ({ itemVersionId: slot.itemVersionId, itemType: 'SINGLE_CORRECT_MCQ', answerKey: SINGLE })))) },
      spec: { handle: async () => ok({ markingRuleSet: { schemaVersion: 1, rules: [] }, markingRuleSetHash: attempt.markingRuleSetHash, aggregation: { sectionAggregation: 'SUM', totalAggregation: 'SUM_OF_SECTIONS', rounding: { mode: 'NONE', decimalPlaces: 0 }, floorAtZero: false, bestOf: [{ sectionOrdinal: 1, countScored: 1 }] }, marksPerItem: 4 }) },
      scorer: { handle: async (command: unknown, context: unknown) => ((calls.command = command as Record<string, unknown>), (calls.context = context), ok({})) },
    } as unknown as PracticeScoringConsumerDependencies);
    await consumer.handle({ messageId: 'm', correlationId: 'c', payload: { attemptId: attempt.attemptId } });

    const command = calls.command as { idempotencyKey: string; ruleSetHash: string; aggregation: Record<string, unknown>; input: { sections: Array<{ ordinal: number; slots: Array<{ slotId: string; ordinal: number; marksAvailable: number; response?: unknown }> }> } };
    expect(calls.keys).toEqual({ itemVersionIds: attempt.slots.map((slot) => slot.itemVersionId) });
    expect(command.idempotencyKey).toBe(`submission:${attempt.attemptId}`);
    expect(command.ruleSetHash).toBe(attempt.markingRuleSetHash);
    expect(command.input.sections).toHaveLength(1);
    expect(command.input.sections[0]!.ordinal).toBe(1);
    expect(command.input.sections[0]!.slots.map((slot) => [slot.slotId, slot.ordinal, slot.marksAvailable])).toEqual(attempt.slots.map((slot, index) => [slot.slotId, index + 1, 4]));
    expect(command.input.sections[0]!.slots.map((slot) => slot.response)).toEqual([{ kind: 'OPTION_SELECTION', optionIds: ['b'] }, { kind: 'OPTION_SELECTION', optionIds: ['a'] }, undefined]);
    // the profile's best-of names sections of a paper; a run's one section is a bag of slots and none of its answers is dropped by it
    expect(command.aggregation).not.toHaveProperty('bestOf');
    expect(command.aggregation).toMatchObject({ sectionAggregation: 'SUM', floorAtZero: false });
    expect(calls.context).toMatchObject({ principal: { kind: 'system', id: SCORING_CONSUMER_PRINCIPAL_ID, roleContext: ['system'] }, correlationId: 'c' });
  });

  it('fails loudly, naming why, and never scores a zero for what a run cannot give', async () => {
    const attempt = await submittedRun();
    const keys = attempt.slots.map((slot) => ({ itemVersionId: slot.itemVersionId, itemType: 'SINGLE_CORRECT_MCQ', answerKey: SINGLE }));
    const spec = { markingRuleSet: { schemaVersion: 1, rules: [] }, markingRuleSetHash: attempt.markingRuleSetHash, aggregation: { sectionAggregation: 'SUM', totalAggregation: 'SUM_OF_SECTIONS', rounding: { mode: 'NONE', decimalPlaces: 0 }, floorAtZero: false }, marksPerItem: 4 };
    const base = {
      attempts: { findById: async () => ok(attempt) },
      responses: { findByAttempt: async () => ok([]) },
      keys: { handle: async () => ok(keys) },
      spec: { handle: async () => ok(spec) },
      scorer: { handle: async () => ok({}) },
    };
    const cases: Array<[string, Record<string, unknown>, string, Record<string, unknown>?]> = [
      ['an event naming no attempt', {}, 'PAYLOAD_INVALID', {}],
      ['a run that is not there', { attempts: { findById: async () => err({ kind: 'NotFound', code: 'NOT_FOUND', message: 'none' }) } }, 'NOT_FOUND'],
      ['a run that was not submitted', { attempts: { findById: async () => ok({ ...attempt, state: 'in_progress' }) } }, 'ATTEMPT_NOT_SUBMITTED'],
      ['an attempt that is a mock', { attempts: { findById: async () => ok({ ...attempt, mode: 'mock', formId: id(TAG.form, 1) }) } }, 'ATTEMPT_IS_NOT_A_PRACTICE_RUN'],
      ['a run with no slot', { attempts: { findById: async () => ok({ ...attempt, slots: [] }) } }, 'PRACTICE_RUN_HAS_NO_SLOTS'],
      ['a log that cannot be read', { responses: { findByAttempt: async () => err({ kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'down' }) } }, 'STORE_UNAVAILABLE'],
      ['keys content will not give', { keys: { handle: async () => err({ kind: 'NotFound', code: 'KEYS_GONE', message: 'none' }) } }, 'KEYS_GONE'],
      ['rules curriculum will not give', { spec: { handle: async () => err({ kind: 'NotFound', code: 'RULES_GONE', message: 'none' }) } }, 'RULES_GONE'],
      ['rules that no longer hash to the pin', { spec: { handle: async () => ok({ ...spec, markingRuleSetHash: 'f'.repeat(64) }) } }, 'MARKING_RULES_NO_LONGER_MATCH_THE_PIN'],
      ['a profile whose sections pay differently for an item', { spec: { handle: async () => ok({ ...spec, marksPerItem: null }) } }, 'PRACTICE_MARKS_UNDEFINED'],
      ['a profile that does not say', { spec: { handle: async () => ok({ ...spec, marksPerItem: undefined }) } }, 'PRACTICE_MARKS_UNDEFINED'],
      ['a slot with no key', { keys: { handle: async () => ok([]) } }, 'ANSWER_KEY_MISSING'],
      ['scoring that fails', { scorer: { handle: async () => err({ kind: 'RuleViolation', code: 'RULES_REFUSED', message: 'no' }) } }, 'RULES_REFUSED'],
    ];
    for (const [label, override, code, payload] of cases) {
      const consumer = new ScorePracticeAttemptConsumer({ ...base, ...override } as unknown as PracticeScoringConsumerDependencies);
      const failure = await consumer.handle({ messageId: 'm', correlationId: 'c', payload: payload ?? { attemptId: attempt.attemptId } }).then(() => null, (error: unknown) => error);
      expect(failure, label).toBeInstanceOf(ScoringFailure);
      expect((failure as ScoringFailure).message, label).toContain(code);
    }
  });

  it('numbers the slots from one in the order of their ordinals, however the run holds them', async () => {
    const attempt = await submittedRun();
    const calls: { command?: { input: { sections: Array<{ slots: Array<{ slotId: string; ordinal: number }> }> } } } = {};
    const consumer = new ScorePracticeAttemptConsumer({
      attempts: { findById: async () => ok({ ...attempt, slots: [...attempt.slots].reverse() }) },
      responses: { findByAttempt: async () => ok([]) },
      keys: { handle: async () => ok(attempt.slots.map((slot) => ({ itemVersionId: slot.itemVersionId, itemType: 'SINGLE_CORRECT_MCQ', answerKey: SINGLE }))) },
      spec: { handle: async () => ok({ markingRuleSet: { schemaVersion: 1, rules: [] }, markingRuleSetHash: attempt.markingRuleSetHash, aggregation: { sectionAggregation: 'SUM', totalAggregation: 'SUM_OF_SECTIONS', rounding: { mode: 'NONE', decimalPlaces: 0 }, floorAtZero: false }, marksPerItem: 4 }) },
      scorer: { handle: async (command: unknown) => ((calls.command = command as never), ok({})) },
    } as unknown as PracticeScoringConsumerDependencies);
    await consumer.handle({ messageId: 'm', correlationId: 'c', payload: { attemptId: attempt.attemptId } });
    expect(calls.command!.input.sections[0]!.slots.map((slot) => [slot.slotId, slot.ordinal])).toEqual(attempt.slots.map((slot, index) => [slot.slotId, index + 1]));
  });

  it('asks scoring once more when it lost a race to write, and fails if the second ask fails too', async () => {
    const attempt = await submittedRun();
    const make = (answers: unknown[]) => {
      let calls = 0;
      return {
        count: () => calls,
        consumer: new ScorePracticeAttemptConsumer({
          attempts: { findById: async () => ok(attempt) }, responses: { findByAttempt: async () => ok([]) },
          keys: { handle: async () => ok(attempt.slots.map((slot) => ({ itemVersionId: slot.itemVersionId, itemType: 'SINGLE_CORRECT_MCQ', answerKey: SINGLE }))) },
          spec: { handle: async () => ok({ markingRuleSet: { schemaVersion: 1, rules: [] }, markingRuleSetHash: attempt.markingRuleSetHash, aggregation: { sectionAggregation: 'SUM', totalAggregation: 'SUM_OF_SECTIONS', rounding: { mode: 'NONE', decimalPlaces: 0 }, floorAtZero: false }, marksPerItem: 4 }) },
          scorer: { handle: async () => answers[calls++] },
        } as unknown as PracticeScoringConsumerDependencies),
      };
    };
    const conflict = err({ kind: 'Conflict', code: 'CONFLICT', message: 'a current score record already exists' });
    const won = make([conflict, ok({})]);
    await won.consumer.handle({ messageId: 'm', correlationId: 'c', payload: { attemptId: attempt.attemptId } });
    expect(won.count()).toBe(2);
    const lost = make([conflict, conflict]);
    await expect(lost.consumer.handle({ messageId: 'm', correlationId: 'c', payload: { attemptId: attempt.attemptId } })).rejects.toThrow('CONFLICT');
  });

  it('is named, for the relay\'s report and an operator\'s log', () => {
    expect(new ScorePracticeAttemptConsumer({} as PracticeScoringConsumerDependencies).name).toBe('ScorePracticeAttempt');
  });
});
