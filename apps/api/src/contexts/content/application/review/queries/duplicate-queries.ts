import { err, ok, type Result } from '../../../domain/result.js';
import type { ContentError } from '../../../domain/content-error.js';
import type { FingerprintRepository, ItemFingerprintRecord } from '../../../domain/repository-ports.js';
import { applicationError, authorize, type ApplicationError } from '../../authorization.js';
import type { ApplicationContext, Clock } from '../../ports.js';
import { GET_DUPLICATE_CANDIDATES_POLICY } from '../policies.js';

/**
 * `GetDuplicateCandidates` (M4-32, DEC-M4-2). Three labelled groups, never
 * one merged list — "same item retyped" (`exactMatches`), "same skeleton,
 * different constants" (`skeletonMatches`) and "merely similar"
 * (`trigramMatches`, ranked) answer three different questions, and
 * collapsing them would make a reviewer read a rank-10 trigram neighbour as
 * exactly the same finding as a byte-identical retype.
 *
 * **Advisory, never blocking (DEC-M4-2).** This module is a query with no
 * caller among content's transition handlers — `content-rules.ts` asserts
 * that by import graph, the same discipline `delivery-queries.ts` gets for
 * the answer key.
 *
 * **Read-only against whatever `content.item_fingerprint` already holds.**
 * This handler never computes a fingerprint itself — `ClaimNextForReviewHandler`
 * (M4-32's other half, `assignment-handlers.ts`) computes the claimed item's
 * own fingerprint synchronously if missing; `RefreshFingerprints`
 * (`fingerprint-handlers.ts`) is the batch path for everything else. When
 * neither has run yet for `itemVersionId`, this handler reports
 * `'not_evaluated'` honestly rather than computing on a read, the same
 * choice `GetValidationFindingsHandler`'s `duplicateCheckState` already
 * makes.
 */

export interface GetDuplicateCandidates {
  readonly itemVersionId: string;
}

export interface DuplicateCandidate {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  /** Present only in `trigramMatches` — exact/skeleton membership is binary, not ranked. */
  readonly similarity?: number;
}

/**
 * Not `DuplicateCheckState` (`domain/pre-submission-validation.ts`) — that
 * type answers "what did the check find" (`none_found`/`candidates_found`);
 * this one answers "did this query have anything to compare against at
 * all". Same barrel, different question; a shared name here would be the
 * collision the barrel's own export-set test exists to catch.
 */
export type DuplicateEvaluationState = 'evaluated' | 'not_evaluated';

export interface DuplicateCandidatesResult {
  readonly state: DuplicateEvaluationState;
  readonly exactMatches: readonly DuplicateCandidate[];
  readonly skeletonMatches: readonly DuplicateCandidate[];
  readonly trigramMatches: readonly DuplicateCandidate[];
  /** When this item's own fingerprint was computed — absent when `state` is `'not_evaluated'`. */
  readonly computedAt?: string;
  /** When this query ran — together with `computedAt`, distinguishes "no candidates" from "no candidates as of 40 minutes ago". */
  readonly asOf: string;
}

const TRIGRAM_LIMIT = 10;

export interface DuplicateQueryDependencies {
  readonly fingerprints: FingerprintRepository;
  readonly clock: Clock;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

function toCandidate(record: ItemFingerprintRecord, similarity?: number): DuplicateCandidate {
  return {
    itemId: record.itemId,
    itemVersionId: record.itemVersionId,
    subject: record.subject,
    ...(similarity === undefined ? {} : { similarity }),
  };
}

export class GetDuplicateCandidatesHandler {
  readonly name = 'GetDuplicateCandidates';
  readonly policy = GET_DUPLICATE_CANDIDATES_POLICY;

  constructor(private readonly deps: DuplicateQueryDependencies) {}

  async handle(
    query: GetDuplicateCandidates,
    context: ApplicationContext,
  ): Promise<Result<DuplicateCandidatesResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const asOf = this.deps.clock.now().toISOString();

    const own = await this.deps.fingerprints.findByItemVersionId(query.itemVersionId);
    if (!own.ok) return err(fromContent(own.error));
    if (own.value === undefined) {
      return ok({ state: 'not_evaluated', exactMatches: [], skeletonMatches: [], trigramMatches: [], asOf });
    }
    const fingerprint = own.value;

    const exactFound = await this.deps.fingerprints.findByExactHash(fingerprint.subject, fingerprint.exactHash);
    if (!exactFound.ok) return err(fromContent(exactFound.error));
    const skeletonFound = await this.deps.fingerprints.findBySkeletonHash(fingerprint.subject, fingerprint.skeletonHash);
    if (!skeletonFound.ok) return err(fromContent(skeletonFound.error));
    const trigramFound = await this.deps.fingerprints.findSimilarCandidates(
      fingerprint.subject,
      fingerprint.normalizedText,
      TRIGRAM_LIMIT,
    );
    if (!trigramFound.ok) return err(fromContent(trigramFound.error));

    const exactMatches = exactFound.value
      .filter((record) => record.itemVersionId !== query.itemVersionId)
      .map((record) => toCandidate(record));
    const skeletonMatches = skeletonFound.value
      .filter((record) => record.itemVersionId !== query.itemVersionId)
      .map((record) => toCandidate(record));
    const alreadyLabelled = new Set([
      query.itemVersionId,
      ...exactMatches.map((c) => c.itemVersionId),
      ...skeletonMatches.map((c) => c.itemVersionId),
    ]);
    const trigramMatches = trigramFound.value
      .filter((candidate) => !alreadyLabelled.has(candidate.fingerprint.itemVersionId))
      .map((candidate) => toCandidate(candidate.fingerprint, candidate.similarity));

    return ok({
      state: 'evaluated',
      exactMatches,
      skeletonMatches,
      trigramMatches,
      computedAt: fingerprint.computedAt,
      asOf,
    });
  }
}
