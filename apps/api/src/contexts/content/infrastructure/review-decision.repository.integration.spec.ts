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
