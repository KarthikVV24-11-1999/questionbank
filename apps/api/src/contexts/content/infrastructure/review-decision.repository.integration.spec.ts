import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, REVIEWER } from '../../../testing/content-fixtures.js';
import {
  createReviewDecision,
  type CreateReviewDecisionProps,
  type ReviewDecision,
} from '../domain/review-decision.js';
import { PostgresReviewDecisionRepository } from './review-decision.repository.js';

let database: TestDatabase;
let repository: PostgresReviewDecisionRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresReviewDecisionRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-f000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const REVIEWER_ID = freshUuid();
const AUTHOR_ID = freshUuid();
const DB_REVIEWER = { ...REVIEWER, id: REVIEWER_ID };
const DB_AUTHOR = { ...AUTHOR, id: AUTHOR_ID };

function decision(overrides: Partial<CreateReviewDecisionProps> = {}): ReviewDecision {
  return expectValue(
    createReviewDecision({
      decisionId: freshUuid(),
      ownerType: 'item_version',
      ownerVersionId: freshUuid(),
      reviewer: DB_REVIEWER,
      outcome: 'approve',
      decidedAt: '2026-08-11T09:00:00.000Z',
      ...overrides,
    }),
  );
}

describe('recording a decision', () => {
  it('round trips it', async () => {
    const recorded = decision();
    expectValue(await repository.record(recorded));

    const found = expectValue(await repository.findApprovalFor('item_version', recorded.ownerVersionId));
    expect(found).toMatchObject({
      decisionId: recorded.decisionId,
      ownerType: 'item_version',
      ownerVersionId: recorded.ownerVersionId,
      outcome: 'approve',
      decidedAt: '2026-08-11T09:00:00.000Z',
    });
    expect(found.reviewer.id).toBe(REVIEWER_ID);
    expect(found.reviewer.kind).toBe('human');
  });

  it('keeps the justification on a decision that sent work back', async () => {
    const versionId = freshUuid();
    expectValue(
      await repository.record(
        decision({ ownerVersionId: versionId, outcome: 'request_changes', justification: 'the stem is ambiguous' }),
      ),
    );

    const all = expectValue(await repository.findAllFor('item_version', versionId));
    expect(all[0]!.justification).toBe('the stem is ambiguous');
  });

  it('refuses a second decision under the same identifier', async () => {
    const recorded = decision();
    expectValue(await repository.record(recorded));
    expect(expectError(await repository.record(recorded)).code).toBe('PERSISTENCE_REJECTED');
  });

  // The database holds the same rule the constructor does, because a code path
  // that forgot the constructor would otherwise store feedback nobody can act on.
  it('is refused by the database when returned work carries no justification', async () => {
    const rejected = await database.pool
      .query(
        `INSERT INTO content.review_decision
           (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
         VALUES ($1, 'item_version', $2, 'human', $3, 'reject', now())`,
        [freshUuid(), freshUuid(), REVIEWER_ID],
      )
      .then(() => undefined)
      .catch((error: Error) => error.message);
    expect(rejected).toContain('review_decision_returned_work_is_explained');
  });
});

describe('finding the approval that stands', () => {
  it('returns the most recent approving decision', async () => {
    const versionId = freshUuid();
    expectValue(
      await repository.record(
        decision({
          ownerVersionId: versionId,
          outcome: 'approve',
          decidedAt: '2026-08-01T09:00:00.000Z',
        }),
      ),
    );
    expectValue(
      await repository.record(
        decision({
          ownerVersionId: versionId,
          outcome: 'approve_with_edits',
          decidedAt: '2026-08-05T09:00:00.000Z',
        }),
      ),
    );

    expect(expectValue(await repository.findApprovalFor('item_version', versionId)).outcome).toBe(
      'approve_with_edits',
    );
  });

  it('ignores decisions that sent work back', async () => {
    const versionId = freshUuid();
    expectValue(
      await repository.record(
        decision({ ownerVersionId: versionId, outcome: 'reject', justification: 'wrong key' }),
      ),
    );
    expect(expectError(await repository.findApprovalFor('item_version', versionId)).kind).toBe('NotFound');
  });

  it('reports nothing for a version nobody reviewed', async () => {
    expect(expectError(await repository.findApprovalFor('item_version', freshUuid())).kind).toBe('NotFound');
  });

  // An approval of version 1 says nothing about version 2, whose key may differ.
  it('does not answer for a different version', async () => {
    const approved = freshUuid();
    expectValue(await repository.record(decision({ ownerVersionId: approved })));
    expect(expectError(await repository.findApprovalFor('item_version', freshUuid())).kind).toBe('NotFound');
  });

  it('does not answer across owner types', async () => {
    const versionId = freshUuid();
    expectValue(await repository.record(decision({ ownerVersionId: versionId })));
    expect(expectError(await repository.findApprovalFor('stimulus_version', versionId)).kind).toBe('NotFound');
  });
});

describe('the decision history', () => {
  it('returns every decision, most recent first', async () => {
    const versionId = freshUuid();
    expectValue(
      await repository.record(
        decision({
          ownerVersionId: versionId,
          outcome: 'request_changes',
          justification: 'unclear',
          decidedAt: '2026-08-01T09:00:00.000Z',
        }),
      ),
    );
    expectValue(
      await repository.record(
        decision({ ownerVersionId: versionId, outcome: 'approve', decidedAt: '2026-08-05T09:00:00.000Z' }),
      ),
    );

    const history = expectValue(await repository.findAllFor('item_version', versionId));
    expect(history.map((entry) => entry.outcome)).toEqual(['approve', 'request_changes']);
  });

  it('is empty for a version nobody reviewed', async () => {
    expect(expectValue(await repository.findAllFor('solution_version', freshUuid()))).toEqual([]);
  });

  it('carries the author’s own approval through so INV-12 can refuse it', async () => {
    const versionId = freshUuid();
    expectValue(await repository.record(decision({ ownerVersionId: versionId, reviewer: DB_AUTHOR })));
    expect(expectValue(await repository.findApprovalFor('item_version', versionId)).reviewer.id).toBe(
      AUTHOR_ID,
    );
  });
});

describe('the governance fields round trip (M4-19)', () => {
  it('carries reasonCode and duplicateOfItemId', async () => {
    const versionId = freshUuid();
    const duplicateTarget = freshUuid();
    await database.pool.query(`INSERT INTO content.item (item_id, item_type) VALUES ($1, 'SINGLE_CORRECT_MCQ')`, [
      duplicateTarget,
    ]);
    expectValue(
      await repository.record(
        decision({
          ownerVersionId: versionId,
          outcome: 'reject',
          justification: 'same item, retyped',
          reasonCode: 'DUPLICATE',
          duplicateOfItemId: duplicateTarget,
        }),
      ),
    );

    const found = expectValue(await repository.findAllFor('item_version', versionId))[0]!;
    expect(found.reasonCode).toBe('DUPLICATE');
    expect(found.duplicateOfItemId).toBe(duplicateTarget);
  });

  it('leaves reasonCode and duplicateOfItemId absent when not supplied', async () => {
    const versionId = freshUuid();
    expectValue(await repository.record(decision({ ownerVersionId: versionId })));
    const found = expectValue(await repository.findAllFor('item_version', versionId))[0]!;
    expect(found.reasonCode).toBeUndefined();
    expect(found.duplicateOfItemId).toBeUndefined();
  });

  it('writes candidatesShownIds as rows in review_candidate_shown', async () => {
    const versionId = freshUuid();
    const decisionId = freshUuid();
    const candidateA = freshUuid();
    const candidateB = freshUuid();
    expectValue(
      await repository.record(
        decision({
          decisionId,
          ownerVersionId: versionId,
          candidatesShownIds: [candidateA, candidateB],
        }),
      ),
    );

    const rows = await database.pool.query<{ candidate_item_id: string }>(
      `SELECT candidate_item_id FROM content.review_candidate_shown WHERE review_decision_id = $1 ORDER BY candidate_item_id`,
      [decisionId],
    );
    expect(rows.rows.map((row) => row.candidate_item_id).sort()).toEqual([candidateA, candidateB].sort());
  });

  it('writes no candidate rows when the duplicate check never ran', async () => {
    const versionId = freshUuid();
    const decisionId = freshUuid();
    expectValue(await repository.record(decision({ decisionId, ownerVersionId: versionId })));

    const rows = await database.pool.query(
      `SELECT 1 FROM content.review_candidate_shown WHERE review_decision_id = $1`,
      [decisionId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('writes no candidate rows when the check ran and found nothing (empty is not absent, but neither writes a row)', async () => {
    const versionId = freshUuid();
    const decisionId = freshUuid();
    expectValue(
      await repository.record(decision({ decisionId, ownerVersionId: versionId, candidatesShownIds: [] })),
    );

    const rows = await database.pool.query(
      `SELECT 1 FROM content.review_candidate_shown WHERE review_decision_id = $1`,
      [decisionId],
    );
    expect(rows.rowCount).toBe(0);
  });

  it('does not reconstruct candidatesShownIds on read-back — the ambiguity a bare row count cannot resolve', async () => {
    const versionId = freshUuid();
    expectValue(
      await repository.record(decision({ ownerVersionId: versionId, candidatesShownIds: [freshUuid()] })),
    );
    const found = expectValue(await repository.findAllFor('item_version', versionId))[0]!;
    expect(found.candidatesShownIds).toBeUndefined();
  });
});

describe('findByItemVersion / findByReviewer (M4-19, M4-33’s source)', () => {
  it('findByItemVersion matches findAllFor for item_version', async () => {
    const versionId = freshUuid();
    expectValue(await repository.record(decision({ ownerVersionId: versionId })));
    const viaItemVersion = expectValue(await repository.findByItemVersion(versionId));
    const viaAllFor = expectValue(await repository.findAllFor('item_version', versionId));
    expect(viaItemVersion.map((d) => d.decisionId)).toEqual(viaAllFor.map((d) => d.decisionId));
  });

  it('findByReviewer scopes by reviewer and instant range, oldest first', async () => {
    const scopedReviewerId = freshUuid();
    const scopedReviewer = { ...REVIEWER, id: scopedReviewerId };
    expectValue(
      await repository.record(
        decision({ reviewer: scopedReviewer, decidedAt: '2026-08-01T09:00:00.000Z' }),
      ),
    );
    expectValue(
      await repository.record(
        decision({ reviewer: scopedReviewer, decidedAt: '2026-08-10T09:00:00.000Z' }),
      ),
    );
    // Outside the range — must not appear.
    expectValue(
      await repository.record(
        decision({ reviewer: scopedReviewer, decidedAt: '2026-09-01T09:00:00.000Z' }),
      ),
    );
    // A different reviewer, inside the range — must not appear either.
    expectValue(await repository.record(decision({ decidedAt: '2026-08-05T09:00:00.000Z' })));

    const found = expectValue(
      await repository.findByReviewer(scopedReviewerId, {
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-31T23:59:59.999Z',
      }),
    );
    expect(found.map((d) => d.decidedAt)).toEqual(['2026-08-01T09:00:00.000Z', '2026-08-10T09:00:00.000Z']);
    expect(found.every((d) => d.reviewer.id === scopedReviewerId)).toBe(true);
  });
});

describe('the assignment side effect is transactional (M4-19)', () => {
  it('transitions a claimed assignment to decided in the same transaction', async () => {
    const itemId = freshUuid();
    const itemVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject)
       VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', 'physics')`,
      [itemId],
    );
    await database.pool.query(
      `INSERT INTO content.item_version
         (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
          authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
      [itemVersionId, itemId, AUTHOR_ID],
    );
    const assignmentId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.review_assignment
         (assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state,
          claimed_at, lease_expires_at)
       VALUES ($1, $2, $3, 'physics', 'human', $4, 'claimed', 'claimed', now(), now() + interval '1 hour')`,
      [assignmentId, itemId, itemVersionId, REVIEWER_ID],
    );

    expectValue(await repository.record(decision({ ownerVersionId: itemVersionId }), assignmentId));

    const row = await database.pool.query<{ state: string }>(
      `SELECT state FROM content.review_assignment WHERE assignment_id = $1`,
      [assignmentId],
    );
    expect(row.rows[0]!.state).toBe('decided');
  });

  it('rolls back the decision and its candidate rows when the assignment is not live', async () => {
    const versionId = freshUuid();
    const decisionId = freshUuid();
    const refused = await repository.record(
      decision({ decisionId, ownerVersionId: versionId, candidatesShownIds: [freshUuid()] }),
      freshUuid(), // an assignment id that does not exist
    );
    expect(refused.ok).toBe(false);

    const decisionRow = await database.pool.query(
      `SELECT 1 FROM content.review_decision WHERE review_decision_id = $1`,
      [decisionId],
    );
    expect(decisionRow.rowCount).toBe(0);
    const candidateRow = await database.pool.query(
      `SELECT 1 FROM content.review_candidate_shown WHERE review_decision_id = $1`,
      [decisionId],
    );
    expect(candidateRow.rowCount).toBe(0);
  });

  it('reports Conflict when the assignment is no longer live (already decided)', async () => {
    const itemId = freshUuid();
    const itemVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject)
       VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', 'physics')`,
      [itemId],
    );
    await database.pool.query(
      `INSERT INTO content.item_version
         (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
          authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
      [itemVersionId, itemId, AUTHOR_ID],
    );
    const assignmentId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.review_assignment
         (assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state,
          claimed_at, lease_expires_at, decided_at)
       VALUES ($1, $2, $3, 'physics', 'human', $4, 'claimed', 'decided', now(), now() + interval '1 hour', now())`,
      [assignmentId, itemId, itemVersionId, REVIEWER_ID],
    );

    const refused = await repository.record(decision({ ownerVersionId: itemVersionId }), assignmentId);
    expect(expectError(refused).code).toBe('CONFLICT');
  });
});
