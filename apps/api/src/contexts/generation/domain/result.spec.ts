import { describe, expect, it } from 'vitest';
import { err, ok, type Result } from './result.js';

describe('Result', () => {
  it('constructs a success carrying its value', () => {
    expect(ok(4)).toEqual({ ok: true, value: 4 });
  });

  it('constructs a failure carrying its error', () => {
    expect(err('nope')).toEqual({ ok: false, error: 'nope' });
  });

  it('carries a falsy value without confusing it for a failure', () => {
    const result: Result<number, string> = ok(0);
    expect(result.ok).toBe(true);
    expect(result.ok ? result.value : null).toBe(0);
  });

  it('is structurally compatible with the other contexts’ Result', () => {
    // Declared independently in each domain (which imports nothing); a value
    // produced under one declaration must satisfy the other or every barrel
    // crossing needs a conversion.
    const foreign: { readonly ok: false; readonly error: string } = { ok: false, error: 'x' };
    const asGeneration: Result<number, string> = foreign;
    expect(asGeneration.ok ? null : asGeneration.error).toBe('x');
  });
});
