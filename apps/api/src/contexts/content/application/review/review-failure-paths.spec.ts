import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { validationError } from '../../domain/content-error.js';
import { createItem, type Item } from '../../domain/item.js';
import type { ReviewDecision } from '../../domain/review-decision.js';
import type { ReviewAssignment } from '../../domain/review/review-assignment.js';
import { createItemVersion } from '../../domain/item-version.js';
import { createReviewPolicy } from '../../domain/review/review-policy.js';
import { err, ok, type Result } from '../../domain/result.js';
import type {
  FingerprintRepository,
  ItemFingerprintRecord,
  ItemRepository,
  RepositoryError,
  ReviewAssignmentRepository,
  ReviewDecisionRepository,
  ReviewEscalationRepository,
  SubmittedForReviewPage,
} from '../../domain/repository-ports.js';
import { PROVENANCE_CONTEXT, itemVersionProps } from '../../../../testing/content-fixtures.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import type { ApplicationContext } from '../../application/ports.js';
import { GetDuplicateCandidatesHandler } from './queries/duplicate-queries.js';
import { GetQueueHealthHandler, GetReviewerThroughputHandler } from './queries/queue-queries.js';
import { RefreshFingerprintsHandler } from './handlers/fingerprint-handlers.js';
import { ClaimNextForReviewHandler } from './handlers/assignment-handlers.js';

/**
 * **The review area's repository-failure branches (M4-42).**
 *
 * Every review handler translates a repository failure into an
 * `ApplicationError` and returns it, rather than throwing or reporting a
 * partial result as success. Those branches are the ones ADR-0008's 100%
 * threshold is really about — a silently swallowed persistence error in the
 * queue-health report is a Content Ops screen that shows a shorter queue than
 * exists, and a swallowed failure in `RefreshFingerprints` is duplicate
 * detection quietly going blind.
 *
 * **They need unit tests with failing stubs, and that is why they were
 * uncovered.** The integration specs beside these modules run against a real
 * Postgres, which cannot be asked to fail on demand for one call and succeed
 * for the next — so the error arms of `if (!page.ok)`, `if (!saved.ok)` and
 * `if (!notified.ok)` had no reachable test. Found by M4-42 running the
 * coverage gate rather than by reading the modules.
 */

/** `FingerprintRepository.findSimilarCandidates`'s element type, which the port declares inline rather than exporting. */
type TrigramMatch = { readonly fingerprint: ItemFingerprintRecord; readonly similarity: number };

const CONTENT_OPS: PrincipalRef = { kind: 'human', id: 'ops-1', roleContext: ['content_ops'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });

const REJECTED: RepositoryError = validationError('PERSISTENCE_REJECTED', 'the pool is gone', 'item');
const NOW = '2026-08-26T12:00:00.000Z';

const REVIEW_POLICY = (() => {
  const built = createReviewPolicy({
    warnAfterHours: 24,
    escalateAfterHours: 48,
    leaseHours: 4,
    sampleRate: 0.1,
  });
  if (!built.ok) throw new Error('fixture review policy is invalid');
  return built.value;
})();

/** One item, submitted for review and old enough to be escalated, so the overdue path is actually entered. */
function submittedItem(): Item {
  const version = createItemVersion(itemVersionProps(), PROVENANCE_CONTEXT);
  if (!version.ok) throw new Error('fixture version is invalid');
  const created = createItem({
    itemId: 'item-1',
    itemType: 'SINGLE_CORRECT_MCQ',
    initialVersion: version.value,
    authoringSubject: 'physics',
    stateEnteredAt: '2026-08-20T00:00:00.000Z',
  });
  if (!created.ok) throw new Error(`fixture item is invalid: ${created.error.code}`);
  return {
    ...created.value,
    lifecycleState: 'in_review',
    stateEnteredAt: '2026-08-20T00:00:00.000Z',
  } as Item;
}

/**
 * Pages the way the real repository does: the caller supplies one result per
 * call, and the handler under test keeps asking until a page arrives with no
 * `nextCursor`. A single-page stub leaves `cursor = page.value.nextCursor`
 * unexecuted, which is how a handler that silently reported only the first
 * page of the queue would still have looked fully covered.
 */
class ItemsReturning implements ItemRepository {
  #call = 0;
  /** One entry per expected call; the last is reused if the handler asks again. */
  constructor(private readonly pages: readonly Result<SubmittedForReviewPage, RepositoryError>[]) {}

  get calls(): number {
    return this.#call;
  }
  async save(): Promise<Result<Item, RepositoryError>> {
    return err(REJECTED);
  }
  async findById(): Promise<Result<Item, RepositoryError>> {
    return err(REJECTED);
  }
  async deleteDraft(): Promise<Result<true, RepositoryError>> {
    return err(REJECTED);
  }
  async findDraftsByAuthor(): Promise<Result<readonly Item[], RepositoryError>> {
    return ok([]);
  }
  async findPublishedVersion(): Promise<Result<never, RepositoryError>> {
    return err(REJECTED);
  }
  async countPublishedItemsUsingStimulusVersion(): Promise<Result<number, RepositoryError>> {
    return ok(0);
  }
  async findSubmittedForReview(): Promise<Result<SubmittedForReviewPage, RepositoryError>> {
    const page = this.pages[Math.min(this.#call, this.pages.length - 1)];
    this.#call += 1;
    if (page === undefined) throw new Error('the stub was asked for a page it was never given');
    return page;
  }
}

/** A first page that promises a second, so the paging branch is actually taken. */
function pageWithMore(items: readonly Item[]): Result<SubmittedForReviewPage, RepositoryError> {
  return ok({ items, nextCursor: 'cursor-2' });
}

function lastPage(items: readonly Item[]): Result<SubmittedForReviewPage, RepositoryError> {
  return ok({ items });
}

class FingerprintsReturning implements FingerprintRepository {
  constructor(
    private readonly overrides: Partial<{
      save: () => Result<true, RepositoryError>;
      findByItemVersionId: () => Result<ItemFingerprintRecord | undefined, RepositoryError>;
      findByExactHash: () => Result<readonly ItemFingerprintRecord[], RepositoryError>;
      findBySkeletonHash: () => Result<readonly ItemFingerprintRecord[], RepositoryError>;
      findSimilarCandidates: () => Result<readonly TrigramMatch[], RepositoryError>;
    }> = {},
  ) {}
  async save(): Promise<Result<true, RepositoryError>> {
    return this.overrides.save?.() ?? ok(true);
  }
  async findByItemVersionId(): Promise<Result<ItemFingerprintRecord | undefined, RepositoryError>> {
    return this.overrides.findByItemVersionId?.() ?? ok(FINGERPRINT);
  }
  async findByExactHash(): Promise<Result<readonly ItemFingerprintRecord[], RepositoryError>> {
    return this.overrides.findByExactHash?.() ?? ok([]);
  }
  async findBySkeletonHash(): Promise<Result<readonly ItemFingerprintRecord[], RepositoryError>> {
    return this.overrides.findBySkeletonHash?.() ?? ok([]);
  }
  async findSimilarCandidates(): Promise<Result<readonly TrigramMatch[], RepositoryError>> {
    return this.overrides.findSimilarCandidates?.() ?? ok([]);
  }
}

const FINGERPRINT: ItemFingerprintRecord = {
  itemId: 'item-1',
  itemVersionId: 'version-1',
  subject: 'physics',
  exactHash: 'e'.repeat(64),
  skeletonHash: 's'.repeat(64),
  normalizedText: 'a block slides down a frictionless ramp',
  computedAt: NOW,
};

const clock = { now: () => new Date(NOW) };

/**
 * **`ClaimNextForReview`'s advisory fingerprint (M4-32, DEC-M4-2).**
 *
 * `ensureFingerprint` runs *after* the claim's transaction has committed, and
 * its whole contract is that it can fail without the reviewer noticing: a
 * claim the reviewer already holds must never disappear because a hash could
 * not be computed. Every one of its give-up branches therefore has to be
 * proven to give up **quietly and still return the claim** — the failure mode
 * a test that only checked the happy path would miss is precisely the one
 * where a missing item turns a successful claim into an error.
 */
describe('ClaimNextForReview keeps the claim when the advisory fingerprint cannot be built (M4-42)', () => {
  const REVIEWER_A: PrincipalRef = {
    kind: 'human',
    id: 'reviewer-a',
    roleContext: ['reviewer', 'subject:physics'],
  };

  const ASSIGNMENT: ReviewAssignment = {
    assignmentId: 'assignment-1',
    itemId: 'item-1',
    itemVersionId: 'version-1',
    subject: 'physics',
    reviewer: REVIEWER_A,
    kind: 'claimed',
    state: 'claimed',
    claimedAt: NOW,
    leaseExpiresAt: '2026-08-26T16:00:00.000Z',
    aggregateVersion: 1,
  };

  function claimHandler(over: {
    items?: Partial<ItemRepository>;
    fingerprints?: FingerprintRepository;
  }): ClaimNextForReviewHandler {
    return new ClaimNextForReviewHandler({
      assignments: {
        async claimNext() {
          return ok(ASSIGNMENT);
        },
      } as unknown as ReviewAssignmentRepository,
      items: {
        async findById() {
          return err(REJECTED);
        },
        ...over.items,
      } as unknown as ItemRepository,
      fingerprints:
        over.fingerprints ?? new FingerprintsReturning({ findByItemVersionId: () => ok(undefined) }),
      reviewPolicy: REVIEW_POLICY,
      clock,
      audit: { async record() {} },
    });
  }

  it('returns the claim when the item behind it cannot be read', async () => {
    const result = await claimHandler({}).handle({ subject: 'physics' }, as(REVIEWER_A));
    expect(expectValue(result).assignmentId).toBe('assignment-1');
  });

  it('returns the claim when the claimed version is not among the item’s versions', async () => {
    const handler = claimHandler({
      items: {
        async findById() {
          // A real item, but carrying only `version-1`… under a different id,
          // so `versions.find(...)` comes back undefined.
          return ok({ ...submittedItem(), versions: [] } as unknown as Item);
        },
      },
    });
    const result = await handler.handle({ subject: 'physics' }, as(REVIEWER_A));
    expect(expectValue(result).assignmentId).toBe('assignment-1');
  });

  it('returns the claim when the fingerprint lookup itself fails', async () => {
    const handler = claimHandler({
      fingerprints: new FingerprintsReturning({ findByItemVersionId: () => err(REJECTED) }),
    });
    const result = await handler.handle({ subject: 'physics' }, as(REVIEWER_A));
    expect(expectValue(result).assignmentId).toBe('assignment-1');
  });

  it('returns the claim when the fingerprint save throws outright', async () => {
    const handler = claimHandler({
      items: {
        async findById() {
          return ok(submittedItem());
        },
      },
      fingerprints: new FingerprintsReturning({
        findByItemVersionId: () => ok(undefined),
        save: () => {
          throw new Error('the fingerprint table is gone');
        },
      }),
    });
    const result = await handler.handle({ subject: 'physics' }, as(REVIEWER_A));
    expect(expectValue(result).assignmentId).toBe('assignment-1');
  });

  // The green case: an already-fingerprinted version is not re-hashed.
  it('skips the work entirely when a fingerprint already exists', async () => {
    const handler = claimHandler({
      fingerprints: new FingerprintsReturning({
        findByItemVersionId: () => ok(FINGERPRINT),
        save: () => {
          throw new Error('an already-fingerprinted version must not be re-hashed');
        },
      }),
    });
    const result = await handler.handle({ subject: 'physics' }, as(REVIEWER_A));
    expect(expectValue(result).assignmentId).toBe('assignment-1');
  });
});

describe('GetDuplicateCandidates translates every repository failure (M4-42)', () => {
  const handler = (fingerprints: FingerprintRepository) =>
    new GetDuplicateCandidatesHandler({ fingerprints, clock });

  it("returns the repository's error when its own fingerprint cannot be read", async () => {
    const result = await handler(
      new FingerprintsReturning({ findByItemVersionId: () => err(REJECTED) }),
    ).handle({ itemVersionId: 'version-1' }, as(CONTENT_OPS));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  it('returns the error when the exact-hash lookup fails', async () => {
    const result = await handler(
      new FingerprintsReturning({ findByExactHash: () => err(REJECTED) }),
    ).handle({ itemVersionId: 'version-1' }, as(CONTENT_OPS));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  it('returns the error when the skeleton-hash lookup fails', async () => {
    const result = await handler(
      new FingerprintsReturning({ findBySkeletonHash: () => err(REJECTED) }),
    ).handle({ itemVersionId: 'version-1' }, as(CONTENT_OPS));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  it('returns the error when the trigram lookup fails', async () => {
    const result = await handler(
      new FingerprintsReturning({ findSimilarCandidates: () => err(REJECTED) }),
    ).handle({ itemVersionId: 'version-1' }, as(CONTENT_OPS));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  // The green case, so the four above are shown to be the failure arm rather
  // than the handler refusing everything.
  it('reports evaluated when every lookup succeeds', async () => {
    const result = await handler(new FingerprintsReturning()).handle(
      { itemVersionId: 'version-1' },
      as(CONTENT_OPS),
    );
    expect(expectValue(result).state).toBe('evaluated');
  });
});

describe('GetQueueHealth translates every repository failure (M4-42)', () => {
  it("returns the repository's error when the queue page cannot be read", async () => {
    const handler = new GetQueueHealthHandler({
      items: new ItemsReturning([err(REJECTED)]),
      escalations: {} as ReviewEscalationRepository,
      reviewPolicy: REVIEW_POLICY,
    });
    const result = await handler.handle({ now: NOW }, as(CONTENT_OPS));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  /**
   * The escalation lookup runs *after* the whole queue has been paged, so
   * reaching it at all needs a page that succeeds and contains an item old
   * enough to be overdue. A stub that only failed the first call would leave
   * this branch as uncovered as it was.
   */
  it('returns the error when the escalation-notification lookup fails', async () => {
    const handler = new GetQueueHealthHandler({
      items: new ItemsReturning([lastPage([submittedItem()])]),
      escalations: {
        async findNotifiedAt() {
          return err(REJECTED);
        },
      } as unknown as ReviewEscalationRepository,
      reviewPolicy: REVIEW_POLICY,
    });
    const result = await handler.handle({ now: NOW }, as(CONTENT_OPS));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  it('reports the queue when both reads succeed', async () => {
    const handler = new GetQueueHealthHandler({
      items: new ItemsReturning([lastPage([submittedItem()])]),
      escalations: {
        async findNotifiedAt() {
          return ok(new Map());
        },
      } as unknown as ReviewEscalationRepository,
      reviewPolicy: REVIEW_POLICY,
    });
    const result = await handler.handle({ now: NOW }, as(CONTENT_OPS));
    expect(expectValue(result).depthBySubject.length).toBeGreaterThan(0);
  });

  /**
   * **Clock skew on one row does not fail the whole report.** An item whose
   * `stateEnteredAt` is *after* the `now` being reported against cannot be
   * aged, and the handler skips it from both the histogram and the overdue
   * list rather than returning an error — the same choice
   * `SweepReviewAgeingHandler` makes. It still counts toward depth, because
   * it is genuinely in the queue whatever its timestamp says.
   */
  it('skips an item whose stateEnteredAt is in the future rather than failing the report', async () => {
    const skewed = { ...submittedItem(), stateEnteredAt: '2027-01-01T00:00:00.000Z' } as Item;
    const handler = new GetQueueHealthHandler({
      items: new ItemsReturning([lastPage([skewed])]),
      escalations: {
        async findNotifiedAt() {
          return ok(new Map());
        },
      } as unknown as ReviewEscalationRepository,
      reviewPolicy: REVIEW_POLICY,
    });

    const result = await handler.handle({ now: NOW }, as(CONTENT_OPS));
    const value = expectValue(result);
    expect(value.depthBySubject.find((row) => row.subject === 'physics')?.depth).toBe(1);
    // Counted nowhere in the histogram, and never called overdue.
    expect(value.ageHistogram.reduce((total, bucket) => total + bucket.count, 0)).toBe(0);
    expect(value.overdue).toEqual([]);
  });

  /**
   * **The queue is paged, and the report must cover all of it.** A handler
   * that stopped after the first page would report a shorter queue than
   * exists — the exact number Content Ops uses to decide whether to pull
   * another reviewer in. Two pages, one item each, must be counted as two.
   */
  it('follows the cursor to the end of the queue rather than reporting the first page', async () => {
    const items = new ItemsReturning([
      pageWithMore([submittedItem()]),
      lastPage([submittedItem()]),
    ]);
    const handler = new GetQueueHealthHandler({
      items,
      escalations: {
        async findNotifiedAt() {
          return ok(new Map());
        },
      } as unknown as ReviewEscalationRepository,
      reviewPolicy: REVIEW_POLICY,
    });

    const result = await handler.handle({ now: NOW }, as(CONTENT_OPS));
    expect(items.calls).toBe(2);
    const physics = expectValue(result).depthBySubject.find((row) => row.subject === 'physics');
    expect(physics?.depth).toBe(2);
  });
});

/**
 * **`GetReviewerThroughput` (M4-33) — the instrument M4-44 reports with.**
 *
 * Its two role arms are the DEC-M4-13 rule in code: `content_ops` reads every
 * reviewer's breakdown, a `reviewer` principal reads their own and no one
 * else's. Proving both arms is what stops the narrowing being an accident of
 * which repository method happened to be called.
 */
describe('GetReviewerThroughput narrows by role and translates failure (M4-42)', () => {
  const REVIEWER_A: PrincipalRef = { kind: 'human', id: 'reviewer-a', roleContext: ['reviewer'] };

  function decisionsBy(reviewerIds: readonly string[]): readonly ReviewDecision[] {
    return reviewerIds.map(
      (id, index) =>
        ({
          decisionId: `decision-${index}`,
          ownerType: 'item_version',
          ownerVersionId: `version-${index}`,
          reviewer: { kind: 'human', id, roleContext: ['reviewer'] },
          outcome: 'approved',
          decidedAt: NOW,
        }) as unknown as ReviewDecision,
    );
  }

  function reviews(overrides: {
    withinRange?: () => Result<readonly ReviewDecision[], RepositoryError>;
    byReviewer?: () => Result<readonly ReviewDecision[], RepositoryError>;
  }): ReviewDecisionRepository {
    return {
      async findWithinRange() {
        return overrides.withinRange?.() ?? ok([]);
      },
      async findByReviewer() {
        return overrides.byReviewer?.() ?? ok([]);
      },
    } as unknown as ReviewDecisionRepository;
  }

  const RANGE = { from: '2026-08-26T00:00:00.000Z', to: '2026-08-26T12:00:00.000Z' };

  it('reads every reviewer for content_ops, through findWithinRange', async () => {
    const handler = new GetReviewerThroughputHandler({
      reviews: reviews({
        withinRange: () => ok(decisionsBy(['reviewer-a', 'reviewer-b', 'reviewer-a'])),
        byReviewer: () => {
          throw new Error('content_ops must not be narrowed to one reviewer');
        },
      }),
    });
    const result = await handler.handle(RANGE, as(CONTENT_OPS));
    const value = expectValue(result);
    expect(value.perReviewer.map((row) => row.reviewerId)).toEqual(['reviewer-a', 'reviewer-b']);
    expect(value.aggregate.decisionCount).toBe(3);
    expect(value.aggregate.decisionsPerHour).toBeCloseTo(0.25);
  });

  it("narrows a reviewer to their own decisions, through findByReviewer", async () => {
    const handler = new GetReviewerThroughputHandler({
      reviews: reviews({
        withinRange: () => {
          throw new Error('a reviewer must never read the whole queue');
        },
        byReviewer: () => ok(decisionsBy(['reviewer-a'])),
      }),
    });
    const result = await handler.handle(RANGE, as(REVIEWER_A));
    const value = expectValue(result);
    expect(value.perReviewer).toHaveLength(1);
    expect(value.perReviewer[0]?.reviewerId).toBe('reviewer-a');
  });

  it('refuses a principal holding neither role', async () => {
    const learner: PrincipalRef = { kind: 'human', id: 'learner-1', roleContext: ['learner'] };
    const handler = new GetReviewerThroughputHandler({
      reviews: reviews({
        withinRange: () => {
          throw new Error('an unauthorized principal must never reach the repository');
        },
      }),
    });
    const result = await handler.handle(RANGE, as(learner));
    expect(expectError(result).kind).toBe('Authorization');
  });

  it("returns the repository's error when the decisions cannot be read", async () => {
    const handler = new GetReviewerThroughputHandler({
      reviews: reviews({ withinRange: () => err(REJECTED) }),
    });
    const result = await handler.handle(RANGE, as(CONTENT_OPS));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  /**
   * A zero-length range is a division by zero waiting to happen. The rate is
   * defined as 0 rather than `Infinity` or `NaN`, either of which would
   * serialize into the Content Ops screen as a number nobody can act on.
   */
  it('reports a rate of zero for a zero-length range rather than dividing by it', async () => {
    const handler = new GetReviewerThroughputHandler({
      reviews: reviews({ withinRange: () => ok(decisionsBy(['reviewer-a'])) }),
    });
    const result = await handler.handle({ from: NOW, to: NOW }, as(CONTENT_OPS));
    const value = expectValue(result);
    expect(value.hours).toBe(0);
    expect(value.aggregate.decisionsPerHour).toBe(0);
    expect(value.perReviewer[0]?.decisionsPerHour).toBe(0);
  });
});

describe('RefreshFingerprints translates every repository failure (M4-42)', () => {
  it("returns the repository's error when the queue page cannot be read", async () => {
    const handler = new RefreshFingerprintsHandler({
      items: new ItemsReturning([err(REJECTED)]),
      fingerprints: new FingerprintsReturning(),
    });
    const result = await handler.handle(
      { since: '2026-01-01T00:00:00.000Z', now: NOW },
      as(CONTENT_OPS),
    );
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  it('returns the error when a fingerprint cannot be saved', async () => {
    const handler = new RefreshFingerprintsHandler({
      items: new ItemsReturning([lastPage([submittedItem()])]),
      fingerprints: new FingerprintsReturning({ save: () => err(REJECTED) }),
    });
    const result = await handler.handle(
      { since: '2026-01-01T00:00:00.000Z', now: NOW },
      as(CONTENT_OPS),
    );
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });

  it('refreshes the version when the save succeeds', async () => {
    const handler = new RefreshFingerprintsHandler({
      items: new ItemsReturning([lastPage([submittedItem()])]),
      fingerprints: new FingerprintsReturning(),
    });
    const result = await handler.handle(
      { since: '2026-01-01T00:00:00.000Z', now: NOW },
      as(CONTENT_OPS),
    );
    expect(expectValue(result).refreshedItemVersionIds).toEqual(['version-1']);
  });

  /**
   * The batch path's own paging. A refresh that stopped after the first page
   * would leave everything past it unfingerprinted — duplicate detection
   * blind to exactly the older items most likely to have a retype.
   */
  it('follows the cursor rather than fingerprinting only the first page', async () => {
    const items = new ItemsReturning([
      pageWithMore([submittedItem()]),
      lastPage([submittedItem()]),
    ]);
    const handler = new RefreshFingerprintsHandler({
      items,
      fingerprints: new FingerprintsReturning(),
    });

    const result = await handler.handle(
      { since: '2026-01-01T00:00:00.000Z', now: NOW },
      as(CONTENT_OPS),
    );
    expect(items.calls).toBe(2);
    expect(expectValue(result).refreshedItemVersionIds).toEqual(['version-1', 'version-1']);
  });

  /**
   * The `since` watermark's own branch: a version older than the watermark is
   * skipped, which is what makes an incremental refresh incremental.
   */
  it('skips a version older than the since watermark', async () => {
    const handler = new RefreshFingerprintsHandler({
      items: new ItemsReturning([lastPage([submittedItem()])]),
      fingerprints: new FingerprintsReturning({
        save: () => {
          throw new Error('a skipped version must never be saved');
        },
      }),
    });
    const result = await handler.handle(
      { since: '2027-01-01T00:00:00.000Z', now: NOW },
      as(CONTENT_OPS),
    );
    expect(expectValue(result).refreshedItemVersionIds).toEqual([]);
  });
});
