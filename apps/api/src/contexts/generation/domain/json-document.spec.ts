import { describe, expect, it } from 'vitest';
import { freezeJson, isJsonObject } from './json-document.js';

describe('isJsonObject', () => {
  it('is true for a plain object only', () => {
    expect(isJsonObject({})).toBe(true);
    expect(isJsonObject({ a: 1 })).toBe(true);
    for (const other of [null, undefined, [], 'text', 3, true]) expect(isJsonObject(other)).toBe(false);
  });
});

describe('freezeJson', () => {
  it('freezes every level of a copy and leaves the original alone', () => {
    const original = { list: [{ inner: 1 }], nested: { deep: { value: 'v' } }, plain: 'p' };
    const copy = freezeJson(original) as typeof original;
    expect(copy).toEqual(original);
    expect(copy).not.toBe(original);
    expect(Object.isFrozen(copy)).toBe(true);
    expect(Object.isFrozen(copy.list)).toBe(true);
    expect(Object.isFrozen(copy.list[0])).toBe(true);
    expect(Object.isFrozen(copy.nested.deep)).toBe(true);
    expect(Object.isFrozen(original)).toBe(false);
  });

  it('returns a primitive as it is', () => {
    expect(freezeJson('text')).toBe('text');
    expect(freezeJson(3)).toBe(3);
    expect(freezeJson(null)).toBe(null);
  });
});
