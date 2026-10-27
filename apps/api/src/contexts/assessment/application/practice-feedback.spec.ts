import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { KEY_BEARING_FIELDS } from '../../../fitness/content-rules.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { InMemoryAttempts, InMemoryResponses, StubCorpus, StubJudge, StubPins } from '../../../testing/assessment-fakes.js';
import { TAG, anAttempt, id } from '../../../testing/assessment-fixtures.js';
import type { AssemblyCandidate } from '../domain/assembly.js';
import { startAttempt } from '../domain/attempt.js';
import { applicationError, type ApplicationError } from './authorization.js';
import { GetAttemptHandler, IngestResponseEventsHandler, StartAttemptHandler, SubmitAttemptHandler } from './handlers/attempt-handlers.js';
import { CreatePracticeAttemptHandler } from './handlers/practice-handlers.js';
import { GetPracticeFeedbackHandler } from './handlers/practice-feedback-handler.js';
import type { ApplicationContext, AuditRecord, ResponseJudge } from './ports.js';

/**
 * M7-29 — immediate feedback, the first delivery path where a learner sees correctness while an attempt is open, and so a surface of the key-free
 * argument (`docs/KEY-FREE.md`, row `practice-feedback`). What is served is a verdict on the learner's own recorded answer; what is withheld is the key,
 * the correct option, the rule and the solution. ADR-0050 sets out the line.
 */
const NOW = new Date('2026-10-27T09:00:00.000Z');
const learner = (n = 1): ApplicationContext => ({ principal: { kind: 'human', id: id(TAG.student, n), roleContext: ['learner'] }, correlationId: 'corr' });
const cand = (n: number): AssemblyCandidate => ({
  itemId: id(TAG.item, n), itemVersionId: id(TAG.itemVersion, n), itemType: 'SINGLE_CORRECT_MCQ', difficultyBand: 'moderate',
  conceptIdentityIds: [id(0xc0, n)], stimulusVersionId: null, isPublished: true, isAnchor: false, anchorExposureCap: null,
});

/** Every name that is key material somewhere in the system; the scan looks for each as a JSON key. */
const KEY_FIELD_NAMES = [...new Set(['correctOptionId', 'correctOptionIds', 'isCorrect', 'answerKey', 'expectedValue', 'finalAnswerAssertion', 'responseSpec', 'pairs', 'solution', 'stem', 'marksAwarded', 'ruleApplied', ...KEY_BEARING_FIELDS])];
const keyFieldsIn = (body: unknown): string[] => KEY_FIELD_NAMES.filter((field) => JSON.stringify(body).includes(`"${field}"`));

function rig(judge: ResponseJudge = new StubJudge()) {
  const attempts = new InMemoryAttempts();
  const responses = new InMemoryResponses(attempts);
  let n = 0;
  const base = {
    attempts, responses, judge, practicePins: new StubPins(), pins: new StubPins(), intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    corpus: new StubCorpus({ candidates: [cand(1), cand(2), cand(3)], exposure: new Map(), nearDuplicates: new Map(), unevaluated: [] }),
    clock: { now: () => NOW }, identifiers: { next: () => id(0xd0, (n += 1)) }, audit: { record: async (_e: AuditRecord) => undefined },
  };
  return { ...base, deps: base as never };
}

async function startedRun(r: ReturnType<typeof rig>) {
  const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 3, idempotencyKey: 'k' }, learner()));
  const attemptId = created.attempt.attemptId;
  expectValue(await new StartAttemptHandler(r.deps).handle({ attemptId }, learner()));
  return { attemptId, slots: r.attempts.stored.get(attemptId)!.slots };
}
const answer = async (r: ReturnType<typeof rig>, attemptId: string, slotId: string, n: number, value: string) => {
  const event = { eventId: id(TAG.event, n), attemptId, slotId, sequence: n, kind: 'select' as const, answer: value, clientMonotonicMs: n * 10, deviceRef: 'd' };
  expectValue(await new IngestResponseEventsHandler(r.deps).handle({ attemptId, events: [event] }, learner()));
};

describe('immediate feedback', () => {
  it('serves a verdict and no key material on any feedback a practice run gives', async () => {
    const r = rig();
    const { attemptId, slots } = await startedRun(r);
    await answer(r, attemptId, slots[0]!.slotId, 1, 'right');
    await answer(r, attemptId, slots[1]!.slotId, 2, 'wrong');
    const handler = new GetPracticeFeedbackHandler(r.deps);
    const given = [
      expectValue(await handler.handle({ attemptId, slotId: slots[0]!.slotId }, learner())),
      expectValue(await handler.handle({ attemptId, slotId: slots[1]!.slotId }, learner())),
      expectValue(await handler.handle({ attemptId, slotId: slots[2]!.slotId }, learner())),
    ];
    expect(given.map((feedback) => feedback.outcome)).toEqual(['correct', 'incorrect', 'unattempted']);
    for (const feedback of given) {
      expect(Object.keys(feedback)).toEqual(['attemptId', 'slotId', 'outcome']);
      expect(keyFieldsIn(feedback)).toEqual([]);
    }
    // and what the run itself says while it is open: the attempt view carries no slot, version or key either
    expect(keyFieldsIn(expectValue(await new GetAttemptHandler(r.deps).handle({ attemptId }, learner())))).toEqual([]);
  });

  it('and that scan is not vacuous: it finds each key field in feedback that carries one', () => {
    expect(KEY_FIELD_NAMES.length).toBeGreaterThanOrEqual(12);
    for (const field of KEY_FIELD_NAMES) {
      expect(keyFieldsIn({ attemptId: 'a', slotId: 's', outcome: 'correct', [field]: 'B' }), field).toEqual([field]);
      expect(keyFieldsIn({ feedback: [{ nested: { [field]: 1 } }] }), `${field} nested`).toEqual([field]);
    }
    expect(keyFieldsIn({ attemptId: 'a', slotId: 's', outcome: 'incorrect' })).toEqual([]);
  });

  it('turns anything the judge says that is not a verdict into "indeterminate", so a judge that leaks cannot be served', async () => {
    const leaking: ResponseJudge = { judge: async () => ({ ok: true, value: '{"answerKey":{"optionId":"B"}}' }) };
    const r = rig(leaking);
    const { attemptId, slots } = await startedRun(r);
    await answer(r, attemptId, slots[0]!.slotId, 1, 'right');
    const feedback = expectValue(await new GetPracticeFeedbackHandler(r.deps).handle({ attemptId, slotId: slots[0]!.slotId }, learner()));
    expect(feedback.outcome).toBe('indeterminate');
    expect(keyFieldsIn(feedback)).toEqual([]);
  });

  it('judges the answer that stands — the last change — and asks nothing of marking for an unanswered slot', async () => {
    const judge = new StubJudge();
    const r = rig(judge);
    const { attemptId, slots } = await startedRun(r);
    await answer(r, attemptId, slots[0]!.slotId, 1, 'wrong');
    const change = { eventId: id(TAG.event, 2), attemptId, slotId: slots[0]!.slotId, sequence: 2, kind: 'change' as const, answer: 'right', clientMonotonicMs: 20, deviceRef: 'd' };
    expectValue(await new IngestResponseEventsHandler(r.deps).handle({ attemptId, events: [change] }, learner()));
    const handler = new GetPracticeFeedbackHandler(r.deps);
    expect(expectValue(await handler.handle({ attemptId, slotId: slots[0]!.slotId }, learner())).outcome).toBe('correct');
    expect(judge.asked.map((ask) => ask.answer)).toEqual(['right']);
    expect(expectValue(await handler.handle({ attemptId, slotId: slots[1]!.slotId }, learner())).outcome).toBe('unattempted');
    expect(judge.asked).toHaveLength(1);
  });

  it('is given for a run that pinned immediate feedback, and for nothing else: a mock gets none', async () => {
    const r = rig();
    const mock = expectValue(startAttempt(anAttempt({ studentId: id(TAG.student, 1) }), '2026-10-21T09:00:00.000Z'));
    r.attempts.stored.set(mock.attemptId, mock);
    const refused = await new GetPracticeFeedbackHandler(r.deps).handle({ attemptId: mock.attemptId, slotId: mock.slots[0]!.slotId }, learner());
    expect(expectError(refused).code).toBe('FEEDBACK_NOT_IMMEDIATE');
  });

  it('is the learner\'s own: someone else\'s run is not found, an operator is refused, an unstarted run and an unknown slot say so', async () => {
    const r = rig();
    const created = expectValue(await new CreatePracticeAttemptHandler(r.deps).handle({ examProfileVersionId: id(TAG.profile), selectionStrategy: 'filtered', scopeFilter: { subject: 'physics' }, count: 2, idempotencyKey: 'k' }, learner()));
    const attemptId = created.attempt.attemptId;
    const slotId = r.attempts.stored.get(attemptId)!.slots[0]!.slotId;
    const handler = new GetPracticeFeedbackHandler(r.deps);
    expect(expectError(await handler.handle({ attemptId, slotId }, learner())).code).toBe('ATTEMPT_NOT_STARTED');
    expect(expectError(await handler.handle({ attemptId, slotId }, learner(2))).kind).toBe('NotFound');
    const operator: ApplicationContext = { principal: { kind: 'human', id: id(TAG.student, 1), roleContext: ['content_ops'] }, correlationId: 'c' };
    expect(expectError(await handler.handle({ attemptId, slotId }, operator)).kind).toBe('Authorization');
    expectValue(await new StartAttemptHandler(r.deps).handle({ attemptId }, learner()));
    expect(expectError(await handler.handle({ attemptId, slotId: id(TAG.slot, 99) }, learner())).code).toBe('NOT_FOUND');
  });

  it('passes a failing judge\'s error on, as it is', async () => {
    const failing = new StubJudge();
    failing.failWith = applicationError('PreconditionFailed', 'FEEDBACK_UNAVAILABLE', 'no key') as ApplicationError;
    const r = rig(failing);
    const { attemptId, slots } = await startedRun(r);
    await answer(r, attemptId, slots[0]!.slotId, 1, 'right');
    expect(expectError(await new GetPracticeFeedbackHandler(r.deps).handle({ attemptId, slotId: slots[0]!.slotId }, learner())).code).toBe('FEEDBACK_UNAVAILABLE');
  });
});

describe('pause and resume, with no deadline', () => {
  it('leaves an untimed run exactly as it was however long it is put down, and takes responses and a submission on return', async () => {
    const r = rig();
    const { attemptId, slots } = await startedRun(r);
    await answer(r, attemptId, slots[0]!.slotId, 1, 'right');
    const asLater = (iso: string) => ({ ...(r.deps as object), clock: { now: () => new Date(iso) } }) as never;
    const later = asLater('2026-12-31T09:00:00.000Z');
    const view = expectValue(await new GetAttemptHandler(later).handle({ attemptId }, learner()));
    expect([view.state, view.deadline, view.windowClosesAt, view.durationMs]).toEqual(['in_progress', null, null, null]);
    expect(expectValue(await r.attempts.findExpired('2099-01-01T00:00:00.000Z', 10))).toEqual([]);
    expect(expectValue(await r.attempts.findAbandonable('2099-01-01T00:00:00.000Z', 10))).toEqual([]);
    const accepted = expectValue(await new IngestResponseEventsHandler(later).handle({ attemptId, events: [{ eventId: id(TAG.event, 5), attemptId, slotId: slots[1]!.slotId, sequence: 5, kind: 'select', answer: 'right', clientMonotonicMs: 50, deviceRef: 'd' }] }, learner()));
    expect(accepted.results[0]!.outcome).toBe('accepted');
    const submitted = expectValue(await new SubmitAttemptHandler(later).handle({ attemptId, reason: 'manual', idempotencyKey: 's' }, learner()));
    expect(submitted.state).toBe('submitted');
    expect(submitted.submission?.pastDeadline).toBe(false);
  });

  it('refuses an expiry submission, since there is no deadline for it to be true of', async () => {
    const r = rig();
    const { attemptId } = await startedRun(r);
    expect(expectError(await new SubmitAttemptHandler(r.deps).handle({ attemptId, reason: 'expiry', idempotencyKey: 's' }, learner())).code).toBe('SUBMISSION_EXPIRY_BEFORE_DEADLINE');
  });

  it('writes no AttemptSubmitted event for a practice submission: scoring marks forms (D77)', async () => {
    const r = rig();
    const { attemptId } = await startedRun(r);
    expectValue(await new SubmitAttemptHandler(r.deps).handle({ attemptId, reason: 'manual', idempotencyKey: 's' }, learner()));
    expect(r.attempts.events).toEqual([]);
  });
});

