import type { Pool } from 'pg';
import { applicationError, type ApplicationError } from '../application/authorization.js';
import type { BookmarkStore, ErrorEntryStore } from '../application/ports.js';
import type { Bookmark } from '../domain/bookmark.js';
import type { ErrorCause, ErrorEntry } from '../domain/error-entry.js';
import { err, ok, type Result } from '../domain/result.js';

interface EntryRow {
  readonly error_entry_id: string;
  readonly learner_ref: string;
  readonly attempt_ref: string;
  readonly slot_ref: string;
  readonly item_version_ref: string;
  readonly concept_identity_id: string;
  readonly taxonomy_version_id: string;
  readonly kind: ErrorEntry['kind'];
  readonly error_cause: ErrorEntry['errorCause'];
  readonly occurred_at: Date;
  readonly resolved_by_transition_id: string | null;
}

const COLUMNS = `error_entry_id, learner_ref, attempt_ref, slot_ref, item_version_ref, concept_identity_id, taxonomy_version_id, kind, error_cause, occurred_at, resolved_by_transition_id`;

const toEntry = (row: EntryRow): ErrorEntry =>
  Object.freeze({
    errorEntryId: row.error_entry_id,
    learnerRef: row.learner_ref,
    attemptRef: row.attempt_ref,
    slotRef: row.slot_ref,
    itemVersionRef: row.item_version_ref,
    conceptIdentityId: row.concept_identity_id,
    taxonomyVersionId: row.taxonomy_version_id,
    kind: row.kind,
    errorCause: row.error_cause,
    occurredAt: row.occurred_at.toISOString(),
    resolvedByTransitionId: row.resolved_by_transition_id,
  });

const unavailable = (): ApplicationError => applicationError('Unavailable', 'NOTEBOOK_UNAVAILABLE', "the learner's notebook could not be read or written");

/** The learner's error notebook. Every statement is scoped by the learner, so an entry that is someone else's is simply not found. */
export class PostgresErrorEntryStore implements ErrorEntryStore {
  constructor(private readonly pool: Pool) {}

  async find(learnerRef: string, errorEntryId: string): Promise<Result<ErrorEntry, ApplicationError>> {
    try {
      const { rows } = await this.pool.query<EntryRow>(`SELECT ${COLUMNS} FROM learning.error_entry WHERE learner_ref = $1 AND error_entry_id = $2`, [learnerRef, errorEntryId]);
      return rows[0] === undefined ? err(applicationError('NotFound', 'NOT_FOUND', `no error entry ${errorEntryId}`)) : ok(toEntry(rows[0]));
    } catch {
      return err(unavailable());
    }
  }

  async list(learnerRef: string, options: { readonly openOnly: boolean }): Promise<Result<readonly ErrorEntry[], ApplicationError>> {
    try {
      const { rows } = await this.pool.query<EntryRow>(
        `SELECT ${COLUMNS} FROM learning.error_entry WHERE learner_ref = $1 ${options.openOnly ? 'AND resolved_by_transition_id IS NULL' : ''} ORDER BY occurred_at, error_entry_id`,
        [learnerRef],
      );
      return ok(Object.freeze(rows.map(toEntry)));
    } catch {
      return err(unavailable());
    }
  }

  async setCause(learnerRef: string, errorEntryId: string, cause: ErrorCause): Promise<Result<ErrorEntry, ApplicationError>> {
    try {
      const { rows } = await this.pool.query<EntryRow>(
        `UPDATE learning.error_entry SET error_cause = $3 WHERE learner_ref = $1 AND error_entry_id = $2 RETURNING ${COLUMNS}`,
        [learnerRef, errorEntryId, cause],
      );
      return rows[0] === undefined ? err(applicationError('NotFound', 'NOT_FOUND', `no error entry ${errorEntryId}`)) : ok(toEntry(rows[0]));
    } catch {
      return err(unavailable());
    }
  }
}

interface BookmarkRow {
  readonly bookmark_id: string;
  readonly learner_ref: string;
  readonly item_id: string;
  readonly created_at: Date;
}

const toBookmark = (row: BookmarkRow): Bookmark =>
  Object.freeze({ bookmarkId: row.bookmark_id, learnerRef: row.learner_ref, itemId: row.item_id, createdAt: row.created_at.toISOString() });

export class PostgresBookmarkStore implements BookmarkStore {
  constructor(private readonly pool: Pool) {}

  async add(bookmark: Bookmark): Promise<Result<Bookmark, ApplicationError>> {
    try {
      // The same item again is the bookmark already there.
      await this.pool.query(
        `INSERT INTO learning.bookmark (bookmark_id, learner_ref, item_id, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (learner_ref, item_id) DO NOTHING`,
        [bookmark.bookmarkId, bookmark.learnerRef, bookmark.itemId, bookmark.createdAt],
      );
      const { rows } = await this.pool.query<BookmarkRow>('SELECT bookmark_id, learner_ref, item_id, created_at FROM learning.bookmark WHERE learner_ref = $1 AND item_id = $2', [bookmark.learnerRef, bookmark.itemId]);
      return ok(toBookmark(rows[0] as BookmarkRow));
    } catch {
      return err(unavailable());
    }
  }

  async list(learnerRef: string): Promise<Result<readonly Bookmark[], ApplicationError>> {
    try {
      const { rows } = await this.pool.query<BookmarkRow>('SELECT bookmark_id, learner_ref, item_id, created_at FROM learning.bookmark WHERE learner_ref = $1 ORDER BY created_at, bookmark_id', [learnerRef]);
      return ok(Object.freeze(rows.map(toBookmark)));
    } catch {
      return err(unavailable());
    }
  }
}
