import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { createModelPin, MODEL_PIN_FIELDS, type ModelPinProps } from './model-pin.js';

const PIN: ModelPinProps = { modelVersionId: 'model-v3', promptVersionId: 'prompt-v7', runId: 'run-42' };

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
    expect(pin.modelVersionId).toBe('model-v3');
    expect(pin.promptVersionId).toBe('prompt-v7');
    expect(pin.runId).toBe('run-42');
  });

  it('keeps the three members distinct — none is read from another', () => {
    const pin = expectValue(createModelPin({ modelVersionId: 'a', promptVersionId: 'b', runId: 'c' }));
    expect([pin.modelVersionId, pin.promptVersionId, pin.runId]).toEqual(['a', 'b', 'c']);
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
