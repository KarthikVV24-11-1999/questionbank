import { describe, expect, it } from 'vitest';
import { ErrorCodeSchema, ItemTypeSchema, ProblemDetailsSchema } from './content-schemas.js';

/**
 * This package had no test script until M0-01. A generated file's real
 * contract test lives at `apps/api/src/contracts/content-contract.spec.ts`,
 * which regenerates it and diffs — this is a narrower smoke test that the
 * generated schemas parse the shapes the API actually emits, run from the
 * package that owns them.
 */
describe('generated content schemas parse real shapes', () => {
  it('accepts a well-formed ProblemDetails body', () => {
    const result = ProblemDetailsSchema.safeParse({
      type: 'about:blank',
      title: 'Validation failed',
      status: 400,
      code: 'Validation',
      retryable: false,
      correlationId: 'corr-1',
    });
    expect(result.success).toBe(true);
  });

  it('rejects an unlisted error code rather than coercing it', () => {
    const result = ErrorCodeSchema.safeParse('SomethingElse');
    expect(result.success).toBe(false);
  });

  it('the four item types round-trip', () => {
    for (const itemType of ['SINGLE_CORRECT_MCQ', 'MULTIPLE_CORRECT_MCQ', 'MATCHING', 'NUMERIC']) {
      expect(ItemTypeSchema.safeParse(itemType).success).toBe(true);
    }
  });
});
