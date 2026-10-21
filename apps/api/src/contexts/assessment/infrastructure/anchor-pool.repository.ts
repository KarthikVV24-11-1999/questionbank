import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { retireAnchorPoolMember, type AnchorPoolMember } from '../domain/anchor-pool.js';
import type { AnchorPoolRepository, RepositoryError } from '../domain/repository-ports.js';
import { conflict, fromDatabaseError, notFound, persistenceRejected } from './repository-errors.js';

interface MemberRow {
  readonly item_version_id: string;
  readonly exposure_cap: number;
  readonly added_at: Date;
  readonly retired_at: Date | null;
}

const toMember = (row: MemberRow): AnchorPoolMember =>
  Object.freeze({
    itemVersionId: row.item_version_id,
    exposureCap: row.exposure_cap,
    addedAt: row.added_at.toISOString(),
    retiredAt: row.retired_at === null ? null : row.retired_at.toISOString(),
  });

/**
 * Membership is read from the table on every call: the pool is what the
 * database says it is *now*, and publication reads it inside its own
 * transaction, so there is no cache here to be stale.
 */
export class PostgresAnchorPoolRepository implements AnchorPoolRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async add(member: AnchorPoolMember): Promise<Result<AnchorPoolMember, RepositoryError>> {
    try {
      await this.#pool.query(
        'INSERT INTO assessment.anchor_pool_member (item_version_id, exposure_cap, added_at) VALUES ($1, $2, $3)',
        [member.itemVersionId, member.exposureCap, member.addedAt],
      );
      return ok(member);
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async retire(itemVersionId: string, now: string): Promise<Result<AnchorPoolMember, RepositoryError>> {
    try {
      const found = await this.#pool.query<MemberRow>(
        'SELECT item_version_id, exposure_cap, added_at, retired_at FROM assessment.anchor_pool_member WHERE item_version_id = $1',
        [itemVersionId],
      );
      const row = found.rows[0];
      if (row === undefined) return err(notFound('anchor pool member', itemVersionId));
      const retired = retireAnchorPoolMember(toMember(row), now);
      if (!retired.ok) {
        return err(retired.error.code === 'ANCHOR_ALREADY_RETIRED' ? conflict(retired.error.message, 'retiredAt') : persistenceRejected(retired.error.message, retired.error.location));
      }
      // `retired_at IS NULL` in the WHERE: two retirements at once cannot both win.
      const updated = await this.#pool.query(
        'UPDATE assessment.anchor_pool_member SET retired_at = $2 WHERE item_version_id = $1 AND retired_at IS NULL',
        [itemVersionId, now],
      );
      return updated.rowCount === 1 ? ok(retired.value) : err(conflict('the version has already left the pool', 'retiredAt'));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }

  async listActive(): Promise<Result<readonly AnchorPoolMember[], RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<MemberRow>(
        'SELECT item_version_id, exposure_cap, added_at, retired_at FROM assessment.anchor_pool_member WHERE retired_at IS NULL ORDER BY added_at, item_version_id',
      );
      return ok(Object.freeze(rows.map(toMember)));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
