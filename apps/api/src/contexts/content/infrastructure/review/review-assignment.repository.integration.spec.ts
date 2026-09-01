import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, DATABASE_URL, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import type { ClaimNextReviewAssignment } from '../../domain/repository-ports.js';
import { ESCALATED_FIRST_QUERY, PostgresReviewAssignmentRepository } from './review-assignment.repository.js';
import { PostgresTransactionRunner } from '../transaction-runner.js';
import { orderCandidates, type QueueOrderingCandidate } from '../../domain/review/queue-ordering.js';

let database: TestDatabase;
let repository: PostgresReviewAssignmentRepository;
let runner: PostgresTransactionRunner;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresReviewAssignmentRepository(database.pool);
  runner = new PostgresTransactionRunner(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-a000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const SUBJECT = 'physics';
const REVIEWER = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
const AUTHOR_ID = freshUuid();

/** Inserts an item + its one version directly, bypassing the domain — the repository is the thing under test. */
async function seedInReviewItemVersion(
  options: {
    readonly authorId?: string;
    readonly editorId?: string;
    readonly subject?: string;
    readonly stateEnteredAt?: Date;
  } = {},
): Promise<{ itemId: string; itemVersionId: string }> {
  const itemId = freshUuid();
  const itemVersionId = freshUuid();
  await database.pool.query(
    `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject, state_entered_at)
     VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', $2, $3)`,
    [itemId, options.subject ?? SUBJECT, options.stateEnteredAt ?? new Date()],
  );
  await database.pool.query(
    `INSERT INTO content.item_version
       (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id, edited_by_kind, edited_by_id)
     VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3, $4, $5)`,
    [
      itemVersionId,
      itemId,
      options.authorId ?? AUTHOR_ID,
      options.editorId === undefined ? null : 'human',
      options.editorId ?? null,
    ],
  );
  return { itemId, itemVersionId };
}

function claimCriteria(overrides: Partial<ClaimNextReviewAssignment> = {}): ClaimNextReviewAssignment {
  const now = new Date().toISOString();
  return {
    subject: SUBJECT,
    reviewer: REVIEWER,
    ordering: 'oldest_first',
    now,
    leaseExpiresAt: new Date(Date.parse(now) + 60 * 60 * 1000).toISOString(),
    escalateAfterHours: 72,
    ...overrides,
  };
}

describe('claimNext — the atomic claim (M4-18)', () => {
  it('claims the oldest eligible candidate and inserts the assignment', async () => {
    const { itemId, itemVersionId } = await seedInReviewItemVersion();
    const claimed = expectValue(await repository.claimNext(claimCriteria()));
    expect(claimed.itemId).toBe(itemId);
    expect(claimed.itemVersionId).toBe(itemVersionId);
    expect(claimed.state).toBe('claimed');
    expect(claimed.kind).toBe('claimed');
    expect(claimed.reviewer.id).toBe(REVIEWER.id);
  });

  it('is invisible to a second claimant once claimed', async () => {
    const subject = `invisible-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    expectValue(await repository.claimNext(claimCriteria({ subject })));

    const other = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const refused = await repository.claimNext(claimCriteria({ subject, reviewer: other }));
    expect(expectError(refused).code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND when the subject has no in_review candidate', async () => {
    const emptySubject = `empty-${freshUuid()}`;
    const refused = await repository.claimNext(claimCriteria({ subject: emptySubject }));
    expect(expectError(refused).code).toBe('NOT_FOUND');
  });

  it('never returns the author’s own item, on either ordering', async () => {
    for (const ordering of ['oldest_first', 'escalated_first'] as const) {
      const subject = `self-${ordering}-${freshUuid()}`;
      const asReviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
      await seedInReviewItemVersion({ authorId: asReviewer.id, subject });

      const refused = await repository.claimNext(
        claimCriteria({ subject, reviewer: asReviewer, ordering }),
      );
      expect(expectError(refused).code).toBe('NOT_FOUND');
    }
  });

  it('never returns a version the reviewer edited — the predicate misses it, the re-check catches it', async () => {
    const subject = `edited-${freshUuid()}`;
    const editor = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    await seedInReviewItemVersion({ editorId: editor.id, subject });

    const refused = await repository.claimNext(claimCriteria({ subject, reviewer: editor }));
    const error = expectError(refused);
    expect(error.code).toBe('PERSISTENCE_REJECTED');
    expect(error.message).toContain('INV-12');
  });

  it('orders by escalation first when asked — derived from stateEnteredAt, never from content.review_escalation (M4-46)', async () => {
    const subject = `escalation-${freshUuid()}`;
    const now = new Date();
    await seedInReviewItemVersion({ subject, stateEnteredAt: new Date(now.getTime() - 1_000) });
    const overdue = await seedInReviewItemVersion({
      subject,
      stateEnteredAt: new Date(now.getTime() - 73 * 60 * 60 * 1000),
    });

    const claimed = expectValue(
      await repository.claimNext(
        claimCriteria({ subject, ordering: 'escalated_first', now: now.toISOString(), escalateAfterHours: 72 }),
      ),
    );
    expect(claimed.itemVersionId).toBe(overdue.itemVersionId);

    // The assertion that fails before M4-46: content.review_escalation is
    // never written to here, and the old ordering read exactly this table —
    // which only the unscheduled sweep (M4-31) ever populates.
    const escalationRows = await database.pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM content.review_escalation WHERE item_version_id = $1`,
      [overdue.itemVersionId],
    );
    expect(Number(escalationRows.rows[0]!.n)).toBe(0);
  });

  it('concept-batches: the reviewer’s last-decided concept outranks a chronologically older item outside it (M4-46)', async () => {
    const subject = `batch-${freshUuid()}`;
    const now = new Date();
    const reviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const batchConcept = freshUuid();
    const otherConcept = freshUuid();
    const taxonomyVersionId = freshUuid();

    // The reviewer's most recent decision, on a version tagged with the
    // "batch" concept — seeded directly, decision recording is another
    // task's concern here.
    const decidedVersion = await seedInReviewItemVersion({ subject });
    await database.pool.query(
      `INSERT INTO content.item_taxonomy_tag (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, $2, $3, 1, true)`,
      [decidedVersion.itemVersionId, batchConcept, taxonomyVersionId],
    );
    await database.pool.query(
      `INSERT INTO content.review_decision
         (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
       VALUES ($1, 'item_version', $2, 'human', $3, 'approve', $4::timestamptz)`,
      [freshUuid(), decidedVersion.itemVersionId, reviewer.id, now.toISOString()],
    );

    // An older candidate outside the batch concept, and a younger one inside
    // it. Pure oldest-first would claim the older one; concept-batch (which
    // this ordering checks before age) must claim the younger, matching
    // concept instead.
    const older = await seedInReviewItemVersion({ subject, stateEnteredAt: new Date(now.getTime() - 10_000) });
    await database.pool.query(
      `INSERT INTO content.item_taxonomy_tag (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, $2, $3, 1, true)`,
      [older.itemVersionId, otherConcept, taxonomyVersionId],
    );
    const younger = await seedInReviewItemVersion({ subject, stateEnteredAt: new Date(now.getTime() - 5_000) });
    await database.pool.query(
      `INSERT INTO content.item_taxonomy_tag (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, $2, $3, 1, true)`,
      [younger.itemVersionId, batchConcept, taxonomyVersionId],
    );

    const claimed = expectValue(
      await repository.claimNext(
        claimCriteria({ subject, reviewer, ordering: 'escalated_first', now: now.toISOString(), escalateAfterHours: 72 }),
      ),
    );
    expect(claimed.itemVersionId).toBe(younger.itemVersionId);
  });

  it('two overlapping transactions on two separate connections claim two different items', async () => {
    const subject = `concurrent-${freshUuid()}`;
    const first = await seedInReviewItemVersion({ subject, stateEnteredAt: new Date(Date.now() - 10_000) });
    const second = await seedInReviewItemVersion({ subject, stateEnteredAt: new Date() });

    const poolA = new Pool({ connectionString: DATABASE_URL, max: 1 });
    const poolB = new Pool({ connectionString: DATABASE_URL, max: 1 });
    const repoA = new PostgresReviewAssignmentRepository(poolA);
    const repoB = new PostgresReviewAssignmentRepository(poolB);
    const reviewerA = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const reviewerB = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };

    try {
      const [claimA, claimB] = await Promise.all([
        repoA.claimNext(claimCriteria({ subject, reviewer: reviewerA })),
        repoB.claimNext(claimCriteria({ subject, reviewer: reviewerB })),
      ]);

      const a = expectValue(claimA);
      const b = expectValue(claimB);
      expect(a.itemVersionId).not.toBe(b.itemVersionId);
      expect([a.itemVersionId, b.itemVersionId].sort()).toEqual(
        [first.itemVersionId, second.itemVersionId].sort(),
      );
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  /**
   * The test above proves `SKIP LOCKED` throughput — two claimants get two
   * different items. That is not the invariant. The invariant is that **one**
   * item cannot be held twice, and with two items on the table a passing
   * result is compatible with an implementation that hands the same row to
   * both. So: one item, two claimants.
   *
   * Deterministic under any interleaving. Row locks are exclusive, so of the
   * two `SELECT … FOR UPDATE OF v SKIP LOCKED` statements exactly one
   * acquires the candidate and the other skips it, leaving an empty candidate
   * set — a clean `NOT_FOUND`, never an exception and never a second row.
   *
   * **What this test pins, proven by planting:** removing `SKIP LOCKED` from
   * `claimNext` turns the loser's outcome from `NOT_FOUND` into
   * `PERSISTENCE_REJECTED` — "duplicate key value violates unique constraint
   * review_assignment_one_live_per_version". So the two mechanisms are doing
   * two different jobs, and this asserts the second: the *index* is what
   * stops the double claim, and `SKIP LOCKED` is what makes the refusal a
   * clean answer rather than a raised exception. The test below pins the
   * index itself, which no other test in `apps/api/src` named.
   */
  it('two concurrent claims against ONE item: exactly one wins, the other is cleanly refused', async () => {
    const subject = `one-item-${freshUuid()}`;
    const only = await seedInReviewItemVersion({ subject });

    const poolA = new Pool({ connectionString: DATABASE_URL, max: 1 });
    const poolB = new Pool({ connectionString: DATABASE_URL, max: 1 });
    const repoA = new PostgresReviewAssignmentRepository(poolA);
    const repoB = new PostgresReviewAssignmentRepository(poolB);
    const reviewerA = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const reviewerB = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };

    try {
      const [claimA, claimB] = await Promise.all([
        repoA.claimNext(claimCriteria({ subject, reviewer: reviewerA })),
        repoB.claimNext(claimCriteria({ subject, reviewer: reviewerB })),
      ]);

      const won = [claimA, claimB].filter((outcome) => outcome.ok);
      const refused = [claimA, claimB].filter((outcome) => !outcome.ok);
      expect(won).toHaveLength(1);
      expect(refused).toHaveLength(1);
      expect(expectError(refused[0]!).code).toBe('NOT_FOUND');
      expect(expectValue(won[0]!).itemVersionId).toBe(only.itemVersionId);

      // And the table agrees: one live row for that version, not two.
      const live = await database.pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM content.review_assignment
          WHERE item_version_id = $1 AND state = 'claimed'`,
        [only.itemVersionId],
      );
      expect(Number(live.rows[0]!.count)).toBe(1);
    } finally {
      await poolA.end();
      await poolB.end();
    }
  });

  /**
   * The structural guarantee underneath the claim, asserted directly rather
   * than inferred from the repository behaving well: `review_assignment_one_live_per_version`
   * is a partial unique index on `(item_version_id) WHERE state = 'claimed'`.
   * Nothing else in `apps/api/src` names it, so nothing else notices if a
   * later migration drops it — this test does.
   */
  it('the partial unique index refuses a second LIVE assignment for one version, by raw SQL', async () => {
    const subject = `index-${freshUuid()}`;
    const { itemId, itemVersionId } = await seedInReviewItemVersion({ subject });
    expectValue(await repository.claimNext(claimCriteria({ subject })));

    let message = '';
    try {
      await database.pool.query(
        `INSERT INTO content.review_assignment
           (assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state,
            claimed_at, lease_expires_at)
         VALUES ($1, $2, $3, $4, 'human', $5, 'claimed', 'claimed', now(), now() + interval '1 hour')`,
        [freshUuid(), itemId, itemVersionId, subject, freshUuid()],
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain('review_assignment_one_live_per_version');
  });

  it('but permits released and decided rows for the same version — history accumulates', async () => {
    const subject = `history-${freshUuid()}`;
    const { itemId, itemVersionId } = await seedInReviewItemVersion({ subject });
    expectValue(await repository.claimNext(claimCriteria({ subject })));

    // The index is partial: only `state = 'claimed'` rows are unique per
    // version. A version reviewed, released, reclaimed and decided carries a
    // row for each, which is the history the queue's own audit depends on.
    for (const [state, stamp] of [
      ['released', 'released_at'],
      ['decided', 'decided_at'],
      ['expired', null],
    ] as const) {
      await database.pool.query(
        `INSERT INTO content.review_assignment
           (assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state,
            claimed_at, lease_expires_at${stamp === null ? '' : `, ${stamp}`})
         VALUES ($1, $2, $3, $4, 'human', $5, 'claimed', $6, now(), now() + interval '1 hour'${
           stamp === null ? '' : ', now()'
         })`,
        [freshUuid(), itemId, itemVersionId, subject, freshUuid(), state],
      );
    }

    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM content.review_assignment WHERE item_version_id = $1`,
      [itemVersionId],
    );
    expect(Number(rows.rows[0]!.count)).toBe(4);
  });
});

/**
 * The M4-23 pattern applied to M4-46: run the same candidate set through the
 * SQL ordering (`ESCALATED_FIRST_QUERY`, with its `LIMIT 1 FOR UPDATE …`
 * tail stripped so every eligible row comes back at once, in order) and
 * through `domain/review/queue-ordering.ts`'s `orderCandidates` — the
 * declared TypeScript specification for exactly the three terms this SQL
 * implements (confidence stays `Fail — blocked`, so every fixture's
 * `blockingCount`/`warningCount`/`duplicateCandidateCount` is 0, tying that
 * term out so it never breaks a comparison the SQL cannot make anyway).
 *
 * The two "planted violation" tests below do not touch the production
 * query — they run a locally mutated copy of it and show the parity
 * assertion is capable of catching exactly the class of bug it exists to
 * catch, per ENGINEERING-HANDBOOK §5: every architectural rule is proven
 * able to fail.
 */
describe('the SQL ordering agrees with the TypeScript specification (M4-46, M4-23’s pattern)', () => {
  const ALL_ROWS_IN_ORDER_QUERY = ESCALATED_FIRST_QUERY.replace(
    /\n\s*LIMIT 1\n\s*FOR UPDATE OF v SKIP LOCKED\s*$/u,
    '',
  );

  async function tagPrimaryConcept(itemVersionId: string, conceptId: string, taxonomyVersionId: string): Promise<void> {
    await database.pool.query(
      `INSERT INTO content.item_taxonomy_tag (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, $2, $3, 1, true)`,
      [itemVersionId, conceptId, taxonomyVersionId],
    );
  }

  it('agrees on the full ordering over a fixture corpus mixing escalation and concept batching', async () => {
    const subject = `parity-${freshUuid()}`;
    const now = new Date();
    const reviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const conceptX = freshUuid();
    const conceptY = freshUuid();
    const taxonomyVersionId = freshUuid();

    const decided = await seedInReviewItemVersion({ subject });
    await tagPrimaryConcept(decided.itemVersionId, conceptX, taxonomyVersionId);
    await database.pool.query(
      `INSERT INTO content.review_decision
         (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
       VALUES ($1, 'item_version', $2, 'human', $3, 'approve', $4::timestamptz)`,
      [freshUuid(), decided.itemVersionId, reviewer.id, now.toISOString()],
    );

    const escalatedNoMatch = await seedInReviewItemVersion({
      subject,
      stateEnteredAt: new Date(now.getTime() - 80 * 60 * 60 * 1000),
    });
    await tagPrimaryConcept(escalatedNoMatch.itemVersionId, conceptY, taxonomyVersionId);

    const freshMatch = await seedInReviewItemVersion({
      subject,
      stateEnteredAt: new Date(now.getTime() - 5 * 60 * 60 * 1000),
    });
    await tagPrimaryConcept(freshMatch.itemVersionId, conceptX, taxonomyVersionId);

    const freshNoMatch = await seedInReviewItemVersion({
      subject,
      stateEnteredAt: new Date(now.getTime() - 1 * 60 * 60 * 1000),
    });
    await tagPrimaryConcept(freshNoMatch.itemVersionId, conceptY, taxonomyVersionId);

    const fixtures = [decided, escalatedNoMatch, freshMatch, freshNoMatch];
    const conceptById = new Map([
      [decided.itemVersionId, conceptX],
      [escalatedNoMatch.itemVersionId, conceptY],
      [freshMatch.itemVersionId, conceptX],
      [freshNoMatch.itemVersionId, conceptY],
    ]);
    const stateEnteredAtById = new Map([
      [decided.itemVersionId, now],
      [escalatedNoMatch.itemVersionId, new Date(now.getTime() - 80 * 60 * 60 * 1000)],
      [freshMatch.itemVersionId, new Date(now.getTime() - 5 * 60 * 60 * 1000)],
      [freshNoMatch.itemVersionId, new Date(now.getTime() - 1 * 60 * 60 * 1000)],
    ]);
    const escalateAfterHours = 72;

    const sqlOrder = await database.pool.query<{ item_version_id: string }>(ALL_ROWS_IN_ORDER_QUERY, [
      subject,
      reviewer.id,
      reviewer.id,
      now.toISOString(),
      escalateAfterHours,
    ]);
    const sqlOrderIds = sqlOrder.rows.map((row) => row.item_version_id);

    const candidates: QueueOrderingCandidate[] = fixtures.map((f) => {
      const stateEnteredAt = stateEnteredAtById.get(f.itemVersionId)!;
      const ageHours = (now.getTime() - stateEnteredAt.getTime()) / (60 * 60 * 1000);
      return {
        itemVersionId: f.itemVersionId,
        primaryConceptId: conceptById.get(f.itemVersionId)!,
        escalated: ageHours >= escalateAfterHours,
        blockingCount: 0,
        warningCount: 0,
        duplicateCandidateCount: 0,
        stateEnteredAt: stateEnteredAt.toISOString(),
      };
    });
    const specOrderIds = orderCandidates(candidates, { lastDecidedConcept: conceptX }).map((c) => c.itemVersionId);

    expect(sqlOrderIds).toEqual(specOrderIds);
  });

  it('is red on a planted off-by-one in the escalation threshold', async () => {
    const subject = `parity-threshold-${freshUuid()}`;
    const now = new Date();
    const reviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const conceptX = freshUuid();
    const conceptY = freshUuid();
    const taxonomyVersionId = freshUuid();

    // Seeded under its own subject so it never itself competes as a
    // candidate for `subject` — only the two ordering fixtures below do.
    const decided = await seedInReviewItemVersion({ subject: `${subject}-decided` });
    await tagPrimaryConcept(decided.itemVersionId, conceptX, taxonomyVersionId);
    await database.pool.query(
      `INSERT INTO content.review_decision
         (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
       VALUES ($1, 'item_version', $2, 'human', $3, 'approve', $4::timestamptz)`,
      [freshUuid(), decided.itemVersionId, reviewer.id, now.toISOString()],
    );

    // Truly escalated (80h, past the real 72h threshold), concept Y — no match.
    const trulyEscalated = await seedInReviewItemVersion({
      subject,
      stateEnteredAt: new Date(now.getTime() - 80 * 60 * 60 * 1000),
    });
    await tagPrimaryConcept(trulyEscalated.itemVersionId, conceptY, taxonomyVersionId);

    // 71.5h old — correctly NOT escalated under a 72h threshold, concept X
    // (matches). A threshold off by even one hour (71h) misclassifies it as
    // escalated, which — because concept-match is compared next, inside the
    // escalated bucket — jumps it ahead of trulyEscalated in the broken
    // ordering, even though the correct ordering puts trulyEscalated first.
    const boundary = await seedInReviewItemVersion({
      subject,
      stateEnteredAt: new Date(now.getTime() - 71.5 * 60 * 60 * 1000),
    });
    await tagPrimaryConcept(boundary.itemVersionId, conceptX, taxonomyVersionId);

    const correctOrder = await database.pool.query<{ item_version_id: string }>(ALL_ROWS_IN_ORDER_QUERY, [
      subject,
      reviewer.id,
      reviewer.id,
      now.toISOString(),
      72,
    ]);
    expect(correctOrder.rows.map((r) => r.item_version_id)).toEqual([
      trulyEscalated.itemVersionId,
      boundary.itemVersionId,
    ]);

    const brokenQuery = ALL_ROWS_IN_ORDER_QUERY.replace(
      "($5 * interval '1 hour')",
      "(($5 - 1) * interval '1 hour')",
    );
    const brokenOrder = await database.pool.query<{ item_version_id: string }>(brokenQuery, [
      subject,
      reviewer.id,
      reviewer.id,
      now.toISOString(),
      72,
    ]);
    expect(brokenOrder.rows.map((r) => r.item_version_id)).toEqual([
      boundary.itemVersionId,
      trulyEscalated.itemVersionId,
    ]);
    expect(brokenOrder.rows.map((r) => r.item_version_id)).not.toEqual(
      correctOrder.rows.map((r) => r.item_version_id),
    );
  });

  it('is red on a planted wrong-join in the concept-batch term', async () => {
    const subject = `parity-join-${freshUuid()}`;
    const now = new Date();
    const reviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const conceptX = freshUuid();
    const conceptY = freshUuid();
    const taxonomyVersionId = freshUuid();

    const decided = await seedInReviewItemVersion({ subject });
    await tagPrimaryConcept(decided.itemVersionId, conceptX, taxonomyVersionId);
    await database.pool.query(
      `INSERT INTO content.review_decision
         (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
       VALUES ($1, 'item_version', $2, 'human', $3, 'approve', $4::timestamptz)`,
      [freshUuid(), decided.itemVersionId, reviewer.id, now.toISOString()],
    );

    // A candidate whose PRIMARY concept is Y (no match) but which also
    // carries a non-primary tag of X (matches). The correct join keys off
    // `vt.is_primary`, so this candidate must not match and must appear
    // exactly once.
    const candidate = await seedInReviewItemVersion({
      subject,
      stateEnteredAt: new Date(now.getTime() - 10 * 60 * 60 * 1000),
    });
    await tagPrimaryConcept(candidate.itemVersionId, conceptY, taxonomyVersionId);
    await database.pool.query(
      `INSERT INTO content.item_taxonomy_tag (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, $2, $3, 1, false)`,
      [candidate.itemVersionId, conceptX, taxonomyVersionId],
    );

    const correctOrder = await database.pool.query<{ item_version_id: string }>(ALL_ROWS_IN_ORDER_QUERY, [
      subject,
      reviewer.id,
      reviewer.id,
      now.toISOString(),
      72,
    ]);
    expect(correctOrder.rows.map((r) => r.item_version_id)).toEqual([
      decided.itemVersionId,
      candidate.itemVersionId,
    ]);

    const brokenQuery = ALL_ROWS_IN_ORDER_QUERY.replace(
      'ON vt.item_version_id = v.item_version_id AND vt.is_primary',
      'ON vt.item_version_id = v.item_version_id',
    );
    const brokenOrder = await database.pool.query<{ item_version_id: string }>(brokenQuery, [
      subject,
      reviewer.id,
      reviewer.id,
      now.toISOString(),
      72,
    ]);
    // The candidate's non-primary tag now also joins, duplicating its row —
    // a shape the TypeScript specification (one candidate in, one candidate
    // out) can never produce, so the parity assertion catches it as a count
    // mismatch as surely as it would catch a wrong order.
    expect(brokenOrder.rows.length).not.toBe(correctOrder.rows.length);
    expect(brokenOrder.rows.map((r) => r.item_version_id)).not.toEqual(
      correctOrder.rows.map((r) => r.item_version_id),
    );
  });

  it('leaves the atomic-claim race test (M4-18) unaffected — one locking statement, unchanged', async () => {
    // Not a repeat of the M4-18 race tests above; this documents that this
    // describe block never calls claimNext with a lock — every query here is
    // the LIMIT/FOR-UPDATE-stripped read variant, so it cannot interfere
    // with or substitute for the real atomic claim under test elsewhere in
    // this file.
    expect(ESCALATED_FIRST_QUERY).toContain('FOR UPDATE OF v SKIP LOCKED');
    expect(ESCALATED_FIRST_QUERY).toContain('LIMIT 1');
  });
});

describe('releaseExpired — every lease past expiry, idempotent (M4-18)', () => {
  it('releases a claim whose lease has passed and leaves a live one untouched', async () => {
    const subject = `expiry-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimedInThePast = new Date(Date.now() - 5000).toISOString();
    const expiredLease = new Date(Date.now() - 1000).toISOString();
    const claimed = expectValue(
      await repository.claimNext(
        claimCriteria({ subject, now: claimedInThePast, leaseExpiresAt: expiredLease }),
      ),
    );

    await seedInReviewItemVersion({ subject });
    const liveReviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const liveClaim = expectValue(
      await repository.claimNext(
        claimCriteria({
          subject,
          reviewer: liveReviewer,
          leaseExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
        }),
      ),
    );

    const released = expectValue(await repository.releaseExpired(new Date().toISOString()));
    const releasedIds = released.map((assignment) => assignment.assignmentId);
    expect(releasedIds).toContain(claimed.assignmentId);
    expect(releasedIds).not.toContain(liveClaim.assignmentId);

    const stillLive = expectValue(await repository.findById(liveClaim.assignmentId));
    expect(stillLive.state).toBe('claimed');
  });

  it('is idempotent — a second run finds nothing left to release', async () => {
    const subject = `expiry-idem-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimedInThePast = new Date(Date.now() - 5000).toISOString();
    expectValue(
      await repository.claimNext(
        claimCriteria({ subject, now: claimedInThePast, leaseExpiresAt: new Date(Date.now() - 1000).toISOString() }),
      ),
    );

    const releaseAt = new Date().toISOString();
    const first = expectValue(await repository.releaseExpired(releaseAt));
    expect(first.length).toBeGreaterThan(0);
    const second = expectValue(await repository.releaseExpired(releaseAt));
    expect(second).toEqual([]);
  });

  it('releasing nothing at all is not an error', async () => {
    const result = expectValue(await repository.releaseExpired('2000-01-01T00:00:00.000Z'));
    expect(result).toEqual([]);
  });
});

describe('release — the claim/release round trip, optimistic concurrency (M4-18)', () => {
  it('releases a live claim', async () => {
    const subject = `release-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));

    const released = expectValue(
      await repository.release(claimed.assignmentId, new Date().toISOString(), claimed.aggregateVersion),
    );
    expect(released.state).toBe('released');
    expect(released.releasedAt).toBeDefined();
  });

  it('refuses a stale write with Conflict', async () => {
    const subject = `stale-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));

    const refused = await repository.release(claimed.assignmentId, new Date().toISOString(), 99);
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('reports NOT_FOUND for an assignment that does not exist', async () => {
    const refused = await repository.release(freshUuid(), new Date().toISOString(), 1);
    expect(expectError(refused).code).toBe('NOT_FOUND');
  });

  it('refuses a transition the state machine does not permit', async () => {
    const subject = `double-release-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));
    expectValue(await repository.release(claimed.assignmentId, new Date().toISOString(), 1));

    const refused = await repository.release(claimed.assignmentId, new Date().toISOString(), 2);
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });

  it('findById reports NOT_FOUND for an assignment that does not exist', async () => {
    const refused = await repository.findById(freshUuid());
    expect(expectError(refused).code).toBe('NOT_FOUND');
  });

  it('hydrates decidedAt when it is set', async () => {
    const subject = `decided-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));
    await database.pool.query(
      `UPDATE content.review_assignment
          SET state = 'decided', decided_at = now(), aggregate_version = aggregate_version + 1
        WHERE assignment_id = $1`,
      [claimed.assignmentId],
    );

    const found = expectValue(await repository.findById(claimed.assignmentId));
    expect(found.decidedAt).toBeDefined();
  });
});

describe('claimNext — an unexpected persistence fault (M4-18)', () => {
  it('is reported as PERSISTENCE_REJECTED, not thrown', async () => {
    const subject = `fault-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    // A `now` that is not a real instant breaks the `$4::timestamptz` cast
    // inside the escalated_first query itself (M4-46) — the same path a
    // genuine connection fault would take, without needing to fail the
    // database out from under the pool.
    const refused = await repository.claimNext(
      claimCriteria({ subject, ordering: 'escalated_first', now: 'not-a-timestamp' }),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('assign — Content Ops’ push path (M4-27, DEC-M4-9)', () => {
  function assignCriteria(itemVersionId: string, overrides: Partial<Parameters<typeof repository.assign>[0]> = {}) {
    const now = new Date().toISOString();
    return {
      itemVersionId,
      subject: SUBJECT,
      reviewer: REVIEWER,
      now,
      leaseExpiresAt: new Date(Date.parse(now) + 60 * 60 * 1000).toISOString(),
      ...overrides,
    };
  }

  it('creates a live assignment of kind assigned, distinct from a pulled claim', async () => {
    const { itemId, itemVersionId } = await seedInReviewItemVersion();
    const assigned = expectValue(await repository.assign(assignCriteria(itemVersionId)));
    expect(assigned.itemId).toBe(itemId);
    expect(assigned.itemVersionId).toBe(itemVersionId);
    expect(assigned.kind).toBe('assigned');
    expect(assigned.state).toBe('claimed');
    expect(assigned.reviewer.id).toBe(REVIEWER.id);
  });

  it('returns NOT_FOUND for a version that does not exist', async () => {
    const refused = await repository.assign(assignCriteria(freshUuid()));
    expect(expectError(refused).code).toBe('NOT_FOUND');
  });

  it('returns NOT_FOUND for a version whose item is not in_review', async () => {
    const itemId = freshUuid();
    const itemVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject) VALUES ($1, 'SINGLE_CORRECT_MCQ', 'draft', $2)`,
      [itemId, SUBJECT],
    );
    await database.pool.query(
      `INSERT INTO content.item_version
         (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
          authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
      [itemVersionId, itemId, freshUuid()],
    );
    const refused = await repository.assign(assignCriteria(itemVersionId));
    expect(expectError(refused).code).toBe('NOT_FOUND');
  });

  it('refuses assigning the author', async () => {
    const authorReviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const { itemVersionId } = await seedInReviewItemVersion({ authorId: authorReviewer.id });
    const refused = await repository.assign(assignCriteria(itemVersionId, { reviewer: authorReviewer }));
    const error = expectError(refused);
    expect(error.code).toBe('PERSISTENCE_REJECTED');
    expect(error.message).toContain('INV-12');
  });

  it('refuses assigning the editor', async () => {
    const editorReviewer = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const { itemVersionId } = await seedInReviewItemVersion({ editorId: editorReviewer.id });
    const refused = await repository.assign(assignCriteria(itemVersionId, { reviewer: editorReviewer }));
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });

  it('returns CONFLICT when the version already carries a live assignment', async () => {
    const { itemVersionId } = await seedInReviewItemVersion();
    expectValue(await repository.assign(assignCriteria(itemVersionId)));
    const other = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const refused = await repository.assign(assignCriteria(itemVersionId, { reviewer: other }));
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('permits assigning again once the live claim is released — history accumulates', async () => {
    const { itemVersionId } = await seedInReviewItemVersion();
    const first = expectValue(await repository.assign(assignCriteria(itemVersionId)));
    expectValue(await repository.release(first.assignmentId, new Date().toISOString(), first.aggregateVersion));
    const other = { kind: 'human' as const, id: freshUuid(), roleContext: ['reviewer'] };
    const second = expectValue(await repository.assign(assignCriteria(itemVersionId, { reviewer: other })));
    expect(second.state).toBe('claimed');
  });

  it('reports an unexpected write failure as PERSISTENCE_REJECTED, not thrown', async () => {
    const { itemVersionId } = await seedInReviewItemVersion();
    const refused = await repository.assign(
      assignCriteria(itemVersionId, { reviewer: { kind: 'not_a_real_kind' as never, id: freshUuid(), roleContext: [] } }),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('extendLease — pushes the lease forward without a state transition (M4-27)', () => {
  it('extends a live claim’s lease, advancing aggregate_version', async () => {
    const subject = `extend-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));
    const newExpiry = new Date(Date.parse(claimed.leaseExpiresAt) + 60 * 60 * 1000).toISOString();

    const extended = expectValue(
      await repository.extendLease(claimed.assignmentId, newExpiry, claimed.aggregateVersion),
    );
    expect(extended.leaseExpiresAt).toBe(newExpiry);
    expect(extended.state).toBe('claimed');
    expect(extended.aggregateVersion).toBe(claimed.aggregateVersion + 1);
  });

  it('reports NOT_FOUND for an assignment that does not exist', async () => {
    const refused = await repository.extendLease(freshUuid(), new Date().toISOString(), 1);
    expect(expectError(refused).code).toBe('NOT_FOUND');
  });

  it('reports CONFLICT on a stale aggregate_version', async () => {
    const subject = `extend-stale-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));
    const newExpiry = new Date(Date.parse(claimed.leaseExpiresAt) + 60 * 60 * 1000).toISOString();

    const refused = await repository.extendLease(claimed.assignmentId, newExpiry, claimed.aggregateVersion + 5);
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('reports CONFLICT when the assignment is no longer claimed', async () => {
    const subject = `extend-released-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));
    const released = expectValue(
      await repository.release(claimed.assignmentId, new Date().toISOString(), claimed.aggregateVersion),
    );
    const newExpiry = new Date(Date.parse(claimed.leaseExpiresAt) + 60 * 60 * 1000).toISOString();

    const refused = await repository.extendLease(claimed.assignmentId, newExpiry, released.aggregateVersion);
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('reports PERSISTENCE_REJECTED when the new lease does not move forward — the trigger’s own guard', async () => {
    const subject = `extend-backward-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));

    const refused = await repository.extendLease(claimed.assignmentId, claimed.leaseExpiresAt, claimed.aggregateVersion);
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('hasLiveClaim — the withdrawal read, inside a shared transaction (M4-30)', () => {
  it('is false with no claim at all', async () => {
    const { itemVersionId } = await seedInReviewItemVersion({ subject: `live-${freshUuid()}` });
    const result = await runner.run(async (tx) => repository.hasLiveClaim(itemVersionId, new Date().toISOString(), tx));
    expect(expectValue(result)).toBe(false);
  });

  it('is true for a claim that is live', async () => {
    const subject = `live-${freshUuid()}`;
    const { itemVersionId } = await seedInReviewItemVersion({ subject });
    expectValue(await repository.claimNext(claimCriteria({ subject })));

    const result = await runner.run(async (tx) => repository.hasLiveClaim(itemVersionId, new Date().toISOString(), tx));
    expect(expectValue(result)).toBe(true);
  });

  it('is false once the claim’s lease has expired — an expired lease is not begun work', async () => {
    const subject = `live-${freshUuid()}`;
    const { itemVersionId } = await seedInReviewItemVersion({ subject });
    const now = new Date();
    expectValue(
      await repository.claimNext(
        claimCriteria({
          subject,
          now: new Date(now.getTime() - 2 * 60 * 60 * 1000).toISOString(),
          leaseExpiresAt: new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
        }),
      ),
    );

    const result = await runner.run(async (tx) => repository.hasLiveClaim(itemVersionId, now.toISOString(), tx));
    expect(expectValue(result)).toBe(false);
  });

  it('is false once the claim has been released', async () => {
    const subject = `live-${freshUuid()}`;
    const { itemVersionId } = await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await repository.claimNext(claimCriteria({ subject })));
    expectValue(await repository.release(claimed.assignmentId, new Date().toISOString(), claimed.aggregateVersion));

    const result = await runner.run(async (tx) => repository.hasLiveClaim(itemVersionId, new Date().toISOString(), tx));
    expect(expectValue(result)).toBe(false);
  });

  it('reports a malformed read as PERSISTENCE_REJECTED, not thrown', async () => {
    const result = await runner.run(async (tx) => repository.hasLiveClaim('not-a-uuid', 'not-a-timestamp', tx));
    expect(expectError(result).code).toBe('PERSISTENCE_REJECTED');
  });
});

