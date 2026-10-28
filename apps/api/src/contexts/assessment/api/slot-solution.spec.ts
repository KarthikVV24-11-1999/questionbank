import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS } from '../../../platform/config/config.js';
import { InMemoryAttempts, InMemoryForms, InMemoryResponses, InMemorySolutionReleases, StubPins, StubScoreRecords, StubSolutions } from '../../../testing/assessment-fakes.js';
import { SESSION_REF, TAG, anActiveForm, id } from '../../../testing/assessment-fixtures.js';
import { HandlerRegistry } from '../application/handler-registry.js';
import { CreateAttemptHandler, StartAttemptHandler } from '../application/handlers/attempt-handlers.js';
import { GetSlotSolutionHandler } from '../application/handlers/slot-solution-handler.js';
import { AssessmentController, type PrincipalResolver } from './assessment.controller.js';

/**
 * Solutions are served behind the effort gate, and only there (FRS 277, M7-37). The route is the real one over the real handler; the gate is the database's view, which these
 * specs stand in for with a release source the test opens by hand and `testing/assessment-solution-gate.integration.spec.ts` proves against the real view. What is scanned is
 * the body each call writes: the **text** a solution carries, which a field-name scan cannot find, because a solution is prose in a field called `body`.
 */
const STUDENT = id(TAG.student, 1);
const FORM = anActiveForm();
const PRINCIPAL = { kind: 'human' as const, id: STUDENT, roleContext: ['learner'] };
const OTHER = { kind: 'human' as const, id: id(TAG.student, 2), roleContext: ['learner'] };

/** Fragments of what the stub solution says. A leak of the solution is a leak of one of these, wherever it is nested. */
const SOLUTION_TEXTS = ['Square both sides', 'So the answer is 9', 'Doubling is not squaring', 'Try x = 3', 'By substitution'];
const textsIn = (body: unknown): string[] => SOLUTION_TEXTS.filter((text) => JSON.stringify(body).includes(text));

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

async function rig(principal: PrincipalResolver['resolve'] extends (...a: never[]) => infer R ? R : never = PRINCIPAL) {
  const attempts = new InMemoryAttempts();
  const forms = new InMemoryForms();
  forms.stored.set(FORM.formId, FORM);
  const releases = new InMemorySolutionReleases();
  const solutions = new StubSolutions();
  let n = 0;
  const deps = {
    forms,
    attempts,
    responses: new InMemoryResponses(attempts),
    pins: new StubPins(),
    intervalCapMs: DEFAULT_TIME_ON_ITEM_INTERVAL_CAP_MS,
    scoreRecord: new StubScoreRecords(),
    releases,
    solutions,
    clock: { now: () => new Date('2026-10-21T09:00:00.000Z') },
    identifiers: { next: () => id(TAG.attempt, (n += 1)) },
    audit: { record: async () => undefined },
  };
  const registry = HandlerRegistry.of([new CreateAttemptHandler(deps), new StartAttemptHandler(deps), new GetSlotSolutionHandler(deps)] as never);
  let current = principal;
  const principals: PrincipalResolver = { resolve: () => current };
  const controller = new AssessmentController(registry, principals);
  const call = async (go: (response: Response) => Promise<void>): Promise<Written> => {
    const { response, written } = fakeResponse();
    await go(response);
    return written;
  };
  const created = await call((r) => controller.createAttempt({ formId: FORM.formId, sessionRef: SESSION_REF }, { 'idempotency-key': 'k' }, r));
  const attemptId = (created.body as { attempt: { attemptId: string } }).attempt.attemptId;
  await call((r) => controller.startAttempt(attemptId, {}, r));
  return {
    attemptId,
    releases,
    solutions,
    as: (who: typeof principal) => void (current = who),
    solution: (slot: number, depth?: string, attempt = attemptId) => call((r) => controller.getSlotSolution(attempt, id(TAG.slot, slot), depth, {}, r)),
    controller,
  };
}

describe('what the solution route writes to a response', () => {
  it('serves no solution text while the gate is shut, on any slot of any attempt', async () => {
    const { solution, solutions, attemptId, as } = await rig();
    const bodies: Written[] = [];
    bodies.push(await solution(1)); // own attempt, nothing attempted
    bodies.push(await solution(2, 'full')); // the full depth is no different
    bodies.push(await solution(3, 'basic'));
    bodies.push(await solution(1, undefined, id(TAG.attempt, 999))); // an attempt that does not exist
    as(OTHER);
    bodies.push(await solution(1)); // someone else's attempt
    bodies.push(await solution(99)); // a slot the attempt does not have

    // every one answered with a body, and none a success: a scan of nothing proves nothing
    expect(bodies.map((b) => b.status)).toEqual([412, 412, 412, 404, 404, 404]);
    expect(bodies.every((b) => typeof b.body === 'object' && b.body !== null)).toBe(true);
    expect((bodies[0]!.body as { reason: string }).reason).toBe('SOLUTION_NOT_RELEASED');
    expect(JSON.stringify(bodies).length).toBeGreaterThan(500);
    expect(textsIn(bodies.map((b) => b.body))).toEqual([]);
    // and the refusal is reached before anything is fetched: the source was never asked
    expect(solutions.asked).toEqual([]);
    expect(attemptId).toBeTruthy();
  });

  it('serves the solution once the gate is open, and the same scan finds its text there', async () => {
    const { solution, solutions, releases, attemptId } = await rig();
    releases.open(attemptId, id(TAG.slot, 1), id(TAG.itemVersion, 1));

    const basic = await solution(1);
    const full = await solution(1, 'full');
    expect(basic.status).toBe(200);
    expect(full.status).toBe(200);
    // the scan sees it: the open responses carry the text the shut ones are shown not to
    expect(textsIn(basic.body)).toEqual(['Square both sides', 'So the answer is 9']);
    expect(textsIn(full.body)).toEqual(['Square both sides', 'So the answer is 9', 'Doubling is not squaring', 'Try x = 3', 'By substitution']);
    expect(solutions.asked).toEqual([
      { itemVersionId: id(TAG.itemVersion, 1), depth: 'basic' },
      { itemVersionId: id(TAG.itemVersion, 1), depth: 'full' },
    ]);

    // per slot: opening slot 1 opened nothing else
    const sibling = await solution(2);
    expect(sibling.status).toBe(412);
    expect(textsIn(sibling.body)).toEqual([]);
  });

  it('puts why the tempting answer is wrong before the method, and the other approaches after it', async () => {
    const { solution, releases, attemptId } = await rig();
    releases.open(attemptId, id(TAG.slot, 1), id(TAG.itemVersion, 1));
    const full = (await solution(1, 'full')).body as { depth: string; sections: { kind: string }[] };
    expect(full.depth).toBe('full');
    expect(full.sections.map((s) => s.kind)).toEqual(['why_wrong', 'method', 'alternate']);
    const basic = (await solution(1, 'basic')).body as { sections: { kind: string }[] };
    expect(basic.sections.map((s) => s.kind)).toEqual(['method']);
  });

  it('refuses a depth it does not know, as malformed, before any gate is asked', async () => {
    const { solution, solutions } = await rig();
    expect((await solution(1, 'everything')).status).toBe(400);
    expect(solutions.asked).toEqual([]);
  });
});
