import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { AI_AGENT, AUTHOR, REVIEWER } from '../../../../testing/content-fixtures.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { SELF_REVIEW_CALL_SITES, assertAssignable, isSelfReview, type SelfReviewableVersion } from './self-review.js';

const API_ROOT = fileURLToPath(new URL('../../../../../', import.meta.url));

const CONTENT_OPS: typeof REVIEWER = {
  ...REVIEWER,
  id: 'content-ops-1',
  roleContext: ['content_ops'],
};

function version(overrides: Partial<SelfReviewableVersion> = {}): SelfReviewableVersion {
  return { authoredBy: AUTHOR, ...overrides };
}

describe('isSelfReview', () => {
  it('is true when the principal is the version’s author', () => {
    expect(isSelfReview(version(), AUTHOR)).toBe(true);
  });

  it('is true when the principal is the version’s editor', () => {
    expect(isSelfReview(version({ editedBy: REVIEWER }), REVIEWER)).toBe(true);
  });

  it('is false for a reviewer unrelated to the version', () => {
    expect(isSelfReview(version(), REVIEWER)).toBe(false);
  });

  it('is false for an unrelated reviewer even when the version has an unrelated editor', () => {
    expect(isSelfReview(version({ editedBy: AI_AGENT }), REVIEWER)).toBe(false);
  });

  it('is true for Content Ops when Content Ops is the author — oversight is not independence', () => {
    expect(isSelfReview(version({ authoredBy: CONTENT_OPS }), CONTENT_OPS)).toBe(true);
  });

  it('is false for Content Ops reviewing someone else’s version — no blanket exemption either way', () => {
    expect(isSelfReview(version(), CONTENT_OPS)).toBe(false);
  });
});

describe('assertAssignable', () => {
  it('permits an unrelated reviewer', () => {
    expectValue(assertAssignable(version(), REVIEWER));
  });

  it('refuses the author, as RuleViolation SELF_REVIEW_PROHIBITED', () => {
    const error = expectError(assertAssignable(version(), AUTHOR));
    expect(error.code).toBe('SELF_REVIEW_PROHIBITED');
    expect(error.kind).toBe('RuleViolation');
  });

  it('refuses the editor', () => {
    const error = expectError(assertAssignable(version({ editedBy: REVIEWER }), REVIEWER));
    expect(error.code).toBe('SELF_REVIEW_PROHIBITED');
  });

  it('refuses Content Ops when Content Ops authored the version', () => {
    const error = expectError(assertAssignable(version({ authoredBy: CONTENT_OPS }), CONTENT_OPS));
    expect(error.code).toBe('SELF_REVIEW_PROHIBITED');
  });
});

describe('the three call sites (M4-04) — enumerated, red when one is removed', () => {
  it('names a module that exists and actually calls the shared function, for every listed call site', () => {
    for (const relativePath of SELF_REVIEW_CALL_SITES) {
      const path = `${API_ROOT}${relativePath}`;
      expect(existsSync(path), relativePath).toBe(true);
      const source = readFileSync(path, 'utf8');
      expect(
        /\b(?:isSelfReview|assertAssignable)\(/u.test(source),
        `${relativePath} does not call isSelfReview or assertAssignable`,
      ).toBe(true);
    }
  });

  it('is not yet three — M4-18 adds its entry when it lands', () => {
    // Documents the known-incomplete state rather than silently asserting
    // three today: the claim predicate is M4-18's, outside M4-01–M4-07's
    // scope. This test goes red the day someone claims three without
    // adding that entry.
    expect(SELF_REVIEW_CALL_SITES).toHaveLength(2);
  });
});
