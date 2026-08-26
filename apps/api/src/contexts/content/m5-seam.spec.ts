import { describe, expect, it } from 'vitest';
import * as content from './public/index.js';

/**
 * The M4 → M5 seam (M4-35), written against `content/public/` **and nothing
 * else** — the same instrument the M2→M3 and M3→M4 seams already are,
 * pointed at the next milestone.
 *
 * M5's AI pre-check needs exactly three things from Content: a way to
 * **enqueue a generated candidate for review** (`SubmitItemForReview` — the
 * same command a human author's draft already goes through; M5 is not a
 * fourth context with its own queue, DEC-M4-7), a way to **read decision
 * outcomes** so it can compute first-pass acceptance (`ReviewOutcome`,
 * `REVIEW_OUTCOMES`), and the **rejection taxonomy** so a returned candidate
 * classifies by a stable code rather than by matching message text
 * (`RejectionReasonCode`, `REJECTION_REASONS`).
 *
 * A missing export here is a compile failure in this file, not something M5
 * discovers by reaching past the barrel into `content/domain` or
 * `content/application`.
 */

describe('M5 can enqueue a generated candidate for review', () => {
  it('submits it through the same command a human author’s draft uses — no second queue', () => {
    const submit: content.SubmitItemForReview = { itemId: 'generated-item-1' };
    expect(submit.itemId).toBe('generated-item-1');
  });
});

describe('M5 can read decision outcomes to compute first-pass acceptance', () => {
  it('reads the closed outcome vocabulary and branches on it, not on message text', () => {
    const outcomes: readonly content.ReviewOutcome[] = content.REVIEW_OUTCOMES;
    expect([...outcomes]).toEqual(['approve', 'approve_with_edits', 'request_changes', 'reject']);
  });

  it('computes a first-pass-acceptance rate from a set of outcomes alone', () => {
    const decided: readonly content.ReviewOutcome[] = ['approve', 'reject', 'approve_with_edits', 'approve'];
    const firstPassAccepted = decided.filter((outcome) => outcome === 'approve').length;
    expect(firstPassAccepted / decided.length).toBe(0.5);
  });
});

describe('M5 can read the rejection taxonomy to classify a failure', () => {
  it('reads every reason code the taxonomy declares', () => {
    const codes: readonly content.RejectionReasonCode[] = content.REJECTION_REASONS.map((reason) => reason.code);
    expect(codes).toContain(content.DUPLICATE_REASON_CODE);
    expect(codes.length).toBeGreaterThan(1);
  });

  it('classifies by the stable code, never by the reason’s prose', () => {
    const found = content.REJECTION_REASONS.find((reason) => reason.code === content.DUPLICATE_REASON_CODE);
    expect(found).toBeDefined();
    expect(typeof found?.code).toBe('string');
  });
});

describe('the barrel exposes no aggregate, repository, handler or infrastructure type to M5 either', () => {
  it('exports no aggregate constructor, no handler and no repository', () => {
    const forbidden = [
      'createItem',
      'transitionItem',
      'PostgresItemRepository',
      'SubmitItemForReviewHandler',
      'ClaimNextForReviewHandler',
      'RefreshFingerprintsHandler',
      'contentSchema',
    ];
    for (const name of forbidden) {
      expect(Object.keys(content), name).not.toContain(name);
    }
  });
});
