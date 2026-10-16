import { describe, expect, it } from 'vitest';
import { isBlank, isRecord, isRecordArray } from './shape.js';

describe('shape guards', () => {
  it('a record is a non-null, non-array object', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    for (const other of [null, undefined, [], 'x', 3, true]) expect(isRecord(other)).toBe(false);
  });

  it('a record array is an array of records, and empty counts', () => {
    expect(isRecordArray([])).toBe(true);
    expect(isRecordArray([{}, { a: 1 }])).toBe(true);
    for (const other of [null, {}, [null], [1], [{}, []], 'x']) expect(isRecordArray(other)).toBe(false);
  });

  it('blank means not a string, or a string of nothing', () => {
    expect(isBlank('x')).toBe(false);
    for (const other of ['', '   ', undefined, null, 3, {}, []]) expect(isBlank(other)).toBe(true);
  });
});
