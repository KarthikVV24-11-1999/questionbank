import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import type { ExposureEntry } from '../domain/exposure.js';
import type { ExposureLedger, RepositoryError, SessionExposure } from '../domain/repository-ports.js';
import { fromDatabaseError } from './repository-errors.js';

interface EntryRow {
  readonly form_id: string;
  readonly slot_id: string;
  readonly item_id: string;
  readonly item_version_id: string;
  readonly session_ref: string;
  readonly is_anchor: boolean;
  readonly written_at: Date;
}

/**
 * The ledger as a reader. It has no write method, by design: the rows are
 * written inside `PostgresFormRepository.publish`, in the publication
 * transaction, and an assessment spec asserts that no other file names the
 * ledger's table in an INSERT.
 */
export class PostgresExposureLedger implements ExposureLedger {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async countsByItemVersion(itemVersionIds: readonly string[]): Promise<Result<ReadonlyMap<string, number>, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<{ item_version_id: string; placed: number }>(
        `SELECT item_version_id, count(*)::int AS placed
           FROM assessment.exposure_ledger_entry
          WHERE item_version_id = ANY($1::uuid[])
          GROUP BY item_version_id`,
        [itemVersionIds],
      );
      return ok(new Map(rows.map((row) => [row.item_version_id, row.placed])));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async entriesForForm(formId: string): Promise<Result<readonly ExposureEntry[], RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<EntryRow>(
        `SELECT e.form_id, e.slot_id, e.item_id, e.item_version_id, e.session_ref, e.is_anchor, e.written_at
           FROM assessment.exposure_ledger_entry e
           JOIN assessment.form_slot s ON s.slot_id = e.slot_id
          WHERE e.form_id = $1
          ORDER BY s.ordinal, e.session_ref`,
        [formId],
      );
      return ok(
        Object.freeze(
          rows.map((row) =>
            Object.freeze({
              formId: row.form_id,
              slotId: row.slot_id,
              itemId: row.item_id,
              itemVersionId: row.item_version_id,
              sessionRef: row.session_ref,
              isAnchor: row.is_anchor,
              writtenAt: row.written_at.toISOString(),
            }),
          ),
        ),
      );
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async exposureBySession(itemVersionIds: readonly string[]): Promise<Result<readonly SessionExposure[], RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<{ session_ref: string; item_version_id: string; placements: number; attempts_sat: number }>(
        `SELECT e.session_ref, e.item_version_id,
                count(DISTINCT e.entry_id)::int AS placements,
                count(DISTINCT a.attempt_id)::int AS attempts_sat
           FROM assessment.exposure_ledger_entry e
           LEFT JOIN assessment.attempt a
             ON a.form_id = e.form_id AND a.session_ref = e.session_ref AND a.started_at IS NOT NULL
          WHERE e.item_version_id = ANY($1::uuid[])
          GROUP BY e.session_ref, e.item_version_id
          ORDER BY e.item_version_id, e.session_ref`,
        [itemVersionIds],
      );
      return ok(
        Object.freeze(
          rows.map((row) =>
            Object.freeze({
              sessionRef: row.session_ref,
              itemVersionId: row.item_version_id,
              placements: row.placements,
              attemptsSat: row.attempts_sat,
            }),
          ),
        ),
      );
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
