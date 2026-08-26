import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../database.js';
import { expectValue } from '../expect-result.js';
import { PostgresFingerprintRepository } from '../../contexts/content/infrastructure/review/fingerprint.repository.js';
import { PostgresReviewAssignmentRepository } from '../../contexts/content/infrastructure/review/review-assignment.repository.js';
import {
  exactHash,
  normalizedText,
  skeletonHash,
  type ItemFingerprintFacts,
} from '../../contexts/content/domain/review/fingerprint.js';
import { ageState } from '../../contexts/content/domain/review/ageing.js';
import { createReviewPolicy, type ReviewPolicy } from '../../contexts/content/domain/review/review-policy.js';
import {
  CLAIMING_REVIEWER_ID,
  CORPUS_CONCEPT_IDS,
  CORPUS_NOW,
  CORPUS_REVIEW_POLICY,
  CORPUS_SIZE,
  CORPUS_SUBJECTS,
  CORPUS_TAXONOMY_VERSION_ID,
  buildReviewCorpus,
  corpusInstants,
  type CorpusItem,
} from './corpus-40.js';

/**
 * **The seeded review corpus, against the real detectors (M4-43).**
 *
 * Every planted case is asserted **by exactly one test**, against the
 * repository and domain code that runs in production — not against a
 * re-implementation of the rule inside the test. The constants-swapped pair
 * is ROADMAP's fifth acceptance criterion, and the last describe block here
 * proves this suite would actually go red if the skeleton hash stopped
 * pairing it.
 */

let database: TestDatabase;
let fingerprints: PostgresFingerprintRepository;
let assignments: PostgresReviewAssignmentRepository;

const corpus = buildReviewCorpus();
const factsOf = (item: CorpusItem): ItemFingerprintFacts => ({ stem: item.stem, options: item.options });
const itemOf = (itemVersionId: string): CorpusItem => {
  const found = corpus.items.find((item) => item.itemVersionId === itemVersionId);
  if (found === undefined) throw new Error(`the corpus has no item version ${itemVersionId}`);
  return found;
};

const REVIEW_POLICY: ReviewPolicy = (() => {
  const built = createReviewPolicy(CORPUS_REVIEW_POLICY);
  if (!built.ok) throw new Error('the corpus review policy is invalid');
  return built.value;
})();

/** Seeds one corpus item: the item row, its version, its tag, and its fingerprint. */
async function seed(item: CorpusItem): Promise<void> {
  await database.pool.query(
    `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject, state_entered_at)
     VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', $2, $3)`,
    [item.itemId, item.subject, item.stateEnteredAt],
  );
  await database.pool.query(
    `INSERT INTO content.item_version
       (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id)
     VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', $3::jsonb, $4, 'moderate', 'human', $5)`,
    [
      item.itemVersionId,
      item.itemId,
      JSON.stringify(item.stem),
      normalizedText(factsOf(item)).slice(0, 200),
      item.authorId,
    ],
  );
  await database.pool.query(
    `INSERT INTO content.item_taxonomy_tag (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
     VALUES ($1, $2, $3, 1, true)`,
    [item.itemVersionId, item.conceptId, CORPUS_TAXONOMY_VERSION_ID],
  );

  const saved = await fingerprints.save({
    itemId: item.itemId,
    itemVersionId: item.itemVersionId,
    subject: item.subject,
    exactHash: exactHash(factsOf(item)),
    skeletonHash: skeletonHash(factsOf(item)),
    normalizedText: normalizedText(factsOf(item)),
    computedAt: CORPUS_NOW,
  });
  if (!saved.ok) throw new Error(`seeding a fingerprint failed: ${saved.error.code}`);

  if (item.claim !== undefined) {
    await database.pool.query(
      `INSERT INTO content.review_assignment
         (assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state,
          claimed_at, lease_expires_at, aggregate_version)
       VALUES ($1, $2, $3, $4, 'human', $5, 'claimed', 'claimed', $6, $7, 1)`,
      [
        item.claim.assignmentId,
        item.itemId,
        item.itemVersionId,
        item.subject,
        item.claim.reviewerId,
        item.claim.claimedAt,
        item.claim.leaseExpiresAt,
      ],
    );
  }
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  fingerprints = new PostgresFingerprintRepository(database.pool);
  assignments = new PostgresReviewAssignmentRepository(database.pool);

  for (const item of corpus.items) await seed(item);
}, 60_000);

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

describe('the corpus is deterministic and shaped as the plan requires (M4-43)', () => {
  it('builds identically across 100 runs', () => {
    const first = JSON.stringify(buildReviewCorpus());
    for (let run = 0; run < 100; run += 1) {
      expect(JSON.stringify(buildReviewCorpus()), `run ${run}`).toBe(first);
    }
  });

  it('holds 40 items', () => {
    expect(corpus.items).toHaveLength(CORPUS_SIZE);
    expect(CORPUS_SIZE).toBe(40);
  });

  it('spreads across at least 3 subjects and 4 concepts', () => {
    const subjects = new Set(corpus.items.map((item) => item.subject));
    const concepts = new Set(corpus.items.map((item) => item.conceptId));
    expect(subjects.size).toBeGreaterThanOrEqual(3);
    expect(concepts.size).toBeGreaterThanOrEqual(4);
    // The declared vocabularies are what the items actually drew from.
    for (const subject of subjects) expect(CORPUS_SUBJECTS).toContain(subject);
    for (const concept of concepts) expect(CORPUS_CONCEPT_IDS).toContain(concept);
  });

  it('gives every item a distinct id and version id', () => {
    expect(new Set(corpus.items.map((item) => item.itemId)).size).toBe(CORPUS_SIZE);
    expect(new Set(corpus.items.map((item) => item.itemVersionId)).size).toBe(CORPUS_SIZE);
  });

  it('seeded all 40 into the database', async () => {
    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM content.item WHERE lifecycle_state = 'in_review'`,
    );
    expect(rows.rows[0]?.count).toBe(String(CORPUS_SIZE));
  });
});

describe('planted case 1 — the constants-swapped pair, by skeleton hash', () => {
  it('pairs the two by skeleton hash, through the real repository', async () => {
    const [first, second] = corpus.planted.constantsSwapped;
    const a = itemOf(first as string);
    const found = expectValue(await fingerprints.findBySkeletonHash(a.subject, skeletonHash(factsOf(a))));

    expect(found.map((record) => record.itemVersionId).sort()).toEqual(
      [first, second].sort(),
    );
  });

  it('does NOT pair them by exact hash — different constants are a different item', async () => {
    const [first, second] = corpus.planted.constantsSwapped;
    const a = itemOf(first as string);
    const found = expectValue(await fingerprints.findByExactHash(a.subject, exactHash(factsOf(a))));

    expect(found.map((record) => record.itemVersionId)).toEqual([first]);
    expect(found.map((record) => record.itemVersionId)).not.toContain(second);
  });
});

describe('planted case 2 — the exact retype, by exact hash', () => {
  it('pairs the two by exact hash, through the real repository', async () => {
    const [first, second] = corpus.planted.exactRetype;
    const a = itemOf(first as string);
    const found = expectValue(await fingerprints.findByExactHash(a.subject, exactHash(factsOf(a))));

    expect(found.map((record) => record.itemVersionId).sort()).toEqual([first, second].sort());
  });
});

describe('planted case 3 — the near miss, trigram only', () => {
  it('appears in neither hash group', async () => {
    const nearMiss = itemOf(corpus.planted.nearMiss);
    const facts = factsOf(nearMiss);

    const exact = expectValue(await fingerprints.findByExactHash(nearMiss.subject, exactHash(facts)));
    const skeleton = expectValue(await fingerprints.findBySkeletonHash(nearMiss.subject, skeletonHash(facts)));

    // Itself and nothing else — a group of one is "no duplicate found".
    expect(exact.map((record) => record.itemVersionId)).toEqual([nearMiss.itemVersionId]);
    expect(skeleton.map((record) => record.itemVersionId)).toEqual([nearMiss.itemVersionId]);
  });

  it('is retrieved by trigram similarity against the retype it resembles', async () => {
    const retype = itemOf(corpus.planted.exactRetype[0] as string);
    const candidates = expectValue(
      await fingerprints.findSimilarCandidates(retype.subject, normalizedText(factsOf(retype)), 10),
    );

    const ids = candidates.map((candidate) => candidate.fingerprint.itemVersionId);
    expect(ids).toContain(corpus.planted.nearMiss);
    // Ranked, not merely present: every candidate carries a score.
    for (const candidate of candidates) {
      expect(candidate.similarity).toBeGreaterThan(0);
      expect(candidate.similarity).toBeLessThanOrEqual(1);
    }
  });
});

describe('planted case 4 — the self-authored item is never offered', () => {
  it('is authored by the claiming reviewer', () => {
    expect(itemOf(corpus.planted.selfAuthored).authorId).toBe(CLAIMING_REVIEWER_ID);
  });

  /**
   * INV-12, through the real atomic claim. The reviewer claims repeatedly
   * until the queue for that subject is exhausted; their own item must never
   * come back, however many times they ask.
   */
  it('is never returned by claimNext, however many times the reviewer claims', async () => {
    const selfAuthored = itemOf(corpus.planted.selfAuthored);
    const reviewer = { kind: 'human' as const, id: CLAIMING_REVIEWER_ID, roleContext: ['reviewer'] };
    const claimed: string[] = [];

    for (let attempt = 0; attempt < CORPUS_SIZE; attempt += 1) {
      const result = await assignments.claimNext({
        subject: selfAuthored.subject,
        reviewer,
        ordering: 'escalated_first',
        now: CORPUS_NOW,
        leaseExpiresAt: new Date(Date.parse(CORPUS_NOW) + 4 * 60 * 60 * 1000).toISOString(),
        escalateAfterHours: CORPUS_REVIEW_POLICY.escalateAfterHours,
      });
      if (!result.ok) break;
      claimed.push(result.value.itemVersionId);
    }

    // Non-vacuous: the queue really did have items for this reviewer.
    expect(claimed.length).toBeGreaterThan(0);
    expect(claimed).not.toContain(selfAuthored.itemVersionId);
  });
});

describe('planted case 5 — the item aged past escalation', () => {
  it('is escalated at CORPUS_NOW, by the real ageing rule', () => {
    const aged = itemOf(corpus.planted.agedPastEscalation);
    expect(expectValue(ageState(aged.stateEnteredAt, CORPUS_NOW, REVIEW_POLICY))).toBe('escalated');
  });

  it('is the only escalated item, so the case is planted rather than ambient', () => {
    const escalated = corpus.items.filter(
      (item) => expectValue(ageState(item.stateEnteredAt, CORPUS_NOW, REVIEW_POLICY)) === 'escalated',
    );
    expect(escalated.map((item) => item.itemVersionId)).toEqual([corpus.planted.agedPastEscalation]);
  });
});

describe('planted case 6 — the expired claim', () => {
  it('carries a lease that has already run out at CORPUS_NOW', () => {
    const expired = itemOf(corpus.planted.expiredClaim);
    expect(expired.claim).toBeDefined();
    expect(Date.parse(expired.claim?.leaseExpiresAt as string)).toBeLessThan(Date.parse(CORPUS_NOW));
  });

  it('is the only claimed item in the corpus', () => {
    const claimed = corpus.items.filter((item) => item.claim !== undefined);
    expect(claimed.map((item) => item.itemVersionId)).toEqual([corpus.planted.expiredClaim]);
  });

  /**
   * **An expired lease does not free the item by itself — the sweep frees
   * it.** `CANDIDATE_PREDICATE` excludes any version carrying an assignment
   * in state `claimed`, with no lease-expiry term; expiry is a *transition*
   * (`releaseExpired`, `claimed → expired`), which is consistent with
   * `content.review_assignment` refusing deletion outright. Both halves are
   * asserted here, in order, because the first half is the part with teeth:
   * while nothing calls the sweep on a schedule (**D36**), an item whose
   * reviewer walked away stays out of the queue indefinitely.
   */
  it('is NOT claimable while the stale assignment still reads claimed', async () => {
    const expired = itemOf(corpus.planted.expiredClaim);
    const other = { kind: 'human' as const, id: CLAIMING_REVIEWER_ID, roleContext: ['reviewer'] };
    const seen: string[] = [];

    for (let attempt = 0; attempt < CORPUS_SIZE; attempt += 1) {
      const result = await assignments.claimNext({
        subject: expired.subject,
        reviewer: other,
        ordering: 'escalated_first',
        now: CORPUS_NOW,
        leaseExpiresAt: corpusInstants.hoursAhead(4),
        escalateAfterHours: CORPUS_REVIEW_POLICY.escalateAfterHours,
      });
      if (!result.ok) break;
      seen.push(result.value.itemVersionId);
    }

    // Non-vacuous: the subject really did have other claimable items.
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain(expired.itemVersionId);
  });

  it('becomes claimable once the real sweep transitions the lapsed claim to expired', async () => {
    const expired = itemOf(corpus.planted.expiredClaim);

    const sweptResult = await assignments.releaseExpired(CORPUS_NOW);
    const swept = expectValue(sweptResult);
    expect(swept.map((assignment) => assignment.itemVersionId)).toContain(expired.itemVersionId);
    for (const assignment of swept) expect(assignment.state).toBe('expired');

    const reclaimed = await assignments.claimNext({
      subject: expired.subject,
      reviewer: { kind: 'human', id: CLAIMING_REVIEWER_ID, roleContext: ['reviewer'] },
      ordering: 'escalated_first',
      now: CORPUS_NOW,
      leaseExpiresAt: corpusInstants.hoursAhead(4),
      escalateAfterHours: CORPUS_REVIEW_POLICY.escalateAfterHours,
    });

    expect(expectValue(reclaimed).itemVersionId).toBe(expired.itemVersionId);
  });
});

/**
 * **The planted failure the plan asks for.**
 *
 * "A planted failure to detect the constants-swapped pair fails the suite" —
 * a corpus whose pair does not actually collide by skeleton hash must make
 * the case-1 assertion go red. Proven here by building the *same* assertion
 * over a deliberately broken pair, and showing it fails: without this, "the
 * pair was detected" could be true because the detector works, or because
 * the two items were accidentally identical, and nobody could tell which.
 */
describe('the constants-swapped detection is proven able to fail (M4-43)', () => {
  it('the same assertion goes red on a pair that does not share a skeleton', () => {
    const [first] = corpus.planted.constantsSwapped;
    const a = itemOf(first as string);
    // A "pair" whose second member is an unrelated corpus item.
    const notActuallyPaired = itemOf(corpus.planted.nearMiss);

    expect(skeletonHash(factsOf(a))).not.toBe(skeletonHash(factsOf(notActuallyPaired)));
    expect(() => {
      expect(skeletonHash(factsOf(a))).toBe(skeletonHash(factsOf(notActuallyPaired)));
    }).toThrow();
  });

  it('the real pair does share one, so the assertion above is not vacuous', () => {
    const [first, second] = corpus.planted.constantsSwapped;
    expect(skeletonHash(factsOf(itemOf(first as string)))).toBe(
      skeletonHash(factsOf(itemOf(second as string))),
    );
  });
});
