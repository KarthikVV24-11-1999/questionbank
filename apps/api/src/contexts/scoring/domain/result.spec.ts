import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from './result.js';

describe('Result', () => {
  it('constructs a success carrying its value', () => {
    expect(ok(4)).toEqual({ ok: true, value: 4 });
  });

  it('constructs a failure carrying its error', () => {
    expect(err('nope')).toEqual({ ok: false, error: 'nope' });
  });

  it('narrows to the value on the success branch', () => {
    const result: Result<number, string> = ok(42);
    expect(result.ok ? result.value : 'unreachable').toBe(42);
  });

  it('narrows to the error on the failure branch', () => {
    const result: Result<number, string> = err('boom');
    expect(result.ok ? 'unreachable' : result.error).toBe('boom');
  });

  it('carries a falsy value without confusing it for a failure', () => {
    const result: Result<number, string> = ok(0);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : null).toBe(0);
  });

  it('is structurally compatible with the curriculum Result crossing the barrel', () => {
    // The two contexts declare the shape independently (domain/ imports
    // nothing). A value produced under one declaration must satisfy the other,
    // or every barrel crossing needs a conversion.
    const fromCurriculum: { readonly ok: true; readonly value: number } = { ok: true, value: 7 };
    const asScoring: Result<number, string> = fromCurriculum;
    expect(asScoring.ok ? asScoring.value : null).toBe(7);
  });
});
