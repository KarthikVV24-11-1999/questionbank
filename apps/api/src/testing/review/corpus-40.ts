import type { Block, ContentBody } from '../../contexts/content/domain/content-body.js';

/**
 * The seeded review corpus (M4-43) — **40 submitted items, six planted
 * cases, generated deterministically**.
 *
 * A hand-written corpus is unreviewable and rots the first time a field is
 * renamed (M3-45's reasoning, and M3-45's corpus builder is the precedent
 * this file follows). This builder is the artifact; the spec beside it
 * regenerates and seeds it, so a reviewer reads the intent rather than forty
 * items of data.
 *
 * **No clock and no randomness.** Every instant is an offset from
 * `CORPUS_NOW`, and variety comes from a linear congruential step over the
 * item index — so the corpus is the same bytes on every machine, and "the
 * constants-swapped pair is detected" is a fact rather than a distribution.
 *
 * **40, not 200 (corrected 2026-08-25, see the plan's own note).** The
 * corpus's value is the six planted cases, which exercise the same detectors
 * at 40 items as at 200. What 200 was sized for was throughput realism, and
 * that is `Fail — blocked` at any size — no reviewer pool exists to run a
 * session against (DEC-M4-5). Concepts scale proportionally: ≥ 4 here, the
 * same ~10-items-per-concept density ≥ 20 concepts gave at 200.
 *
 * **This is the one population three numbers describe.** M4-44's throughput
 * instrument and M4-38's interaction-cost test both run against this corpus,
 * so the figures they report are about the same items.
 */

export const CORPUS_SIZE = 40;

/** Every instant in the corpus is an offset from this, so nothing depends on when the suite runs. */
export const CORPUS_NOW = '2026-08-26T12:00:00.000Z';

/** ≥ 3, so subject scoping and batching have something real to do. */
export const CORPUS_SUBJECTS = ['physics', 'chemistry', 'biology'] as const;
export type CorpusSubject = (typeof CORPUS_SUBJECTS)[number];

/** ≥ 4 (corrected 2026-08-25, proportional to the reduced item count). */
export const CORPUS_CONCEPT_IDS = [
  '019fd4bc-9101-7000-8000-000000000001',
  '019fd4bc-9101-7000-8000-000000000002',
  '019fd4bc-9101-7000-8000-000000000003',
  '019fd4bc-9101-7000-8000-000000000004',
  '019fd4bc-9101-7000-8000-000000000005',
] as const;

export const CORPUS_TAXONOMY_VERSION_ID = '019fd4bc-9100-7000-8000-000000000001';

/** The reviewer the corpus is built to be claimed by — one planted item is authored by them. */
export const CLAIMING_REVIEWER_ID = '019fd4bc-9200-7000-8000-00000000000a';

/** Ordinary authors, none of whom is the claiming reviewer. */
const AUTHOR_IDS = [
  '019fd4bc-9200-7000-8000-000000000001',
  '019fd4bc-9200-7000-8000-000000000002',
  '019fd4bc-9200-7000-8000-000000000003',
] as const;

const HOUR_MS = 60 * 60 * 1000;

/** An instant `hours` before `CORPUS_NOW`, as an ISO string. */
function hoursAgo(hours: number): string {
  return new Date(Date.parse(CORPUS_NOW) - hours * HOUR_MS).toISOString();
}

/** An instant `hours` after `CORPUS_NOW`. */
function hoursAhead(hours: number): string {
  return new Date(Date.parse(CORPUS_NOW) + hours * HOUR_MS).toISOString();
}

/**
 * Deterministic variety — the same 31-bit linear congruential step M3-45's
 * builder uses, over the item index. The constants stay inside
 * `Number.MAX_SAFE_INTEGER`, so this is exact arithmetic.
 */
function shuffleOf(index: number): number {
  return (index * 1103515245 + 12345) % 2147483648;
}

function pick<T>(choices: readonly T[], index: number): T {
  return choices[Math.abs(shuffleOf(index)) % choices.length] as T;
}

function uuid(group: number, ordinal: number): string {
  return `019fd4bc-${group.toString(16).padStart(4, '0')}-7000-8000-${ordinal.toString(16).padStart(12, '0')}`;
}

export function textBody(value: string): ContentBody {
  const block: Block = { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value, marks: [] }] };
  return { schemaVersion: 1, blocks: [block] };
}

function fourOptions(labels: readonly [string, string, string, string]): readonly ContentBody[] {
  return labels.map(textBody);
}

/**
 * An existing claim on a corpus item. Only the expired-claim case carries
 * one — everything else is unclaimed and therefore claimable.
 */
export interface CorpusClaim {
  readonly assignmentId: string;
  readonly reviewerId: string;
  readonly claimedAt: string;
  readonly leaseExpiresAt: string;
  /** True when `leaseExpiresAt` is already in the past at `CORPUS_NOW`. */
  readonly expired: boolean;
}

export interface CorpusItem {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: CorpusSubject;
  readonly authorId: string;
  readonly conceptId: string;
  readonly stem: ContentBody;
  readonly options: readonly ContentBody[];
  readonly correctOptionId: string;
  /** When it entered `in_review` — what the ageing rule reads. */
  readonly stateEnteredAt: string;
  readonly claim?: CorpusClaim;
}

/**
 * The six planted cases, named by the id each occupies, so **every one is
 * asserted by exactly one test** rather than by a scan that might match the
 * wrong item.
 */
export interface PlantedCases {
  /**
   * Same question, different constants. Must pair by **skeleton** hash and
   * must NOT pair by exact hash — ROADMAP's fifth acceptance criterion, and
   * the case whose undetected failure M4-43's own planted-failure test
   * proves the suite would catch.
   */
  readonly constantsSwapped: readonly [string, string];
  /** The same item retyped, differing only in case and punctuation — must pair by **exact** hash. */
  readonly exactRetype: readonly [string, string];
  /**
   * Similar wording, genuinely different question. Must appear **only** in
   * the trigram group — never in the exact or skeleton groups, which is what
   * makes "merely similar" a different finding from "the same question".
   */
  readonly nearMiss: string;
  /** Authored by `CLAIMING_REVIEWER_ID` — INV-12 says it must never be offered to them. */
  readonly selfAuthored: string;
  /** Entered review long enough ago to be past escalation at `CORPUS_NOW`. */
  readonly agedPastEscalation: string;
  /** Claimed, with a lease that has already run out at `CORPUS_NOW` — reclaimable. */
  readonly expiredClaim: string;
}

export interface ReviewCorpus {
  readonly items: readonly CorpusItem[];
  readonly planted: PlantedCases;
}

/* ------------------------------------------------------------------ *
 * The planted pairs, written as text so what makes each pair a pair is
 * readable rather than inferred from a hash.
 * ------------------------------------------------------------------ */

/**
 * Identical wording, different numbers. `skeletonHash` collapses every
 * numeric literal and the unit token following it, so these two collide
 * there; `exactHash` keeps the numbers, so they must not collide there.
 */
const CONSTANTS_SWAPPED_A = 'A block of mass 4 kg slides down a frictionless ramp inclined at 30 degrees.';
const CONSTANTS_SWAPPED_B = 'A block of mass 9 kg slides down a frictionless ramp inclined at 45 degrees.';

/**
 * The same item retyped. `normalize` folds case, strips punctuation and
 * collapses whitespace, so these two produce byte-identical normalized text
 * and therefore the same `exactHash` — the "somebody pasted it again" case.
 */
const EXACT_RETYPE_A = 'A satellite orbits the Earth in a circular path of radius R.';
const EXACT_RETYPE_B = 'a satellite orbits the earth in a circular path of radius R';

/**
 * Shares most of its vocabulary with the retype pair, so trigram similarity
 * ranks it — but it asks a different question with a different skeleton, so
 * neither hash may pair it with anything.
 */
const NEAR_MISS = 'A satellite orbits the Earth in an elliptical path; find its orbital period at apogee.';

/** The generic stem every unplanted item gets, varied by index. */
function ordinaryStem(index: number): string {
  return `A body of mass ${1 + (index % 9)} kg is acted on by a constant force. Question ${index}.`;
}

const ORDINARY_OPTIONS: readonly [string, string, string, string] = [
  'Option one',
  'Option two',
  'Option three',
  'Option four',
];

/**
 * Builds the corpus. Pure — same input (none) always produces the same
 * output, which `review-corpus.integration.spec.ts` asserts over 100 runs.
 */
export function buildReviewCorpus(): ReviewCorpus {
  const items: CorpusItem[] = [];

  const idOf = (index: number): string => uuid(0x9300, index);
  const versionIdOf = (index: number): string => uuid(0x9400, index);

  /**
   * The planted indices. Named constants rather than magic numbers at the
   * call sites, and spread across the corpus rather than bunched at the
   * front, so a detector that only ever looked at the first page would still
   * have to find them.
   */
  const CONSTANTS_SWAPPED_AT = [3, 27] as const;
  const EXACT_RETYPE_AT = [8, 31] as const;
  const NEAR_MISS_AT = 19;
  const SELF_AUTHORED_AT = 12;
  const AGED_AT = 5;
  const EXPIRED_CLAIM_AT = 22;

  for (let index = 0; index < CORPUS_SIZE; index += 1) {
    const stemText =
      index === CONSTANTS_SWAPPED_AT[0]
        ? CONSTANTS_SWAPPED_A
        : index === CONSTANTS_SWAPPED_AT[1]
          ? CONSTANTS_SWAPPED_B
          : index === EXACT_RETYPE_AT[0]
            ? EXACT_RETYPE_A
            : index === EXACT_RETYPE_AT[1]
              ? EXACT_RETYPE_B
              : index === NEAR_MISS_AT
                ? NEAR_MISS
                : ordinaryStem(index);

    /**
     * The duplicate detectors are **subject-scoped** — `findByExactHash` and
     * `findBySkeletonHash` both take a subject, so a planted pair split
     * across two subjects would never be found however good the hash is.
     * All five duplicate-relevant items therefore sit in physics; everything
     * else is spread.
     */
    const isDuplicateCase =
      (CONSTANTS_SWAPPED_AT as readonly number[]).includes(index) ||
      (EXACT_RETYPE_AT as readonly number[]).includes(index) ||
      index === NEAR_MISS_AT;

    /**
     * **The two claim cases live in different subjects, deliberately.**
     * `claimNext` is subject-scoped and a claim is a real state transition —
     * `content.review_assignment` refuses deletion outright ("expiry and
     * release are transitions, not deletions"), so a test that drains a
     * subject cannot put it back. Two claim-exercising cases sharing a
     * subject would therefore be order-dependent: whichever ran second would
     * find an empty queue and fail for a reason that has nothing to do with
     * what it was testing. Pinning them apart is what keeps each planted
     * case independently assertable.
     */
    const subject: CorpusSubject = isDuplicateCase
      ? 'physics'
      : index === SELF_AUTHORED_AT
        ? 'chemistry'
        : index === EXPIRED_CLAIM_AT
          ? 'biology'
          : pick(CORPUS_SUBJECTS, index);

    // The aged item is past escalation (72h > the 48h the corpus's policy
    // uses); everything else is comfortably fresh.
    const stateEnteredAt = index === AGED_AT ? hoursAgo(96) : hoursAgo(1 + (index % 6));

    const item: CorpusItem = {
      itemId: idOf(index),
      itemVersionId: versionIdOf(index),
      subject,
      authorId: index === SELF_AUTHORED_AT ? CLAIMING_REVIEWER_ID : pick(AUTHOR_IDS, index),
      conceptId: pick(CORPUS_CONCEPT_IDS, index),
      stem: textBody(stemText),
      options: fourOptions(ORDINARY_OPTIONS),
      correctOptionId: `o${1 + (Math.abs(shuffleOf(index)) % 4)}`,
      stateEnteredAt,
      ...(index === EXPIRED_CLAIM_AT
        ? {
            claim: {
              assignmentId: uuid(0x9500, index),
              reviewerId: AUTHOR_IDS[0] as string,
              claimedAt: hoursAgo(8),
              // Ran out four hours ago — the lease a sweep or a reclaim must
              // be able to take back.
              leaseExpiresAt: hoursAgo(4),
              expired: true,
            } satisfies CorpusClaim,
          }
        : {}),
    };

    items.push(item);
  }

  return {
    items,
    planted: {
      constantsSwapped: [versionIdOf(CONSTANTS_SWAPPED_AT[0]), versionIdOf(CONSTANTS_SWAPPED_AT[1])],
      exactRetype: [versionIdOf(EXACT_RETYPE_AT[0]), versionIdOf(EXACT_RETYPE_AT[1])],
      nearMiss: versionIdOf(NEAR_MISS_AT),
      selfAuthored: versionIdOf(SELF_AUTHORED_AT),
      agedPastEscalation: versionIdOf(AGED_AT),
      expiredClaim: versionIdOf(EXPIRED_CLAIM_AT),
    },
  };
}

/** The review policy the corpus's instants are written against, so ageing assertions are exact. */
export const CORPUS_REVIEW_POLICY = {
  warnAfterHours: 24,
  escalateAfterHours: 48,
  leaseHours: 4,
  sampleRate: 0.1,
} as const;

/** Exposed so a caller need not re-derive "which hours ago" the corpus meant. */
export const corpusInstants = { hoursAgo, hoursAhead };
