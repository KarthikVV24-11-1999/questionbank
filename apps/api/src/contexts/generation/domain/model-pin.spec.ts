import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { createModelPin, MODEL_PIN_FIELDS, type ModelPinProps } from './model-pin.js';

const A = '00000000-0000-4000-8000-000000000a01';
const B = '00000000-0000-4000-8000-000000000b01';
const C = '00000000-0000-4000-8000-000000000c01';
const PIN: ModelPinProps = { modelVersionId: '00000000-0000-4000-8000-0000000a0003', promptVersionId: '00000000-0000-4000-8000-0000000b0007', runId: '00000000-0000-4000-8000-0000000c0042' };

describe('the pin is exactly three members', () => {
  it('names them, in order', () => {
    expect([...MODEL_PIN_FIELDS]).toEqual(['modelVersionId', 'promptVersionId', 'runId']);
  });

  it('constructs a pin with exactly those keys and no others', () => {
    expect(Object.keys(expectValue(createModelPin(PIN))).sort()).toEqual([...MODEL_PIN_FIELDS].sort());
  });
});

describe('round trip, field by field', () => {
  // Not `toEqual(PIN)`: an equality over two objects that were both missing the
  // same member would pass (ADR-0017). Each member is read by name from the
  // result and compared with the distinct value it was given.
  it('returns each member exactly as supplied', () => {
    const pin = expectValue(createModelPin(PIN));
    expect(pin.modelVersionId).toBe('00000000-0000-4000-8000-0000000a0003');
    expect(pin.promptVersionId).toBe('00000000-0000-4000-8000-0000000b0007');
    expect(pin.runId).toBe('00000000-0000-4000-8000-0000000c0042');
  });

  it('keeps the three members distinct — none is read from another', () => {
    const pin = expectValue(createModelPin({ modelVersionId: A, promptVersionId: B, runId: C }));
    expect([pin.modelVersionId, pin.promptVersionId, pin.runId]).toEqual([A, B, C]);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(expectValue(createModelPin(PIN)))).toBe(true);
  });

  it('copies rather than aliasing the input', () => {
    expect(expectValue(createModelPin(PIN))).not.toBe(PIN);
  });
});

describe('a missing or blank member is refused, with the field named', () => {
  const codes = {
    modelVersionId: 'MODEL_VERSION_ID_REQUIRED',
    promptVersionId: 'PROMPT_VERSION_ID_REQUIRED',
    runId: 'RUN_ID_REQUIRED',
  } as const;

  for (const field of MODEL_PIN_FIELDS) {
    for (const [label, bad] of [
      ['empty', ''],
      ['whitespace-only', '   '],
      ['absent', undefined],
      ['not a string', 7],
    ] as const) {
      it(`refuses ${label} ${field}`, () => {
        const failure = expectError(createModelPin({ ...PIN, [field]: bad } as unknown as ModelPinProps));
        expect(failure.kind).toBe('Validation');
        expect(failure.code).toBe(codes[field]);
        expect(failure.location).toBe(field);
        expect(failure.message).toContain(field);
      });
    }
  }

  it('covers every member of the pin, so a fourth cannot be added unchecked', () => {
    expect(Object.keys(codes).sort()).toEqual([...MODEL_PIN_FIELDS].sort());
  });
});

describe('every member is a reference, never a label', () => {
  const CODE = {
    modelVersionId: 'MODEL_VERSION_ID_NOT_A_UUID',
    promptVersionId: 'PROMPT_VERSION_ID_NOT_A_UUID',
    runId: 'RUN_ID_NOT_A_UUID',
  } as const;

  for (const field of ['modelVersionId', 'promptVersionId', 'runId'] as const) {
    it(`refuses a ${field} that is not a UUID, naming it`, () => {
      for (const label of ['model-v3', 'run-42', '1234', `${PIN[field]}x`, ` ${PIN[field]}`]) {
        const failure = expectError(createModelPin({ ...PIN, [field]: label }));
        expect(failure.kind, label).toBe('Validation');
        expect(failure.code, label).toBe(CODE[field]);
        expect(failure.location, label).toBe(field);
        expect(failure.message).toContain(label);
      }
    });
  }

  it('reports a blank as missing, before it reports a malformed one', () => {
    expect(expectError(createModelPin({ ...PIN, runId: '' })).code).toBe('RUN_ID_REQUIRED');
    expect(expectError(createModelPin({ ...PIN, runId: 'x' })).code).toBe('RUN_ID_NOT_A_UUID');
  });
});
