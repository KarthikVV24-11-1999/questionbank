import type { Result } from './result.js';
import type { ContentError } from './content-error.js';
import type { Item } from './item.js';
import type { ItemVersion } from './item-version.js';
import type { MediaAsset, MediaAssetVersion } from './media-asset.js';
import type { Solution, SolutionVersion } from './solution.js';
import type { Stimulus, StimulusVersion } from './stimulus.js';

/**
 * What the application layer needs from persistence, declared by the domain so
 * the dependency points inward. Infrastructure implements these; nothing here
 * knows that Postgres exists.
 */

export type RepositoryError = ContentError<'CONFLICT' | 'NOT_FOUND' | 'PERSISTENCE_REJECTED'>;

export interface ItemRepository {
  /**
   * One aggregate, one transaction (§10): the item, every version, and each
   * version's options, matching members and pairs, numeric specification,
   * tags, provenance and licensing.
   */
  save(item: Item): Promise<Result<Item, RepositoryError>>;

  findById(itemId: string): Promise<Result<Item, RepositoryError>>;

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
}

export interface MediaAssetRepository {
  /** One aggregate, one transaction: the asset, its versions and their licensing. */
  save(asset: MediaAsset): Promise<Result<MediaAsset, RepositoryError>>;

  findById(assetId: string): Promise<Result<MediaAsset, RepositoryError>>;

  findPublishedVersion(assetId: string): Promise<Result<MediaAssetVersion, RepositoryError>>;

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
  save(solution: Solution): Promise<Result<Solution, RepositoryError>>;

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
  save(stimulus: Stimulus): Promise<Result<Stimulus, RepositoryError>>;

  findById(stimulusId: string): Promise<Result<Stimulus, RepositoryError>>;

  /** The version an item authored today would pin, or `NotFound`. */
  findPublishedVersion(stimulusId: string): Promise<Result<StimulusVersion, RepositoryError>>;
}
