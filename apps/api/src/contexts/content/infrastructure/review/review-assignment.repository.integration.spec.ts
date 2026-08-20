import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, DATABASE_URL, type TestDatabase } from '../../../../testing/database.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import type { ClaimNextReviewAssignment } from '../../domain/repository-ports.js';
import { PostgresReviewAssignmentRepository } from './review-assignment.repository.js';

let database: TestDatabase;
let repository: PostgresReviewAssignmentRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresReviewAssignmentRepository(database.pool);
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

  it('orders by escalation first when asked', async () => {
    const subject = `escalation-${freshUuid()}`;
    await seedInReviewItemVersion({ subject, stateEnteredAt: new Date(Date.now() - 100_000) });
    const escalated = await seedInReviewItemVersion({ subject, stateEnteredAt: new Date() });
    await database.pool.query(
      `INSERT INTO content.review_escalation (item_id, item_version_id, reason, escalated_at)
       VALUES ($1, $2, 'aged_out', now())`,
      [escalated.itemId, escalated.itemVersionId],
    );

    const claimed = expectValue(
      await repository.claimNext(claimCriteria({ subject, ordering: 'escalated_first' })),
    );
    expect(claimed.itemVersionId).toBe(escalated.itemVersionId);
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
    // An ordering key ORDER_BY does not recognize breaks the SQL statement
    // itself — the same path a genuine connection fault would take, without
    // needing to fail the database out from under the pool.
    const refused = await repository.claimNext(
      claimCriteria({ subject, ordering: 'not_a_real_ordering' as unknown as ClaimNextReviewAssignment['ordering'] }),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });
});
