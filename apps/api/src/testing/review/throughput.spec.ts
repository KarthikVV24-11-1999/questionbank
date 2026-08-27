import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { ok, type Result } from '../../contexts/content/domain/result.js';
import type {
  RepositoryError,
  ReviewDecisionRepository,
} from '../../contexts/content/domain/repository-ports.js';
import type { ReviewDecision } from '../../contexts/content/domain/review-decision.js';
import { GetReviewerThroughputHandler } from '../../contexts/content/application/review/queries/queue-queries.js';
import type { ApplicationContext } from '../../contexts/content/application/ports.js';
import { expectValue } from '../expect-result.js';

/**
 * **Tier 1 — the throughput instrument, proven against synthetic sessions
 * whose arithmetic answer is known in advance (M4-44, DEC-M4-5).**
 *
 * ## Instrument proven / no subject
 *
 * This is M0-25's formulation, used here in the same words and for the same
 * reason. `GetReviewerThroughput` (M4-33) computes items/hour from
 * `review_decision.decided_at`; this spec proves the arithmetic is right.
 * **It does not measure a reviewer.** There are no reviewers, so the
 * throughput target itself stays `Fail — blocked`; this proves only that the
 * instrument that would measure it is correct.
 *
 * ## What this file's numbers may and may not be used for
 *
 * **The three Tier-1 numbers are never summed, averaged, or presented under
 * the gate's name.** The instrument's arithmetic (here), the interaction
 * cost (`apps/studio/.../interaction-cost.spec.tsx`) and the machine time
 * (`machine-time.integration.spec.ts`) measure three different things in
 * three different units. Each is reported under its own name. Reporting them
 * together as evidence that "the workspace sustains 40 items/hour" is
 * exactly the claim DEC-M4-5 forbids — that gate's status is
 * **`Fail — blocked`**, no reviewer pool exists, and these figures are
 * evidence that the software does not itself prevent the rate, never a
 * measurement of it.
 */

const REVIEWERS = ['reviewer-a', 'reviewer-b', 'reviewer-c'] as const;

const CONTENT_OPS: PrincipalRef = { kind: 'human', id: 'ops-1', roleContext: ['content_ops'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });

const SESSION_START = '2026-08-26T09:00:00.000Z';
const MINUTE_MS = 60 * 1000;

function at(minutesIn: number): string {
  return new Date(Date.parse(SESSION_START) + minutesIn * MINUTE_MS).toISOString();
}

/** A decision by `reviewerId`, `minutesIn` minutes after the session started. */
function decision(reviewerId: string, minutesIn: number, ordinal: number): ReviewDecision {
  return {
    decisionId: `decision-${ordinal}`,
    ownerType: 'item_version',
    ownerVersionId: `version-${ordinal}`,
    reviewer: { kind: 'human', id: reviewerId, roleContext: ['reviewer'] },
    outcome: 'approved',
    decidedAt: at(minutesIn),
  } as unknown as ReviewDecision;
}

function repositoryOver(decisions: readonly ReviewDecision[]): ReviewDecisionRepository {
  return {
    async findWithinRange(): Promise<Result<readonly ReviewDecision[], RepositoryError>> {
      return ok(decisions);
    },
    async findByReviewer(
      reviewerId: string,
    ): Promise<Result<readonly ReviewDecision[], RepositoryError>> {
      return ok(decisions.filter((entry) => entry.reviewer.id === reviewerId));
    },
  } as unknown as ReviewDecisionRepository;
}

/** A one-hour window, so "per hour" and "count" are the same number and the arithmetic is checkable by eye. */
const ONE_HOUR = { from: SESSION_START, to: at(60) };

describe('Tier 1 — one reviewer, one hour, a known count', () => {
  it('reports 30 decisions in one hour as 30.00 per hour', async () => {
    const decisions = Array.from({ length: 30 }, (_unused, index) =>
      decision(REVIEWERS[0] as string, index * 2, index),
    );
    const handler = new GetReviewerThroughputHandler({ reviews: repositoryOver(decisions) });

    const result = expectValue(await handler.handle(ONE_HOUR, as(CONTENT_OPS)));

    expect(result.hours).toBe(1);
    expect(result.aggregate.decisionCount).toBe(30);
    expect(result.aggregate.decisionsPerHour).toBeCloseTo(30, 10);
    expect(result.perReviewer).toHaveLength(1);
    expect(result.perReviewer[0]?.decisionsPerHour).toBeCloseTo(30, 10);
  });

  it('halves the rate when the same count is spread over two hours', async () => {
    const decisions = Array.from({ length: 30 }, (_unused, index) =>
      decision(REVIEWERS[0] as string, index * 4, index),
    );
    const handler = new GetReviewerThroughputHandler({ reviews: repositoryOver(decisions) });

    const result = expectValue(await handler.handle({ from: SESSION_START, to: at(120) }, as(CONTENT_OPS)));

    expect(result.hours).toBe(2);
    expect(result.aggregate.decisionsPerHour).toBeCloseTo(15, 10);
  });
});

describe('Tier 1 — three reviewers, one hour', () => {
  /**
   * 12 + 18 + 6 = 36. The aggregate is the whole team's rate; each
   * reviewer's own line is their own. A handler that divided the aggregate
   * by the reviewer count, or that reported one reviewer's rate as the
   * team's, would fail here rather than silently reporting a plausible
   * number.
   */
  const COUNTS = { 'reviewer-a': 12, 'reviewer-b': 18, 'reviewer-c': 6 } as const;

  function threeReviewerSession(): readonly ReviewDecision[] {
    const decisions: ReviewDecision[] = [];
    let ordinal = 0;
    for (const reviewerId of REVIEWERS) {
      for (let n = 0; n < COUNTS[reviewerId]; n += 1) {
        decisions.push(decision(reviewerId, n, ordinal));
        ordinal += 1;
      }
    }
    return decisions;
  }

  it('aggregates to 36 per hour across the three', async () => {
    const handler = new GetReviewerThroughputHandler({ reviews: repositoryOver(threeReviewerSession()) });
    const result = expectValue(await handler.handle(ONE_HOUR, as(CONTENT_OPS)));

    expect(result.aggregate.decisionCount).toBe(36);
    expect(result.aggregate.decisionsPerHour).toBeCloseTo(36, 10);
  });

  it('gives each reviewer their own rate, not a share of the aggregate', async () => {
    const handler = new GetReviewerThroughputHandler({ reviews: repositoryOver(threeReviewerSession()) });
    const result = expectValue(await handler.handle(ONE_HOUR, as(CONTENT_OPS)));

    const byId = new Map(result.perReviewer.map((row) => [row.reviewerId, row]));
    expect(byId.get('reviewer-a')?.decisionsPerHour).toBeCloseTo(12, 10);
    expect(byId.get('reviewer-b')?.decisionsPerHour).toBeCloseTo(18, 10);
    expect(byId.get('reviewer-c')?.decisionsPerHour).toBeCloseTo(6, 10);

    // The per-reviewer rates sum to the aggregate — the arithmetic is
    // consistent, which is the only claim being made about it.
    const summed = result.perReviewer.reduce((total, row) => total + row.decisionsPerHour, 0);
    expect(summed).toBeCloseTo(result.aggregate.decisionsPerHour, 10);
  });
});

describe('Tier 1 — a session with a gap', () => {
  /**
   * **The gap is wall-clock, and the instrument is honest about that.** Ten
   * decisions in the first ten minutes, nothing for forty, ten more in the
   * last ten: 20 decisions over a one-hour window is 20/hour, *not* the
   * 60/hour the reviewer managed while actually working. The instrument
   * measures the window it was asked about — which is why it is an
   * instrument and not a productivity judgement.
   */
  it('reports the rate over the whole window, not over the active minutes', async () => {
    const decisions = [
      ...Array.from({ length: 10 }, (_unused, index) => decision(REVIEWERS[0] as string, index, index)),
      ...Array.from({ length: 10 }, (_unused, index) =>
        decision(REVIEWERS[0] as string, 50 + index, 10 + index),
      ),
    ];
    const handler = new GetReviewerThroughputHandler({ reviews: repositoryOver(decisions) });

    const result = expectValue(await handler.handle(ONE_HOUR, as(CONTENT_OPS)));

    expect(result.aggregate.decisionCount).toBe(20);
    expect(result.aggregate.decisionsPerHour).toBeCloseTo(20, 10);
    // Not 60 — the figure the same decisions would give over the 20 minutes
    // that actually contained them.
    expect(result.aggregate.decisionsPerHour).not.toBeCloseTo(60, 1);
  });

  it('reports an empty window as a zero rate rather than as no answer', async () => {
    const handler = new GetReviewerThroughputHandler({ reviews: repositoryOver([]) });
    const result = expectValue(await handler.handle(ONE_HOUR, as(CONTENT_OPS)));

    expect(result.aggregate.decisionCount).toBe(0);
    expect(result.aggregate.decisionsPerHour).toBe(0);
    expect(result.perReviewer).toEqual([]);
  });
});

/**
 * **Tier 3 — the criterion this instrument does NOT settle.**
 *
 * `≥ 40 items/hour sustained by a reviewer` is **`Fail — blocked`**: no
 * reviewer pool exists (DEC-M4-5). The repository-wide guard on that wording
 * — that the phrase may never appear without "Fail — blocked" beside it —
 * lives in `timing-criterion.spec.ts`, which scans the tree rather than any
 * one file.
 */
describe('Tier 3 — what this instrument reports, stated as a status', () => {
  it('reports a rate for synthetic input and has no reviewer to measure', async () => {
    const handler = new GetReviewerThroughputHandler({
      reviews: repositoryOver([decision(REVIEWERS[0] as string, 0, 0)]),
    });
    const result = expectValue(await handler.handle(ONE_HOUR, as(CONTENT_OPS)));

    // The instrument works: it turned one synthetic decision into a rate.
    expect(result.aggregate.decisionsPerHour).toBeCloseTo(1, 10);

    // And that is the whole claim. The decisions it was handed were built by
    // `decision()` twelve lines up, not recorded by a person — which is what
    // "no subject" means and why no number in this file is a throughput
    // result.
    expect(result.perReviewer[0]?.reviewerId).toBe('reviewer-a');
  });
});
