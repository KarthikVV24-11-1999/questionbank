import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { createGenerationRun, type CreateGenerationRunProps } from './generation-run.js';

const PROPS: CreateGenerationRunProps = {
  pin: { modelVersionId: 'model-v3', promptVersionId: 'prompt-v7', runId: 'run-42' },
  requestedAt: '2026-10-16T09:30:00.000Z',
  request: { band: 'medium', count: 5, nested: { topic: 'kinematics' } },
};

describe('createGenerationRun', () => {
  it('records the pin, the time and the request, field by field', () => {
    const run = expectValue(createGenerationRun(PROPS));
    expect(run.pin.modelVersionId).toBe('model-v3');
    expect(run.pin.promptVersionId).toBe('prompt-v7');
    expect(run.pin.runId).toBe('run-42');
    expect(run.requestedAt).toBe('2026-10-16T09:30:00.000Z');
    expect(run.request['band']).toBe('medium');
    expect(run.request['count']).toBe(5);
    expect((run.request['nested'] as { topic: string }).topic).toBe('kinematics');
  });

  it('is unconstructible without a complete pin, naming the missing member', () => {
    for (const field of ['modelVersionId', 'promptVersionId', 'runId'] as const) {
      const failure = expectError(createGenerationRun({ ...PROPS, pin: { ...PROPS.pin, [field]: ' ' } }));
      expect(failure.kind).toBe('Validation');
      expect(failure.location).toBe(field);
    }
  });

  it('accepts the millisecond form and refuses anything that would not survive storage unchanged', () => {
    expectValue(createGenerationRun({ ...PROPS, requestedAt: '2026-10-16T09:30:00.125Z' }));
    for (const requestedAt of [
      '',
      '2026-10-16',
      '2026-10-16T09:30:00Z',
      '2026-10-16T09:30:00.1Z',
      '2026-10-16T09:30:00.123456Z',
      '2026-10-16T09:30:00.000+05:30',
      'yesterday',
    ]) {
      const failure = expectError(createGenerationRun({ ...PROPS, requestedAt }));
      expect(failure.code).toBe('RUN_REQUESTED_AT_INVALID');
      expect(failure.location).toBe('requestedAt');
    }
    expect(expectError(createGenerationRun({ ...PROPS, requestedAt: 5 as never })).code).toBe(
      'RUN_REQUESTED_AT_INVALID',
    );
  });

  it('refuses a request that is not a JSON object', () => {
    for (const request of [null, [], 'text', 3]) {
      expect(expectError(createGenerationRun({ ...PROPS, request: request as never })).code).toBe(
        'RUN_REQUEST_INVALID',
      );
    }
  });

  it('freezes the run and holds a copy of the request', () => {
    const request: Record<string, unknown> = { count: 5 };
    const run = expectValue(createGenerationRun({ ...PROPS, request }));
    request['count'] = 99;
    expect(run.request['count']).toBe(5);
    expect(Object.isFrozen(run)).toBe(true);
    expect(Object.isFrozen(run.pin)).toBe(true);
    expect(Object.isFrozen(run.request)).toBe(true);
  });
});
