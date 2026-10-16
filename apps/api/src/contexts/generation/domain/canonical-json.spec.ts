import { describe, expect, it } from 'vitest';
import { canonicalJson } from './canonical-json.js';

describe('canonicalJson', () => {
  it('renders the same text for objects that differ only in key order, at every depth', () => {
    expect(canonicalJson({ b: 1, a: { y: [1, { d: 4, c: 3 }], x: null } })).toBe(canonicalJson({ a: { x: null, y: [1, { c: 3, d: 4 }] }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });

  it('keeps array order, because it is meaning', () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });

  it('renders primitives as JSON does', () => {
    expect(canonicalJson('x')).toBe('"x"');
    expect(canonicalJson(3)).toBe('3');
    expect(canonicalJson(null)).toBe('null');
    expect(canonicalJson(true)).toBe('true');
  });

  it('tells values that differ apart', () => {
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: '1' }));
    expect(canonicalJson({ a: 1 })).not.toBe(canonicalJson({ a: 1, b: undefined, c: 0 }));
  });
});
