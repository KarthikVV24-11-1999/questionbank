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
      `UPDATE content.review_assignment SET state = 'decided', decided_at = now() WHERE assignment_id = $1`,
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
