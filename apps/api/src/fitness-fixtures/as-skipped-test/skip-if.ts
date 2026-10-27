import { describe, expect, it, test } from 'vitest';

/**
 * Planted for `test-locator.spec.ts` and `key-free-rules.spec.ts`: a test whose title a rule may name, in the form that stops it running (skipIf and runIf).
 * Never run: the file is not a spec.
 */
describe.skipIf(process.env['NEVER'] === undefined)('planted: a block that is conditional', () => {
  it('planted: in a conditional block', () => {
    expect(1).toBe(1);
  });
});
it.runIf(process.env['NEVER'] !== undefined)('planted: serves nothing it should not', () => {
  expect(1).toBe(1);
});
