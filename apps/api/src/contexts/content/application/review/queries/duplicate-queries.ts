import { err, ok, type Result } from '../../../domain/result.js';
import type { ContentError } from '../../../domain/content-error.js';
import type { FingerprintRepository, ItemFingerprintRecord } from '../../../domain/repository-ports.js';
import { exactHash, fingerprintFactsOf, normalizedText, skeletonHash } from '../../../domain/review/fingerprint.js';
import { buildProposedItem, type ProposedItemContent } from '../../../domain/proposed-item.js';
import { applicationError, authorize, type ApplicationError } from '../../authorization.js';
import type { ApplicationContext, Clock } from '../../ports.js';
import { GET_DUPLICATE_CANDIDATES_POLICY, GET_PROPOSAL_DUPLICATES_POLICY } from '../policies.js';

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

/** What a fingerprint is compared on: the subject it is scoped to, and the three things that identify it. */
type Probe = Pick<ItemFingerprintRecord, 'subject' | 'exactHash' | 'skeletonHash' | 'normalizedText'>;

/**
 * The three labelled groups for one fingerprint, from the store (ADR-0021).
 * **The one place they are worked out**: the stored item's query and the
 * proposal's both call it, so "exact retype", "constants swapped" and "merely
 * similar" mean the same thing whether or not the item has been saved.
 * `excluding` drops the item's own version from the groups, when it has one.
 */
async function findDuplicateGroups(
  fingerprints: FingerprintRepository,
  probe: Probe,
  excluding?: string,
): Promise<Result<Pick<DuplicateCandidatesResult, 'exactMatches' | 'skeletonMatches' | 'trigramMatches'>, ApplicationError>> {
  const exactFound = await fingerprints.findByExactHash(probe.subject, probe.exactHash);
  if (!exactFound.ok) return err(fromContent(exactFound.error));
  const skeletonFound = await fingerprints.findBySkeletonHash(probe.subject, probe.skeletonHash);
  if (!skeletonFound.ok) return err(fromContent(skeletonFound.error));
  const trigramFound = await fingerprints.findSimilarCandidates(probe.subject, probe.normalizedText, TRIGRAM_LIMIT);
  if (!trigramFound.ok) return err(fromContent(trigramFound.error));

  const exactMatches = exactFound.value.filter((record) => record.itemVersionId !== excluding).map((record) => toCandidate(record));
  const skeletonMatches = skeletonFound.value.filter((record) => record.itemVersionId !== excluding).map((record) => toCandidate(record));
  const alreadyLabelled = new Set([
    ...(excluding === undefined ? [] : [excluding]),
    ...exactMatches.map((candidate) => candidate.itemVersionId),
    ...skeletonMatches.map((candidate) => candidate.itemVersionId),
  ]);
  const trigramMatches = trigramFound.value
    .filter((candidate) => !alreadyLabelled.has(candidate.fingerprint.itemVersionId))
    .map((candidate) => toCandidate(candidate.fingerprint, candidate.similarity));

  return ok({ exactMatches, skeletonMatches, trigramMatches });
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

    const groups = await findDuplicateGroups(this.deps.fingerprints, fingerprint, query.itemVersionId);
    if (!groups.ok) return err(groups.error);

    return ok({ state: 'evaluated', ...groups.value, computedAt: fingerprint.computedAt, asOf });
  }
}

/**
 * Duplicates of content that has not been stored (M5-33) — a proposal asking
 * "does this resemble anything already in content?" before it is a draft.
 *
 * It fingerprints the proposal with the same functions the stored path does
 * (`fingerprintFactsOf`, `exactHash`, `skeletonHash`, `normalizedText`) and
 * compares it with the same function (`findDuplicateGroups`), against the same
 * store, scoped to the same subject. Nothing is written: the proposal's
 * fingerprint is computed, compared and discarded, since it names no item to
 * attach one to.
 *
 * **Advisory, never blocking (ADR-0021).** Genuine variants are pedagogically
 * valuable. This sits in the module `content-rules.ts` already asserts no
 * transition handler reaches, so the duplicate signal cannot become a gate.
 */
export interface GetDuplicateCandidatesForProposal {
  /** The subject the comparison is scoped to, as the stored path scopes by its item's. */
  readonly subject: string;
  readonly content: ProposedItemContent;
}

export class GetDuplicateCandidatesForProposalHandler {
  readonly name = 'GetDuplicateCandidatesForProposal';
  readonly policy = GET_PROPOSAL_DUPLICATES_POLICY;

  constructor(private readonly deps: DuplicateQueryDependencies) {}

  async handle(
    query: GetDuplicateCandidatesForProposal,
    context: ApplicationContext,
  ): Promise<Result<DuplicateCandidatesResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const asOf = this.deps.clock.now().toISOString();

    if (typeof query.subject !== 'string' || query.subject.trim().length === 0) {
      return err(applicationError('Validation', 'SUBJECT_REQUIRED', 'a duplicate check is scoped to a subject', 'subject'));
    }

    // Structure first: a proposal that is not a well-formed item has no stem
    // and options to fingerprint, and the report says where it is wrong.
    const proposed = buildProposedItem(query.content, asOf);
    if (!proposed.ok) {
      const [first] = proposed.findings;
      return err(applicationError('Validation', 'PROPOSAL_STRUCTURE_INVALID', first!.message, first!.location));
    }

    const facts = fingerprintFactsOf(proposed.version.stem, proposed.version.responseSpec);
    const groups = await findDuplicateGroups(this.deps.fingerprints, {
      subject: query.subject,
      exactHash: exactHash(facts),
      skeletonHash: skeletonHash(facts),
      normalizedText: normalizedText(facts),
    });
    if (!groups.ok) return err(groups.error);

    return ok({ state: 'evaluated', ...groups.value, computedAt: asOf, asOf });
  }
}
