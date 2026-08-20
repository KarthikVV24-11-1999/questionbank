import type { PrincipalRef } from '@questionbank/domain-types';
import type { Result } from './result.js';
import type { ContentError } from './content-error.js';
import type { Item } from './item.js';
import type { ItemVersion } from './item-version.js';
import type { MediaAsset, MediaAssetVersion } from './media-asset.js';
import type { ContentEvent } from './events/content-events.js';
import type { ReviewDecision, ReviewedOwnerType } from './review-decision.js';
import type { ReviewAssignment } from './review/review-assignment.js';
import type { Solution, SolutionVersion } from './solution.js';
import type { Stimulus, StimulusVersion } from './stimulus.js';

/**
 * What the application layer needs from persistence, declared by the domain so
 * the dependency points inward. Infrastructure implements these; nothing here
 * knows that Postgres exists.
 *
 * **Every `save` takes the events the change produces**, and writes them in the
 * same transaction as the aggregate (§9 rule 4, P4). Write-then-publish loses
 * the event whenever the process dies between the two, and the two orderings
 * are indistinguishable in a code review — so the transaction is not something
 * a caller can forget to join.
 */

export type RepositoryError = ContentError<'CONFLICT' | 'NOT_FOUND' | 'PERSISTENCE_REJECTED'>;

export interface ItemRepository {
  /**
   * One aggregate, one transaction (§10): the item, every version, and each
   * version's options, matching members and pairs, numeric specification,
   * tags, provenance and licensing.
   */
  save(item: Item, events?: readonly ContentEvent[]): Promise<Result<Item, RepositoryError>>;

  findById(itemId: string): Promise<Result<Item, RepositoryError>>;

  /**
   * Discards a draft (FR-TCH-06 rule 3). Permanent from every read path — the
   * row is retained only so the audit record has something to name, and the
   * database refuses the call for anything that is not an unpublished draft
   * (`item_only_drafts_are_deleted`).
   */
  deleteDraft(itemId: string): Promise<Result<true, RepositoryError>>;

  /** FR-TCH-06 rule 1 — drafts are visible only to their author and Content Ops. */
  findDraftsByAuthor(authorId: string): Promise<Result<readonly Item[], RepositoryError>>;

  /** The version students see, or `NotFound` when nothing is published. */
  findPublishedVersion(itemId: string): Promise<Result<ItemVersion, RepositoryError>>;

  /**
   * Which items pin this stimulus version — the supplied fact FR-TCH-03 rule 3
   * consumes at `transitionStimulus`.
   *
   * It lives here rather than on `StimulusRepository` because it counts
   * *items*, and one query with one implementation is worth more than putting
   * it where its caller happens to sit.
   */
  countPublishedItemsUsingStimulusVersion(
    stimulusVersionId: string,
  ): Promise<Result<number, RepositoryError>>;

  /**
   * The review queue's candidate source (M4-16). `ListMyDrafts` is
   * author-scoped; nothing else lists submitted work. Returns only items
   * whose `lifecycleState` is `in_review` — the state restriction is a
   * `WHERE`, not a filter applied after the fact, so a caller cannot widen
   * it by accident.
   *
   * `excludeAuthorId` is the source-level half of INV-12 (M4-04 re-checks
   * after selection, the same discipline the claim predicate uses). Paged by
   * a stable keyset on `item_id` — never `OFFSET`, which a concurrent insert
   * shifts under a page boundary — so `nextCursor` names the last id this
   * page returned and a later page never duplicates or skips a row.
   */
  findSubmittedForReview(
    criteria: SubmittedForReviewCriteria,
  ): Promise<Result<SubmittedForReviewPage, RepositoryError>>;
}

export interface SubmittedForReviewCriteria {
  readonly subject?: string;
  readonly excludeAuthorId?: string;
  readonly limit: number;
  readonly cursor?: string;
}

export interface SubmittedForReviewPage {
  readonly items: readonly Item[];
  readonly nextCursor?: string;
}

export interface ReviewDecisionRepository {
  /**
   * Append-only. A reviewer who changes their mind records a second decision,
   * because the history is what FR-TCH-09 rule 1 needs when comments have to
   * persist against the version they addressed.
   *
   * One transaction, one schema, one pool (M4-19): the decision row, its
   * `candidatesShownIds` as rows in `review_candidate_shown`, and — when
   * `claimedAssignmentId` is supplied — that assignment's transition to
   * `decided`, all commit together or none does. `claimedAssignmentId` is
   * optional because not every reviewed owner type has a claim behind it yet
   * (M4-18's claim exists for items only); omitting it writes the decision
   * and its candidate rows with no assignment side effect.
   */
  record(
    decision: ReviewDecision,
    claimedAssignmentId?: string,
  ): Promise<Result<ReviewDecision, RepositoryError>>;

  /** Every decision against an item version, most recent first — `findAllFor('item_version', …)` under a name M4-33 reads more easily. */
  findByItemVersion(itemVersionId: string): Promise<Result<readonly ReviewDecision[], RepositoryError>>;

  /** A reviewer's decisions within an instant range, oldest first — the throughput instrument's source (M4-33). */
  findByReviewer(
    reviewerId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<Result<readonly ReviewDecision[], RepositoryError>>;

  /**
   * The most recent **approving** decision for a version — the signature
   * M3-11's precondition consumes, or nothing.
   *
   * Keyed on the version rather than the item: an approval of version 1 says
   * nothing about version 2, whose key may differ (INV-07).
   */
  findApprovalFor(
    ownerType: ReviewedOwnerType,
    ownerVersionId: string,
  ): Promise<Result<ReviewDecision, RepositoryError>>;

  /** Every decision for a version, most recent first. */
  findAllFor(
    ownerType: ReviewedOwnerType,
    ownerVersionId: string,
  ): Promise<Result<readonly ReviewDecision[], RepositoryError>>;
}

/**
 * Column-derived priority within the candidate set (M4-18). Not M4-03's full
 * `orderCandidates` — that needs confidence, which comes from M3 validation
 * this repository has no access to — just the two signals SQL already has:
 * whether an escalation exists, and how long the item has waited.
 */
export type ReviewClaimOrdering = 'escalated_first' | 'oldest_first';

export interface ClaimNextReviewAssignment {
  readonly subject: string;
  readonly reviewer: PrincipalRef;
  readonly ordering: ReviewClaimOrdering;
  readonly now: string;
  readonly leaseExpiresAt: string;
}

export interface ReviewAssignmentRepository {
  /**
   * The one piece of concurrency in this milestone that can silently be
   * wrong (M4-18). One statement: `SELECT … FOR UPDATE SKIP LOCKED` over the
   * candidate set, then the assignment INSERT, in the same transaction — not
   * a read followed by a separate write, which races.
   *
   * Self-review is excluded twice, on purpose. The predicate excludes the
   * version's author; it does not reach `editedBy` (approve-with-edits,
   * M4-15), because a version's editor is a fact this query does not carry
   * inline the way `authoredBy` is. The re-check after selection, `assertAssignable`
   * (M4-04, INV-12), reads the whole candidate and catches that case for
   * real — not a redundant check, the one that actually closes the hole.
   *
   * `NOT_FOUND` when the candidate set is empty; a self-review the re-check
   * catches is `PERSISTENCE_REJECTED`, since `RepositoryError`'s code union
   * has no fourth member to name it more precisely.
   */
  claimNext(criteria: ClaimNextReviewAssignment): Promise<Result<ReviewAssignment, RepositoryError>>;

  /** Optimistic concurrency on `aggregate_version`; a stale write is `Conflict`. */
  release(
    assignmentId: string,
    at: string,
    expectedVersion: number,
  ): Promise<Result<ReviewAssignment, RepositoryError>>;

  /** Every lease past expiry, released in one statement. Idempotent: a second run finds nothing left to release. */
  releaseExpired(now: string): Promise<Result<readonly ReviewAssignment[], RepositoryError>>;

  findById(assignmentId: string): Promise<Result<ReviewAssignment, RepositoryError>>;
}

export interface MediaAssetRepository {
  /** One aggregate, one transaction: the asset, its versions and their licensing. */
  save(asset: MediaAsset, events?: readonly ContentEvent[]): Promise<Result<MediaAsset, RepositoryError>>;

  findById(assetId: string): Promise<Result<MediaAsset, RepositoryError>>;

  findPublishedVersion(assetId: string): Promise<Result<MediaAssetVersion, RepositoryError>>;

  /** The media library (FR-QM-06), oldest first so the list is stable. */
  list(): Promise<Result<readonly MediaAsset[], RepositoryError>>;

  /**
   * How much **published** content references this asset version — the fact
   * FR-QM-06 rule 3 consumes to refuse retirement.
   *
   * Spans items, stimuli and solutions in one query. Counting them separately
   * and adding would give three chances to forget one, and the answer that
   * matters is "is anything using it", not "how many of each".
   */
  countReferencingPublishedContent(
    assetVersionId: string,
  ): Promise<Result<number, RepositoryError>>;
}

export interface SolutionRepository {
  /** One aggregate, one transaction: the solution, its versions, steps, analyses and approaches. */
  save(solution: Solution, events?: readonly ContentEvent[]): Promise<Result<Solution, RepositoryError>>;

  findById(solutionId: string): Promise<Result<Solution, RepositoryError>>;

  /**
   * The published solution for a specific item version — the supplied fact
   * M3-11's publication precondition consumes.
   *
   * Keyed on the *version*, not the item: a solution written for version 1
   * says nothing about version 2, whose key may differ (FR-TCH-04 rule 3).
   */
  findPublishedForItemVersion(
    itemVersionId: string,
  ): Promise<Result<SolutionVersion, RepositoryError>>;
}

export interface StimulusRepository {
  /** One aggregate, one transaction: the stimulus, its versions and their licensing. */
  save(stimulus: Stimulus, events?: readonly ContentEvent[]): Promise<Result<Stimulus, RepositoryError>>;

  findById(stimulusId: string): Promise<Result<Stimulus, RepositoryError>>;

  /** The version an item authored today would pin, or `NotFound`. */
  findPublishedVersion(stimulusId: string): Promise<Result<StimulusVersion, RepositoryError>>;
}
