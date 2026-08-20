import type { Pool, PoolClient } from 'pg';
import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../../domain/result.js';
import { conflictError, notFoundError, ruleViolationError, validationError } from '../../domain/content-error.js';
import type {
  ClaimNextReviewAssignment,
  ReviewAssignmentRepository,
  RepositoryError,
} from '../../domain/repository-ports.js';
import {
  transitionReviewAssignment,
  type ReviewAssignment,
  type ReviewAssignmentKind,
  type ReviewAssignmentState,
} from '../../domain/review/review-assignment.js';
import { assertAssignable } from '../../domain/review/self-review.js';

/**
 * The atomic claim (M4-18). snake_case ↔ camelCase mapping happens here and
 * nowhere else — every other layer speaks `ReviewAssignment`.
 */

interface AssignmentRow {
  readonly assignment_id: string;
  readonly item_id: string;
  readonly item_version_id: string;
  readonly subject: string;
  readonly reviewer_kind: 'human' | 'ai_agent' | 'system';
  readonly reviewer_id: string;
  readonly kind: ReviewAssignmentKind;
  readonly state: ReviewAssignmentState;
  readonly claimed_at: Date;
  readonly lease_expires_at: Date;
  readonly released_at: Date | null;
  readonly decided_at: Date | null;
  readonly aggregate_version: number;
}

interface CandidateRow {
  readonly item_version_id: string;
  readonly item_id: string;
  readonly authored_by_kind: 'human' | 'ai_agent' | 'system';
  readonly authored_by_id: string;
  readonly edited_by_kind: 'human' | 'ai_agent' | 'system' | null;
  readonly edited_by_id: string | null;
}

function toIsoInstant(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, '.000Z');
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'reviewAssignment');
}

const ORDER_BY: Record<ClaimNextReviewAssignment['ordering'], string> = {
  escalated_first: `(EXISTS (SELECT 1 FROM content.review_escalation e WHERE e.item_version_id = v.item_version_id)) DESC,
                     i.state_entered_at ASC, v.item_version_id ASC`,
  oldest_first: `i.state_entered_at ASC, v.item_version_id ASC`,
};

const SELECT = `SELECT assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id,
                       kind, state, claimed_at, lease_expires_at, released_at, decided_at, aggregate_version
                  FROM content.review_assignment`;

export class PostgresReviewAssignmentRepository implements ReviewAssignmentRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async claimNext(criteria: ClaimNextReviewAssignment): Promise<Result<ReviewAssignment, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<ReviewAssignment, RepositoryError>;

    try {
      await client.query('BEGIN');
      outcome = await this.#claimWithin(client, criteria);
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }

  async #claimWithin(
    client: PoolClient,
    criteria: ClaimNextReviewAssignment,
  ): Promise<Result<ReviewAssignment, RepositoryError>> {
    // The predicate excludes the version's author. It does not reach
    // `edited_by_id` — the re-check below does, and is the one that actually
    // closes INV-12 for a version an approve-with-edits reviewer touched.
    const candidates = await client.query<CandidateRow>(
      `SELECT v.item_version_id, v.item_id, v.authored_by_kind, v.authored_by_id,
              v.edited_by_kind, v.edited_by_id
         FROM content.item_version v
         JOIN content.item i ON i.item_id = v.item_id
        WHERE i.lifecycle_state = 'in_review'
          AND i.authoring_subject = $1
          AND v.authored_by_id <> $2
          AND v.version_no = (SELECT max(v2.version_no) FROM content.item_version v2 WHERE v2.item_id = v.item_id)
          AND NOT EXISTS (
            SELECT 1 FROM content.review_assignment ra
             WHERE ra.item_version_id = v.item_version_id AND ra.state = 'claimed'
          )
        ORDER BY ${ORDER_BY[criteria.ordering]}
        LIMIT 1
        FOR UPDATE OF v SKIP LOCKED`,
      [criteria.subject, criteria.reviewer.id],
    );

    if (candidates.rowCount === 0) {
      return err(notFoundError('NOT_FOUND', `no claimable item version for subject "${criteria.subject}"`, 'reviewAssignment'));
    }

    const candidate = candidates.rows[0]!;
    const reassessed = assertAssignable(
      {
        authoredBy: freezePrincipal({
          kind: candidate.authored_by_kind,
          id: candidate.authored_by_id,
          roleContext: [],
        }),
        ...(candidate.edited_by_id === null
          ? {}
          : {
              editedBy: freezePrincipal({
                kind: candidate.edited_by_kind!,
                id: candidate.edited_by_id,
                roleContext: [],
              }),
            }),
      },
      criteria.reviewer,
    );
    if (!reassessed.ok) {
      return err(
        ruleViolationError(
          'PERSISTENCE_REJECTED',
          `INV-12: reviewer ${criteria.reviewer.id} is the author or editor of item version ${candidate.item_version_id}`,
          'reviewAssignment',
        ),
      );
    }

    const inserted = await client.query<AssignmentRow>(
      `INSERT INTO content.review_assignment
         (item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state, claimed_at, lease_expires_at)
       VALUES ($1, $2, $3, $4, $5, 'claimed', 'claimed', $6, $7)
       RETURNING assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id,
                 kind, state, claimed_at, lease_expires_at, released_at, decided_at, aggregate_version`,
      [
        candidate.item_id,
        candidate.item_version_id,
        criteria.subject,
        criteria.reviewer.kind,
        criteria.reviewer.id,
        criteria.now,
        criteria.leaseExpiresAt,
      ],
    );

    return ok(this.#hydrate(inserted.rows[0]!));
  }

  async release(
    assignmentId: string,
    at: string,
    expectedVersion: number,
  ): Promise<Result<ReviewAssignment, RepositoryError>> {
    const found = await this.findById(assignmentId);
    if (!found.ok) return found;

    const transitioned = transitionReviewAssignment(found.value, 'released', at);
    if (!transitioned.ok) {
      return err(ruleViolationError('PERSISTENCE_REJECTED', transitioned.error.message, 'reviewAssignment'));
    }

    const updated = await this.#pool.query<AssignmentRow>(
      `UPDATE content.review_assignment
          SET state = 'released', released_at = $1, aggregate_version = aggregate_version + 1
        WHERE assignment_id = $2 AND aggregate_version = $3
        RETURNING assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id,
                  kind, state, claimed_at, lease_expires_at, released_at, decided_at, aggregate_version`,
      [transitioned.value.releasedAt, assignmentId, expectedVersion],
    );

    if (updated.rowCount === 0) {
      return err(
        conflictError(
          'CONFLICT',
          `review assignment ${assignmentId} was not at version ${expectedVersion}`,
          'reviewAssignment',
        ),
      );
    }

    return ok(this.#hydrate(updated.rows[0]!));
  }

  async releaseExpired(now: string): Promise<Result<readonly ReviewAssignment[], RepositoryError>> {
    const released = await this.#pool.query<AssignmentRow>(
      `UPDATE content.review_assignment
          SET state = 'expired', aggregate_version = aggregate_version + 1
        WHERE state = 'claimed' AND lease_expires_at <= $1
        RETURNING assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id,
                  kind, state, claimed_at, lease_expires_at, released_at, decided_at, aggregate_version`,
      [now],
    );
    return ok(released.rows.map((row) => this.#hydrate(row)));
  }

  async findById(assignmentId: string): Promise<Result<ReviewAssignment, RepositoryError>> {
    const found = await this.#pool.query<AssignmentRow>(`${SELECT} WHERE assignment_id = $1`, [assignmentId]);
    if (found.rowCount === 0) {
      return err(notFoundError('NOT_FOUND', `no review assignment ${assignmentId}`, 'reviewAssignment'));
    }
    return ok(this.#hydrate(found.rows[0]!));
  }

  #hydrate(row: AssignmentRow): ReviewAssignment {
    return Object.freeze({
      assignmentId: row.assignment_id,
      itemId: row.item_id,
      itemVersionId: row.item_version_id,
      subject: row.subject,
      reviewer: freezePrincipal({ kind: row.reviewer_kind, id: row.reviewer_id, roleContext: [] }),
      kind: row.kind,
      state: row.state,
      claimedAt: toIsoInstant(row.claimed_at),
      leaseExpiresAt: toIsoInstant(row.lease_expires_at),
      aggregateVersion: row.aggregate_version,
      ...(row.released_at === null ? {} : { releasedAt: toIsoInstant(row.released_at) }),
      ...(row.decided_at === null ? {} : { decidedAt: toIsoInstant(row.decided_at) }),
    });
  }
}

function freezePrincipal(principal: PrincipalRef): PrincipalRef {
  return Object.freeze({ ...principal, roleContext: Object.freeze([...principal.roleContext]) });
}
