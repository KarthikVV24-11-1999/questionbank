import { describe, expect, it } from 'vitest';
import type { AnswerKeyData } from '../../../scoring/public/index.js';
import { TAG, anAttempt, id } from '../../../../testing/assessment-fixtures.js';
import { err, ok } from '../../domain/result.js';
import type { Attempt } from '../../domain/attempt.js';
import type { ResponseEvent } from '../../domain/response-event.js';
import { ScoreSubmittedAttemptConsumer, ScoringFailure, SCORING_CONSUMER_PRINCIPAL_ID, toResponseSnapshot, type ScoringConsumerDependencies } from './scoring-consumer.js';
import { submitAttempt, startAttempt } from '../../domain/attempt.js';
import { expectValue } from '../../../../testing/expect-result.js';

/**
 * The scoring consumer's decisions, branch by branch, against doubles. The whole path — through the relay, the real keys, the real rules and
 * the real score record — is `assessment-scoring.integration.spec.ts`.
 */
const SINGLE: AnswerKeyData = { kind: 'SINGLE_CORRECT', optionId: 'b' };

describe('reading an answer as the item\'s kind takes it', () => {
  it('reads a choice as option ids: one or several, nothing blank', () => {
    for (const type of ['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ']) {
      expect(toResponseSnapshot(type, 'b')).toEqual({ kind: 'OPTION_SELECTION', optionIds: ['b'] });
      expect(toResponseSnapshot(type, ['a', 'c', '', 7])).toEqual({ kind: 'OPTION_SELECTION', optionIds: ['a', 'c'] });
      expect(toResponseSnapshot(type, [])).toBeUndefined();
      expect(toResponseSnapshot(type, 12)).toBeUndefined();
    }
  });

  it('reads matching as pairs written "left:right", and an unreadable pair as no pair', () => {
    expect(toResponseSnapshot('MATCHING', ['l1:r2', 'l2:r1'])).toEqual({ kind: 'MATCHING', pairs: [{ left: 'l1', right: 'r2' }, { left: 'l2', right: 'r1' }] });
    expect(toResponseSnapshot('MATCHING', 'l1:r2')).toEqual({ kind: 'MATCHING', pairs: [{ left: 'l1', right: 'r2' }] });
    expect(toResponseSnapshot('MATCHING', ['l1', 'a:b:c', ':r', 'l:', 4])).toBeUndefined();
  });

  it('reads a numeric answer as the learner\'s own text, whether typed as text or as a number', () => {
    expect(toResponseSnapshot('NUMERIC', '9.81')).toEqual({ kind: 'NUMERIC_ENTRY', raw: '9.81' });
    expect(toResponseSnapshot('NUMERIC', 9.81)).toEqual({ kind: 'NUMERIC_ENTRY', raw: '9.81' });
    expect(toResponseSnapshot('NUMERIC', '   ')).toBeUndefined();
    expect(toResponseSnapshot('NUMERIC', ['1', '2'])).toBeUndefined();
  });

  it('is unattempted for no answer and for an item type it does not know', () => {
    expect(toResponseSnapshot('SINGLE_CORRECT_MCQ', null)).toBeUndefined();
    expect(toResponseSnapshot('SINGLE_CORRECT_MCQ', undefined)).toBeUndefined();
    expect(toResponseSnapshot('ESSAY', 'text')).toBeUndefined();
  });
});

function submitted(): Attempt {
  const created = anAttempt();
  const started = expectValue(startAttempt(created, '2026-10-21T09:00:00.000Z'));
  return expectValue(submitAttempt(started, { reason: 'manual', idempotencyKey: 'k' }, '2026-10-21T10:00:00.000Z'));
}

const event = (attempt: Attempt, n: number, kind: ResponseEvent['kind'], answer: ResponseEvent['answer'] = null, slotIndex = 0): ResponseEvent => ({
  eventId: id(TAG.event, n),
  attemptId: attempt.attemptId,
  slotId: attempt.slots[slotIndex]!.slotId,
  itemVersionId: attempt.slots[slotIndex]!.itemVersionId,
  sequence: n,
  kind,
  answer,
  clientMonotonicMs: n * 1_000,
  serverReceivedAt: '2026-10-21T09:30:00.000Z',
  deviceRef: 'd',
  afterSubmission: false,
});

describe('scoring a submitted attempt', () => {
  const attempt = submitted();
  const envelope = { messageId: 'm', correlationId: 'c', payload: { attemptId: attempt.attemptId } };
  const formView = {
    sections: [
      {
        ordinal: 1,
        slots: attempt.slots.map((slot) => ({ slotId: slot.slotId, ordinal: slot.ordinal, itemVersionId: slot.itemVersionId, marksAvailable: 4 })),
      },
    ],
  };
  const keys = attempt.slots.map((slot) => ({ itemVersionId: slot.itemVersionId, itemType: 'SINGLE_CORRECT_MCQ', answerKey: SINGLE }));
  const spec = { markingRuleSet: { schemaVersion: 1, rules: [] }, markingRuleSetHash: attempt.markingRuleSetHash, aggregation: { sectionAggregation: 'SUM', totalAggregation: 'SUM_OF_SECTIONS', rounding: { mode: 'NONE', decimalPlaces: 0 }, floorAtZero: false } };

  function deps(overrides: Record<string, unknown> = {}) {
    const calls: { command?: unknown; context?: unknown; keys?: unknown } = {};
    const base = {
      attempts: { findById: async () => ok(attempt) },
      forms: { findById: async () => ok(formView) },
      responses: { findByAttempt: async () => ok([event(attempt, 1, 'select', 'b', 0), event(attempt, 2, 'select', 'a', 1)]) },
      keys: { handle: async (query: unknown) => ((calls.keys = query), ok(keys)) },
      spec: { handle: async () => ok(spec) },
      scorer: { handle: async (command: unknown, context: unknown) => ((calls.command = command), (calls.context = context), ok({})) },
      ...overrides,
    };
    return { calls, consumer: new ScoreSubmittedAttemptConsumer(base as unknown as ScoringConsumerDependencies) };
  }

  it('asks content for the keys of the versions the attempt pinned, and scoring for a score under the system', async () => {
    const { calls, consumer } = deps();
    await consumer.handle(envelope);
    expect(calls.keys).toEqual({ itemVersionIds: attempt.slots.map((slot) => slot.itemVersionId) });
    const command = calls.command as { idempotencyKey: string; ruleSetHash: string; input: { attemptId: string; sections: { slots: { response?: unknown }[] }[] } };
    expect(command.idempotencyKey).toBe(`submission:${attempt.attemptId}`);
    expect(command.ruleSetHash).toBe(attempt.markingRuleSetHash);
    expect(command.input.attemptId).toBe(attempt.attemptId);
    // the answers are the projection of the log: slot 1 chose b, slot 2 chose a, slot 3 nothing
    expect(command.input.sections[0]!.slots.map((slot) => slot.response)).toEqual([
      { kind: 'OPTION_SELECTION', optionIds: ['b'] },
      { kind: 'OPTION_SELECTION', optionIds: ['a'] },
      undefined,
    ]);
    expect(calls.context).toMatchObject({ principal: { kind: 'system', id: SCORING_CONSUMER_PRINCIPAL_ID, roleContext: ['system'] }, correlationId: 'c' });
  });

  it('fails loudly, naming why, for anything that stops the attempt being scored', async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ['an event naming no attempt', {}, 'PAYLOAD_INVALID'],
      ['an attempt that is not there', { attempts: { findById: async () => err({ kind: 'NotFound', code: 'NOT_FOUND', message: 'no attempt' }) } }, 'NOT_FOUND'],
      ['an attempt that was not submitted', { attempts: { findById: async () => ok({ ...attempt, state: 'in_progress' }) } }, 'ATTEMPT_NOT_SUBMITTED'],
      ['a form that is not there', { forms: { findById: async () => err({ kind: 'NotFound', code: 'FORM_GONE', message: 'no form' }) } }, 'FORM_GONE'],
      ['a log that cannot be read', { responses: { findByAttempt: async () => err({ kind: 'Unavailable', code: 'STORE_UNAVAILABLE', message: 'down' }) } }, 'STORE_UNAVAILABLE'],
      ['keys content will not give', { keys: { handle: async () => err({ kind: 'NotFound', code: 'KEYS_GONE', message: 'no keys' }) } }, 'KEYS_GONE'],
      ['rules curriculum will not give', { spec: { handle: async () => err({ kind: 'NotFound', code: 'RULES_GONE', message: 'no rules' }) } }, 'RULES_GONE'],
      ['rules that no longer hash to the pin', { spec: { handle: async () => ok({ ...spec, markingRuleSetHash: 'f'.repeat(64) }) } }, 'MARKING_RULES_NO_LONGER_MATCH_THE_PIN'],
      ['a slot with no key', { keys: { handle: async () => ok([]) } }, 'ANSWER_KEY_MISSING'],
      ['a key the executor refuses', { keys: { handle: async () => ok(keys.map((view) => ({ ...view, answerKey: { kind: 'SINGLE_CORRECT', optionId: '' } }))) } }, ''],
      ['a scoring input the executor refuses', { forms: { findById: async () => ok({ sections: [] }) } }, 'SECTIONS_REQUIRED'],
      ['scoring that fails', { scorer: { handle: async () => err({ kind: 'RuleViolation', code: 'RULES_REFUSED', message: 'no' }) } }, 'RULES_REFUSED'],
    ];
    for (const [label, override, code] of cases) {
      const target = label === 'an event naming no attempt' ? { ...envelope, payload: {} } : envelope;
      const { consumer } = deps(override);
      const failure = await consumer.handle(target).then(() => null, (error: unknown) => error);
      expect(failure, label).toBeInstanceOf(ScoringFailure);
      expect((failure as ScoringFailure).message, label).toContain(code);
    }
  });

  it('asks scoring once more when it lost a race to write, and succeeds on the winner\'s record', async () => {
    const answers = [err({ kind: 'Conflict', code: 'CONFLICT', message: 'a current score record already exists' }), ok({})];
    let calls = 0;
    const { consumer } = deps({ scorer: { handle: async () => answers[calls++]! } });
    await consumer.handle(envelope);
    expect(calls).toBe(2);
  });

  it('fails if the second ask fails too', async () => {
    const { consumer } = deps({ scorer: { handle: async () => err({ kind: 'Conflict', code: 'CONFLICT', message: 'still' }) } });
    await expect(consumer.handle(envelope)).rejects.toThrow('CONFLICT');
  });

  it('is named, for the relay\'s report and an operator\'s log', () => {
    expect(deps().consumer.name).toBe('ScoreSubmittedAttempt');
  });
});
