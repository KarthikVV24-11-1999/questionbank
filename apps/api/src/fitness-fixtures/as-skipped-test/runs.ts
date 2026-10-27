import { describe, expect, it, test } from 'vitest';

/**
 * Planted for `test-locator.spec.ts` and `key-free-rules.spec.ts`: a test whose title a rule may name, in the form that stops it running (no skip at all (the control)).
 * Never run: the file is not a spec.
 */
describe('planted: a surface that carries no key', () => {
  it('planted: serves nothing it should not', () => {
    expect(1).toBe(1);
  });
  it.each([1, 2])('planted: runs for each case %s', (n) => {
    expect(n).toBeGreaterThan(0);
  });
});
