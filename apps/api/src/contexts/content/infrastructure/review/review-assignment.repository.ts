import type { Pool, PoolClient } from 'pg';
import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from '../../domain/result.js';
import { conflictError, notFoundError, ruleViolationError, validationError } from '../../domain/content-error.js';
import type {
  AssignReview,
  ClaimNextReviewAssignment,
  ReviewAssignmentRepository,
  RepositoryError,
  TransactionContext,
} from '../../domain/repository-ports.js';
import { clientOf } from '../transaction-runner.js';
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

/** Postgres' `unique_violation` — the signature of a live claim already existing. */
const UNIQUE_VIOLATION = '23505';

/**
 * The candidate `WHERE`, identical for every ordering — only what follows
 * `ORDER BY` differs. Kept as one string so the two orderings can never
 * silently diverge on *which* items are eligible, only on the order they
 * come out in.
 */
export const CANDIDATE_PREDICATE = `
   FROM content.item_version v
   JOIN content.item i ON i.item_id = v.item_id
  WHERE i.lifecycle_state = 'in_review'
    AND i.authoring_subject = $1
    AND v.authored_by_id <> $2
    AND v.version_no = (SELECT max(v2.version_no) FROM content.item_version v2 WHERE v2.item_id = v.item_id)
    AND NOT EXISTS (
      SELECT 1 FROM content.review_assignment ra
       WHERE ra.item_version_id = v.item_version_id AND ra.state = 'claimed'
    )`;

/**
 * `'oldest_first'` — unchanged from M4-18.
 */
const OLDEST_FIRST_QUERY = `
  SELECT v.item_version_id, v.item_id, v.authored_by_kind, v.authored_by_id, v.edited_by_kind, v.edited_by_id
  ${CANDIDATE_PREDICATE}
  ORDER BY i.state_entered_at ASC, v.item_version_id ASC
  LIMIT 1
  FOR UPDATE OF v SKIP LOCKED`;

/**
 * `'escalated_first'` (reconciled M4-46) — escalated, then concept batch,
 * then oldest, the first three of DEC-M4-9's four terms and precisely what
 * `domain/review/queue-ordering.ts` (M4-03) specifies for them; confidence
 * (the fourth) is `Fail — blocked`, see that module's own header and
 * `ClaimNextReviewAssignment`'s.
 *
 * **Escalated is derived**, never read from `content.review_escalation`:
 * `i.state_entered_at <= now − escalateAfterHours` is the same arithmetic
 * `ageState` (M4-05) performs, checked here so the SQL and the TypeScript
 * specification answer the identical question over the identical inputs —
 * `review-assignment.repository.integration.spec.ts`'s parity test compares
 * them directly. `escalateAfterHours` arrives as `$5`, a parameter, never a
 * SQL literal (F16).
 *
 * **Concept batch** joins the reviewer's most recent decision
 * (`review_decision`, keyed on `reviewer_id`) to that version's primary tag,
 * then compares it to each candidate's own primary tag
 * (`content.item_taxonomy_tag WHERE is_primary`). A reviewer with no prior
 * decision has no `last_concept` row, so the comparison is `false` for every
 * candidate and this term is a no-op — falling through to escalated/oldest
 * exactly as if the term did not exist, never an error.
 *
 * **One locking statement, unchanged.** The two CTEs below are read-only and
 * touch neither `review_assignment` nor the row `FOR UPDATE OF v` locks;
 * they resolve inside the same statement, on the same connection, inside the
 * same transaction as the `SELECT ... FOR UPDATE SKIP LOCKED` and the
 * `INSERT` that follows it — a second connection resolving order ahead of
 * this statement would reopen the SELECT-then-INSERT race M4-18 exists to
 * close (M4-27's correction note; M4-46 restates it because this is the
 * change that could most easily have reopened it).
 */
export const ESCALATED_FIRST_QUERY = `
  WITH last_decision AS (
    SELECT rd.owner_version_id
      FROM content.review_decision rd
     WHERE rd.reviewer_id = $3 AND rd.owner_type = 'item_version'
     ORDER BY rd.decided_at DESC
     LIMIT 1
  ),
  last_concept AS (
    SELECT t.concept_identity_id
      FROM content.item_taxonomy_tag t
      JOIN last_decision ld ON ld.owner_version_id = t.item_version_id
     WHERE t.is_primary
  )
  SELECT v.item_version_id, v.item_id, v.authored_by_kind, v.authored_by_id, v.edited_by_kind, v.edited_by_id
  ${CANDIDATE_PREDICATE.replace(
    'FROM content.item_version v',
    `FROM content.item_version v
   LEFT JOIN content.item_taxonomy_tag vt ON vt.item_version_id = v.item_version_id AND vt.is_primary`,
  )}
  ORDER BY
    (i.state_entered_at <= $4::timestamptz - ($5 * interval '1 hour')) DESC,
    (vt.concept_identity_id IS NOT NULL AND vt.concept_identity_id = (SELECT concept_identity_id FROM last_concept)) DESC,
    i.state_entered_at ASC,
    v.item_version_id ASC
  LIMIT 1
  FOR UPDATE OF v SKIP LOCKED`;

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
    const candidates =
      criteria.ordering === 'escalated_first'
        ? await client.query<CandidateRow>(ESCALATED_FIRST_QUERY, [
            criteria.subject,
            criteria.reviewer.id,
            criteria.reviewer.id,
            criteria.now,
            criteria.escalateAfterHours,
          ])
        : await client.query<CandidateRow>(OLDEST_FIRST_QUERY, [criteria.subject, criteria.reviewer.id]);

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

  async assign(criteria: AssignReview): Promise<Result<ReviewAssignment, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<ReviewAssignment, RepositoryError>;

    try {
      await client.query('BEGIN');
      outcome = await this.#assignWithin(client, criteria);
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }

  async #assignWithin(client: PoolClient, criteria: AssignReview): Promise<Result<ReviewAssignment, RepositoryError>> {
    const found = await client.query<CandidateRow>(
      `SELECT v.item_version_id, v.item_id, v.authored_by_kind, v.authored_by_id,
              v.edited_by_kind, v.edited_by_id
         FROM content.item_version v
         JOIN content.item i ON i.item_id = v.item_id
        WHERE v.item_version_id = $1 AND i.lifecycle_state = 'in_review'
        FOR UPDATE OF v`,
      [criteria.itemVersionId],
    );
    if (found.rowCount === 0) {
      return err(
        notFoundError('NOT_FOUND', `no in-review item version ${criteria.itemVersionId}`, 'reviewAssignment'),
      );
    }

    // The same re-check `claimNext` runs, on the same terms: reaches
    // `editedBy`, which naming a reviewer directly does not itself exclude.
    const candidate = found.rows[0]!;
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
          `INV-12: reviewer ${criteria.reviewer.id} is the author or editor of item version ${criteria.itemVersionId}`,
          'reviewAssignment',
        ),
      );
    }

    try {
      const inserted = await client.query<AssignmentRow>(
        `INSERT INTO content.review_assignment
           (item_id, item_version_id, subject, reviewer_kind, reviewer_id, kind, state, claimed_at, lease_expires_at)
         VALUES ($1, $2, $3, $4, $5, 'assigned', 'claimed', $6, $7)
         RETURNING assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id,
                   kind, state, claimed_at, lease_expires_at, released_at, decided_at, aggregate_version`,
        [
          candidate.item_id,
          criteria.itemVersionId,
          criteria.subject,
          criteria.reviewer.kind,
          criteria.reviewer.id,
          criteria.now,
          criteria.leaseExpiresAt,
        ],
      );
      return ok(this.#hydrate(inserted.rows[0]!));
    } catch (error) {
      // The same partial unique index `claimNext` relies on — a live claim
      // already exists. Caught here, not left to the outer `PERSISTENCE_REJECTED`
      // catch, because "already assigned" is a `Conflict` a caller can act on,
      // not an opaque write failure.
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        return err(
          conflictError(
            'CONFLICT',
            `item version ${criteria.itemVersionId} already has a live review assignment`,
            'reviewAssignment',
          ),
        );
      }
      throw error;
    }
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

  async extendLease(
    assignmentId: string,
    newLeaseExpiresAt: string,
    expectedVersion: number,
  ): Promise<Result<ReviewAssignment, RepositoryError>> {
    let updated;
    try {
      updated = await this.#pool.query<AssignmentRow>(
        `UPDATE content.review_assignment
            SET lease_expires_at = $1, aggregate_version = aggregate_version + 1
          WHERE assignment_id = $2 AND aggregate_version = $3 AND state = 'claimed'
          RETURNING assignment_id, item_id, item_version_id, subject, reviewer_kind, reviewer_id,
                    kind, state, claimed_at, lease_expires_at, released_at, decided_at, aggregate_version`,
        [newLeaseExpiresAt, assignmentId, expectedVersion],
      );
    } catch (error) {
      // The M4-21 trigger's own "must move forward" guard lands here too —
      // a caller that computed a non-advancing expiry gets the same
      // PERSISTENCE_REJECTED any other malformed write would.
      return err(persistenceRejected((error as Error).message));
    }

    if (updated.rowCount === 0) {
      const found = await this.findById(assignmentId);
      if (!found.ok) return found;
      return err(
        conflictError(
          'CONFLICT',
          `review assignment ${assignmentId} is not a live claim at version ${expectedVersion}`,
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

  async hasLiveClaim(
    itemVersionId: string,
    now: string,
    tx: TransactionContext,
  ): Promise<Result<boolean, RepositoryError>> {
    const client = clientOf(tx);
    try {
      // The same row `claimNext`'s `FOR UPDATE OF v SKIP LOCKED` locks —
      // without `SKIP LOCKED`, so this blocks behind a concurrent claim
      // rather than skipping past it (M4-30).
      await client.query(`SELECT 1 FROM content.item_version WHERE item_version_id = $1 FOR UPDATE`, [
        itemVersionId,
      ]);
      const live = await client.query(
        `SELECT 1 FROM content.review_assignment
          WHERE item_version_id = $1 AND state = 'claimed' AND lease_expires_at > $2
          LIMIT 1`,
        [itemVersionId, now],
      );
      return ok(live.rowCount !== 0);
    } catch (error) {
      return err(persistenceRejected((error as Error).message));
    }
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
