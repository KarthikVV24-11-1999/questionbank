import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { notFoundError, validationError } from '../domain/content-error.js';
import type { ReviewDecisionRepository, RepositoryError } from '../domain/repository-ports.js';
import type { ReviewDecision, ReviewedOwnerType, ReviewOutcome } from '../domain/review-decision.js';

/**
 * The review record, written once and never updated (FR-QM-03).
 *
 * There is no `save`: a decision is appended, and a reviewer who changes their
 * mind appends another. `findApprovalFor` reads the most recent approving one,
 * so a version approved, sent back, and approved again resolves to the
 * approval that actually stands.
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
}

function toIsoInstant(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, '.000Z');
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'reviewDecision');
}

const SELECT = `SELECT review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id,
                       outcome, justification, decided_at
                  FROM content.review_decision`;

export class PostgresReviewDecisionRepository implements ReviewDecisionRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async record(decision: ReviewDecision): Promise<Result<ReviewDecision, RepositoryError>> {
    try {
      await this.#pool.query(
        `INSERT INTO content.review_decision
           (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id,
            outcome, justification, decided_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          decision.decisionId,
          decision.ownerType,
          decision.ownerVersionId,
          decision.reviewer.kind,
          decision.reviewer.id,
          decision.outcome,
          decision.justification ?? null,
          decision.decidedAt,
        ],
      );
      return ok(decision);
    } catch (error) {
      return err(persistenceRejected((error as Error).message));
    }
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
    });
  }
}
