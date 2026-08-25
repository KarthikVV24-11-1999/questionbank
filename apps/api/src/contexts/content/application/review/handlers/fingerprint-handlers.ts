import { err, ok, type Result } from '../../../domain/result.js';
import type { ContentError } from '../../../domain/content-error.js';
import type { FingerprintRepository, ItemRepository } from '../../../domain/repository-ports.js';
import {
  exactHash,
  normalizedText,
  skeletonHash,
  type ItemFingerprintFacts,
} from '../../../domain/review/fingerprint.js';
import { optionsOf } from '../../../domain/response-specification.js';
import { applicationError, authorize, type ApplicationError } from '../../authorization.js';
import type { ApplicationContext } from '../../ports.js';
import { REFRESH_FINGERPRINTS_POLICY } from '../policies.js';

/**
 * `RefreshFingerprints` (M4-32, DEC-M4-2's operational half). Recomputes and
 * upserts a fingerprint for every version of every `in_review` item whose
 * latest version was authored at or after `since` — content changed since
 * the last watermark.
 *
 * **The review queue, not the whole corpus, is the population.** DEC-M4-2's
 * duplicate check exists for a reviewer looking at a claimed item; it has no
 * stated purpose for a draft nobody has submitted or a version long since
 * superseded. `ItemRepository.findSubmittedForReview` (M4-16) is already the
 * one query the ageing sweep (M4-31) reads this same population through, so
 * this handler follows that precedent rather than adding a second "every
 * in_review item, paged" traversal for the codebase to keep in sync.
 *
 * **Fingerprints, never duplicate candidates, come out of this handler.**
 * `GetDuplicateCandidates` (`duplicate-queries.ts`) is the read; this is
 * purely the write that keeps `content.item_fingerprint` current so that
 * read has something recent to compare against.
 */

const PAGE_SIZE = 200;

export interface RefreshFingerprints {
  /** Only a version authored at or after this instant is recomputed. */
  readonly since: string;
  /** DEC-M4-15: supplied, never read from a clock inside this command — becomes the result's new watermark. */
  readonly now: string;
}

export interface RefreshFingerprintsResult {
  readonly refreshedItemVersionIds: readonly string[];
  /** The instant this run was as-of — the next call's `since`. */
  readonly watermark: string;
}

export interface FingerprintDependencies {
  readonly items: ItemRepository;
  readonly fingerprints: FingerprintRepository;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export class RefreshFingerprintsHandler {
  readonly name = 'RefreshFingerprints';
  readonly policy = REFRESH_FINGERPRINTS_POLICY;

  constructor(private readonly deps: FingerprintDependencies) {}

  async handle(
    command: RefreshFingerprints,
    context: ApplicationContext,
  ): Promise<Result<RefreshFingerprintsResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const refreshedItemVersionIds: string[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.deps.items.findSubmittedForReview({
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!page.ok) return err(fromContent(page.error));

      for (const item of page.value.items) {
        const version = item.versions[item.versions.length - 1]!;
        if (Date.parse(version.createdAt) < Date.parse(command.since)) continue;

        // Always present on anything findSubmittedForReview hydrates — the
        // repository writes it unconditionally (never NULL, defaulted to
        // 'unclassified'), the same fact SweepReviewAgeingHandler's own
        // `as string` cast already relies on.
        const subject = item.authoringSubject as string;
        const facts: ItemFingerprintFacts = {
          stem: version.stem,
          options: optionsOf(version.responseSpec).map((option) => option.body),
        };
        const saved = await this.deps.fingerprints.save({
          itemId: item.itemId,
          itemVersionId: version.versionId,
          subject,
          exactHash: exactHash(facts),
          skeletonHash: skeletonHash(facts),
          normalizedText: normalizedText(facts),
          computedAt: command.now,
        });
        if (!saved.ok) return err(fromContent(saved.error));
        refreshedItemVersionIds.push(version.versionId);
      }

      if (page.value.nextCursor === undefined) break;
      cursor = page.value.nextCursor;
    }

    return ok({ refreshedItemVersionIds, watermark: command.now });
  }
}
