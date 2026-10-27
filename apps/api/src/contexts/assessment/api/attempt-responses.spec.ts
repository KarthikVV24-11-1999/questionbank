import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { KEY_BEARING_FIELDS } from '../../../fitness/content-rules.js';
import { InMemoryAttempts, InMemoryForms, InMemoryResponses, StubPins, StubScoreRecords } from '../../../testing/assessment-fakes.js';
import { SESSION_REF, TAG, anActiveForm, id } from '../../../testing/assessment-fixtures.js';
import { HandlerRegistry } from '../application/handler-registry.js';
import {
  CreateAttemptHandler,
  GetAttemptHandler,
  GetAttemptResultHandler,
  IngestResponseEventsHandler,
  StartAttemptHandler,
  SubmitAttemptHandler,
} from '../application/handlers/attempt-handlers.js';
import { AssessmentController, type PrincipalResolver } from './assessment.controller.js';

/**
 * The key-free argument for the attempt responses (M6-59, F6/F35), proved where it does not depend on the composed application's attempt lifecycle (M7-18).
 *
 * The first version of these two tests sat in `assessment-attempts.integration.spec.ts`, which D73 skips, and the gate that names them could not tell: it
 * checked that the titles were in the file. They are here, run, and the controller is the real one: what is scanned is the body each route writes to its
 * response — create, start, read, events, submission and result — from the real handlers over in-memory stores, with a response for every state an attempt
 * passes through and a score record that carries a solution, so that a leak from any of them would be in the bytes.
 */
const STUDENT = id(TAG.student, 1);
const FORM = anActiveForm();
const PRINCIPAL = { kind: 'human' as const, id: STUDENT, roleContext: ['learner'] };

/** Every name that is key material somewhere in the system; the scan looks for each as a JSON key. */
const KEY_FIELD_NAMES = [...new Set(['correctOptionId', 'correctOptionIds', 'isCorrect', 'answerKey', 'expectedValue', 'finalAnswerAssertion', 'responseSpec', 'pairs', 'solution', 'stem', ...KEY_BEARING_FIELDS])];
const keyFieldsIn = (body: unknown): string[] => KEY_FIELD_NAMES.filter((field) => JSON.stringify(body).includes(`"${field}"`));

interface Written {
  status: number | undefined;
  body: unknown;
}

function fakeResponse(): { response: Response; written: Written } {
  const written: Written = { status: undefined, body: undefined };
  const response = {
    setHeader() {},
    status(code: number) {
      written.status = code;
      return response;
    },
    type() {
      return response;
    },
    json(body: unknown) {
      written.body = body;
    },
  } as unknown as Response;
  return { response, written };
}

function rig() {
  const attempts = new InMemoryAttempts();
  const forms = new InMemoryForms();
  forms.stored.set(FORM.formId, FORM);
  const scoreRecord = new StubScoreRecords();
  let n = 0;
  const deps = {
    forms,
    attempts,
    responses: new InMemoryResponses(attempts),
    pins: new StubPins(),
    intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    scoreRecord,
    clock: { now: () => new Date('2026-10-21T09:00:00.000Z') },
    identifiers: { next: () => id(TAG.attempt, (n += 1)) },
    audit: { record: async () => undefined },
  };
  const registry = HandlerRegistry.of([
    new CreateAttemptHandler(deps),
    new StartAttemptHandler(deps),
    new GetAttemptHandler(deps),
    new IngestResponseEventsHandler(deps),
    new SubmitAttemptHandler(deps),
    new GetAttemptResultHandler(deps),
  ] as never);
  const principals: PrincipalResolver = { resolve: () => PRINCIPAL };
  return { controller: new AssessmentController(registry, principals), scoreRecord };
}

describe('what the attempt routes write to a response', () => {
  it('serves no key material on any attempt response', async () => {
    const { controller, scoreRecord } = rig();
    const bodies: Written[] = [];
    const call = async (go: (response: Response) => Promise<void>) => {
      const { response, written } = fakeResponse();
      await go(response);
      bodies.push(written);
      return written;
    };

    const created = await call((r) => controller.createAttempt({ formId: FORM.formId, sessionRef: SESSION_REF }, { 'idempotency-key': 'k' }, r));
    const attemptId = (created.body as { attempt: { attemptId: string } }).attempt.attemptId;
    await call((r) => controller.getAttempt(attemptId, {}, r)); // read while created
    await call((r) => controller.startAttempt(attemptId, {}, r));
    await call((r) => controller.getAttempt(attemptId, {}, r)); // read while in progress
    const events = [
      { eventId: id(TAG.event, 1), slot: id(TAG.slot, 1), sequence: 1, kind: 'visit', monotonicMs: 10 },
      { eventId: id(TAG.event, 2), slot: id(TAG.slot, 1), sequence: 2, kind: 'select', answer: 'B', monotonicMs: 20 },
      { eventId: id(TAG.event, 3), slot: id(TAG.slot, 1), sequence: 3, kind: 'leave', monotonicMs: 30 },
    ];
    await call((r) => controller.ingestEvents(attemptId, { deviceRef: 'phone', events }, {}, r));
    await call((r) => controller.ingestEvents(attemptId, { deviceRef: 'phone', events }, {}, r)); // a replay is a response too
    await call((r) => controller.submitAttempt(attemptId, { reason: 'manual' }, { 'idempotency-key': 'sub' }, r));
    await call((r) => controller.getAttempt(attemptId, {}, r)); // read once submitted
    await call((r) => controller.getAttemptResult(attemptId, {}, r)); // pending
    // and once scored, with a score record that carries what a score record may: a solution reference among it would be in the bytes
    scoreRecord.records.set(attemptId, { scoreRecordId: id(TAG.attempt, 90), totalRaw: '4', itemOutcomes: [{ slotId: id(TAG.slot, 1), correctness: 'correct' }] });
    const result = await call((r) => controller.getAttemptResult(attemptId, {}, r));

    // every one answered, and with a body: a scan of nothing proves nothing
    expect(bodies.map((b) => b.status)).toEqual([201, 200, 200, 200, 200, 200, 200, 200, 200, 200]);
    expect(bodies.every((b) => typeof b.body === 'object' && b.body !== null)).toBe(true);
    expect((result.body as { status: string }).status).toBe('scored');
    expect(JSON.stringify(bodies).length).toBeGreaterThan(1_000);

    expect(keyFieldsIn(bodies.map((b) => b.body))).toEqual([]);
  });

  it('and that scan is not vacuous: it finds each key field in a response that carries one', () => {
    // the set, not the loop: the scan covers every name the system treats as key material
    expect(KEY_FIELD_NAMES.length).toBeGreaterThanOrEqual(10);
    for (const field of KEY_FIELD_NAMES) {
      expect(keyFieldsIn([{ attempt: { [field]: 'x' } }]), field).toEqual([field]);
      expect(keyFieldsIn({ results: [{ nested: { deeper: [{ [field]: 1 }] } }] }), `${field} nested`).toEqual([field]);
    }
    expect(keyFieldsIn({ attempt: { attemptId: 'a', state: 'created', deadline: null } })).toEqual([]);
  });

  it('finds a key in the bytes the real controller writes, so the harness sees what a route leaks and not only the function does', async () => {
    const leaking = {
      name: 'GetAttempt',
      policy: { name: 'GetAttempt', allowedRoles: ['learner'], requiresStepUp: false },
      handle: async () => ({ ok: true, value: { attemptId: id(TAG.attempt), state: 'in_progress', answerKey: { kind: 'SINGLE_CORRECT', optionId: 'B' } } }),
    };
    const controller = new AssessmentController(HandlerRegistry.of([leaking] as never), { resolve: () => PRINCIPAL });
    const { response, written } = fakeResponse();
    await controller.getAttempt(id(TAG.attempt), {}, response);
    expect(keyFieldsIn(written.body)).toEqual(['answerKey']);
  });
});
