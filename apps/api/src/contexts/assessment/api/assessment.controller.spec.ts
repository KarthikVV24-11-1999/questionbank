import { describe, expect, it } from 'vitest';
import type { Response } from 'express';
import { applicationError } from '../application/authorization.js';
import { HandlerRegistry } from '../application/handler-registry.js';
import { policy } from '../application/authorization.js';
import { AssessmentController, type PrincipalResolver } from './assessment.controller.js';
import { AssessmentModule } from './assessment.module.js';

/**
 * The controller's own behaviour, against a registry of stubs: what it does
 * when there is no principal, no handler, a body that does not parse, a handler
 * that refuses and one that succeeds. The routes end to end are the HTTP
 * integration spec's.
 */
const PRINCIPAL = { kind: 'human' as const, id: '00000000-0000-4000-8000-000000000001', roleContext: ['content_ops'] };
const FORM_ID = '00000000-0000-4000-8000-0000000000f1';

interface Captured {
  status?: number;
  type?: string;
  body?: unknown;
  headers: Record<string, string>;
}

function fakeResponse(): { response: Response; captured: Captured } {
  const captured: Captured = { headers: {} };
  const response = {
    setHeader(name: string, value: string) {
      captured.headers[name] = value;
    },
    status(code: number) {
      captured.status = code;
      return response;
    },
    type(value: string) {
      captured.type = value;
      return response;
    },
    json(body: unknown) {
      captured.body = body;
    },
  } as unknown as Response;
  return { response, captured };
}

function rig(handle: (input: unknown, context: unknown) => Promise<unknown>, principal: typeof PRINCIPAL | null = PRINCIPAL, names = ['GetForm', 'PublishForm', 'ScheduleForm', 'AssembleDraftForm']) {
  const calls: { input: unknown; context: unknown }[] = [];
  const registry = HandlerRegistry.of(
    names.map((name) => ({
      name,
      policy: policy(name, ['content_ops']),
      async handle(input: unknown, context: unknown) {
        calls.push({ input, context });
        return handle(input, context);
      },
    })) as never,
  );
  const principals: PrincipalResolver = { resolve: () => principal };
  return { controller: new AssessmentController(registry, principals), calls };
}

const ok = (value: unknown) => async () => ({ ok: true, value });

describe('the controller', () => {
  it('echoes the caller\'s correlation id, or makes one, on every response', async () => {
    const { controller } = rig(ok({}));
    const given = fakeResponse();
    await controller.getForm(FORM_ID, { 'x-correlation-id': 'mine' }, given.response);
    expect(given.captured.headers['X-Correlation-Id']).toBe('mine');
    const made = fakeResponse();
    await controller.getForm(FORM_ID, {}, made.response);
    expect(made.captured.headers['X-Correlation-Id']).toMatch(/^[0-9a-f-]{36}$/u);
  });

  it('answers 401 with no principal and never reaches the handler', async () => {
    const { controller, calls } = rig(ok({}), null);
    const { response, captured } = fakeResponse();
    await controller.getForm(FORM_ID, {}, response);
    expect(captured.status).toBe(401);
    expect(captured.type).toBe('application/problem+json');
    expect(calls).toEqual([]);
  });

  it('answers 400 with the offending paths when the input does not parse, and never reaches the handler', async () => {
    const { controller, calls } = rig(ok({}));
    const { response, captured } = fakeResponse();
    await controller.getForm('nope', {}, response);
    expect(captured.status).toBe(400);
    expect((captured.body as { detail: string }).detail).toContain('formId');
    const empty = fakeResponse();
    await controller.assembleDraftForm(undefined, {}, empty.response);
    expect((empty.captured.body as { detail: string }).detail).toContain('(body)');
    expect(calls).toEqual([]);
  });

  it('answers 503 when the registry holds no such handler', async () => {
    const { controller } = rig(ok({}), PRINCIPAL, ['PublishForm']);
    const { response, captured } = fakeResponse();
    await controller.getForm(FORM_ID, {}, response);
    expect(captured.status).toBe(503);
    expect((captured.body as { code: string }).code).toBe('Unavailable');
  });

  it('maps a handler\'s refusal onto its status', async () => {
    const { controller } = rig(async () => ({ ok: false, error: applicationError('NotFound', 'NOT_FOUND', 'no form') }));
    const { response, captured } = fakeResponse();
    await controller.getForm(FORM_ID, {}, response);
    expect(captured.status).toBe(404);
    expect((captured.body as { reason: string }).reason).toBe('NOT_FOUND');
  });

  it('answers the success status with the handler\'s value, passing the principal, the correlation id and step-up', async () => {
    const { controller, calls } = rig(ok({ done: true }));
    const { response, captured } = fakeResponse();
    await controller.publishForm(FORM_ID, { 'x-correlation-id': 'c1', 'x-step-up': 'satisfied' }, response);
    expect([captured.status, captured.body]).toEqual([200, { done: true }]);
    expect(calls[0]).toEqual({ input: { formId: FORM_ID }, context: { principal: PRINCIPAL, correlationId: 'c1', stepUpSatisfied: true } });
    const none = fakeResponse();
    await controller.publishForm(FORM_ID, {}, none.response);
    expect((calls[1]!.context as { stepUpSatisfied: boolean }).stepUpSatisfied).toBe(false);
  });

  it('takes the form id for a schedule from the path, whatever the body says, and refuses a body that is not an object', async () => {
    const { controller, calls } = rig(ok({}));
    const window = { opensAt: '2026-10-21T08:00:00.000Z', closesAt: '2026-10-21T12:00:00.000Z' };
    await controller.scheduleForm(FORM_ID, { ...window }, {}, fakeResponse().response);
    expect(calls[0]!.input).toEqual({ formId: FORM_ID, ...window });
    const overridden = fakeResponse();
    await controller.scheduleForm(FORM_ID, { ...window, formId: '00000000-0000-4000-8000-0000000000aa' }, {}, overridden.response);
    expect(calls).toHaveLength(2);
    expect((calls[1]!.input as { formId: string }).formId).toBe(FORM_ID);
    for (const body of [null, 'text', undefined]) {
      const refused = fakeResponse();
      await controller.scheduleForm(FORM_ID, body, {}, refused.response);
      expect(refused.captured.status).toBe(400);
    }
  });

  it('answers 201 for an assembly', async () => {
    const { controller } = rig(ok({ form: {} }));
    const { response, captured } = fakeResponse();
    const body = {
      blueprint: { examProfileVersionId: '00000000-0000-4000-8000-000000000001', formType: 'mock', totalMarks: 4, difficultyTolerance: 0, sections: [{ ordinal: 1, sectionSpecRef: 's', itemCount: 1, typeMix: { NUMERIC: 1 }, marksPerItem: 4, difficultyTarget: { advanced: 1 } }] },
      sessionRefs: ['a'],
    };
    await controller.assembleDraftForm(body, {}, response);
    expect(captured.status).toBe(201);
  });
});

describe('the module', () => {
  it('carries the controller and both providers', () => {
    const module = AssessmentModule.register({ registry: HandlerRegistry.of([]), principals: { resolve: () => null } });
    expect(module.controllers).toEqual([AssessmentController]);
    expect(module.providers).toHaveLength(2);
  });
});

describe('creating an attempt answers 201, and 200 when the key had already made it (M7-19)', () => {
  const body = { formId: FORM_ID, sessionRef: '2026-01-27/shift-1' };

  it('says 201 for an attempt this request made and 200 for one a retry of the same key finds', async () => {
    for (const [replayed, status] of [[false, 201], [true, 200]] as const) {
      const { controller } = rig(ok({ attempt: { attemptId: 'a' }, replayed }), PRINCIPAL, ['CreateAttempt']);
      const { response, captured } = fakeResponse();
      await controller.createAttempt(body, { 'idempotency-key': 'k' }, response);
      expect([replayed, captured.status]).toEqual([replayed, status]);
    }
  });
});

