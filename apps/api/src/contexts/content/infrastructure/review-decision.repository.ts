import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { conflictError, notFoundError, validationError } from '../domain/content-error.js';
import type {
  ReviewDecisionRepository,
  RepositoryError,
  TransactionContext,
} from '../domain/repository-ports.js';
import type { ReviewDecision, ReviewedOwnerType, ReviewOutcome } from '../domain/review-decision.js';
import { clientOf } from './transaction-runner.js';

/**
 * The review record, written once and never updated (FR-QM-03).
 *
 * There is no `save`: a decision is appended, and a reviewer who changes their
 * mind appends another. `findApprovalFor` reads the most recent approving one,
 * so a version approved, sent back, and approved again resolves to the
 * approval that actually stands.
 *
 * `record` does not reconstruct `candidatesShownIds` on read-back (M4-19).
 * "Was this candidate shown?" is answered by `findCandidatesShown` per
 * decision — an aggregate query cannot distinguish "the check ran and found
 * nothing" from "the check never ran" (both read back as no rows), so
 * `#hydrate` leaves the field where that ambiguity cannot leak into it:
 * absent, always, on anything read from storage.
 */

interface DecisionRow {
  readonly review_decision_id: string;
  readonly owner_type: ReviewedOwnerType;
  readonly owner_version_id: string;
  readonly reviewer_kind: 'human' | 'ai_agent' | 'system';
  readonly reviewer_id: string;
  readonly outcome: ReviewOutcome;
  readonly justification: string | null;
  readonly decided_at: Date;
  readonly reason_code: string | null;
  readonly duplicate_of_item_id: string | null;
}

function toIsoInstant(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, '.000Z');
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'reviewDecision');
}

const SELECT = `SELECT review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id,
                       outcome, justification, decided_at, reason_code, duplicate_of_item_id
                  FROM content.review_decision`;

export class PostgresReviewDecisionRepository implements ReviewDecisionRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(
    decision: ReviewDecision,
    claimedAssignmentId?: string,
    tx?: TransactionContext,
  ): Promise<Result<ReviewDecision, RepositoryError>> {
    // `tx` supplied: the caller owns the transaction (M4-28) — no connect,
    // BEGIN, COMMIT, ROLLBACK or release here; the error propagates as a
    // `Result`, exactly as `#recordWithin` already returns one.
    if (tx !== undefined) {
      return this.#recordWithin(clientOf(tx), decision, claimedAssignmentId);
    }

    const client = await this.#pool.connect();
    let outcome: Result<ReviewDecision, RepositoryError>;

    try {
      await client.query('BEGIN');
      outcome = await this.#recordWithin(client, decision, claimedAssignmentId);
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }

  async #recordWithin(
    client: PoolClient,
    decision: ReviewDecision,
    claimedAssignmentId: string | undefined,
  ): Promise<Result<ReviewDecision, RepositoryError>> {
    await client.query(
      `INSERT INTO content.review_decision
         (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id,
          outcome, justification, decided_at, reason_code, duplicate_of_item_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        decision.decisionId,
        decision.ownerType,
        decision.ownerVersionId,
        decision.reviewer.kind,
        decision.reviewer.id,
        decision.outcome,
        decision.justification ?? null,
        decision.decidedAt,
        decision.reasonCode ?? null,
        decision.duplicateOfItemId ?? null,
      ],
    );

    // Inlined rather than shared with `infrastructure/review/`'s own writer:
    // DEC-M4-7's sub-boundary (M4-01) bars authoring-side plumbing — which is
    // what this file is, by path, regardless of what it stores — from
    // importing anything under `infrastructure/review/`. Two lines of SQL is
    // a smaller cost than a boundary exception.
    if (decision.candidatesShownIds !== undefined && decision.candidatesShownIds.length > 0) {
      const values = decision.candidatesShownIds.map((_, index) => `($1, $${index + 2})`).join(', ');
      await client.query(
        `INSERT INTO content.review_candidate_shown (review_decision_id, candidate_item_id) VALUES ${values}`,
        [decision.decisionId, ...decision.candidatesShownIds],
      );
    }

    if (claimedAssignmentId !== undefined) {
      const transitioned = await this.#decideAssignment(client, claimedAssignmentId, decision.decidedAt);
      if (!transitioned.ok) return transitioned;
    }

    return ok(decision);
  }

  /**
   * The one statement that matters is the `UPDATE`'s own `WHERE state =
   * 'claimed'` — the same guard M4-18's optimistic write uses, keyed on
   * state rather than `aggregate_version` since this is the one transition a
   * decision ever drives. A miss is `NOT_FOUND` when the row never existed
   * and `CONFLICT` when it did but was not live — the follow-up `SELECT`
   * only runs to tell those two apart, never to decide the write itself.
   */
  async #decideAssignment(
    client: PoolClient,
    assignmentId: string,
    at: string,
  ): Promise<Result<true, RepositoryError>> {
    const updated = await client.query(
      `UPDATE content.review_assignment
          SET state = 'decided', decided_at = $1, aggregate_version = aggregate_version + 1
        WHERE assignment_id = $2 AND state = 'claimed'`,
      [at, assignmentId],
    );
    if (updated.rowCount === 0) {
      const exists = await client.query(`SELECT 1 FROM content.review_assignment WHERE assignment_id = $1`, [
        assignmentId,
      ]);
      if (exists.rowCount === 0) {
        return err(notFoundError('NOT_FOUND', `no review assignment ${assignmentId}`, 'reviewDecision'));
      }
      return err(conflictError('CONFLICT', `review assignment ${assignmentId} was not live`, 'reviewDecision'));
    }
    return ok(true);
  }

  async findApprovalFor(
    ownerType: ReviewedOwnerType,
    ownerVersionId: string,
  ): Promise<Result<ReviewDecision, RepositoryError>> {
    const found = await this.#pool.query<DecisionRow>(
      `${SELECT}
        WHERE owner_type = $1 AND owner_version_id = $2
          AND outcome IN ('approve', 'approve_with_edits')
        ORDER BY decided_at DESC
        LIMIT 1`,
      [ownerType, ownerVersionId],
    );
    if (found.rowCount === 0) {
      return err(
        notFoundError('NOT_FOUND', `no approving review decision for ${ownerType} ${ownerVersionId}`, 'reviewDecision'),
      );
    }
    return ok(this.#hydrate(found.rows[0]!));
  }

  async findAllFor(
    ownerType: ReviewedOwnerType,
    ownerVersionId: string,
  ): Promise<Result<readonly ReviewDecision[], RepositoryError>> {
    const found = await this.#pool.query<DecisionRow>(
      `${SELECT}
        WHERE owner_type = $1 AND owner_version_id = $2
        ORDER BY decided_at DESC`,
      [ownerType, ownerVersionId],
    );

    return ok(found.rows.map((row) => this.#hydrate(row)));
  }

  async findByItemVersion(itemVersionId: string): Promise<Result<readonly ReviewDecision[], RepositoryError>> {
    return this.findAllFor('item_version', itemVersionId);
  }

  async findByReviewer(
    reviewerId: string,
    range: { readonly from: string; readonly to: string },
  ): Promise<Result<readonly ReviewDecision[], RepositoryError>> {
    const found = await this.#pool.query<DecisionRow>(
      `${SELECT}
        WHERE reviewer_id = $1 AND decided_at >= $2 AND decided_at <= $3
        ORDER BY decided_at ASC`,
      [reviewerId, range.from, range.to],
    );
    return ok(found.rows.map((row) => this.#hydrate(row)));
  }

  /**
   * Total, deliberately. Every invariant `createReviewDecision` enforces is
   * also a column constraint — the owner-type and outcome CHECKs, the NOT
   * NULLs, and `review_decision_returned_work_is_explained` — so re-running
   * the constructor here would add a failure branch nothing can reach. The
   * spec asserts the database refusal instead, which is the check that
   * actually holds.
   */
  #hydrate(row: DecisionRow): ReviewDecision {
    return Object.freeze({
      decisionId: row.review_decision_id,
      ownerType: row.owner_type,
      ownerVersionId: row.owner_version_id,
      reviewer: Object.freeze({
        kind: row.reviewer_kind,
        id: row.reviewer_id,
        roleContext: Object.freeze([]),
      }),
      outcome: row.outcome,
      ...(row.justification === null ? {} : { justification: row.justification }),
      decidedAt: toIsoInstant(row.decided_at),
      ...(row.reason_code === null ? {} : { reasonCode: row.reason_code }),
      ...(row.duplicate_of_item_id === null ? {} : { duplicateOfItemId: row.duplicate_of_item_id }),
    });
  }
}
