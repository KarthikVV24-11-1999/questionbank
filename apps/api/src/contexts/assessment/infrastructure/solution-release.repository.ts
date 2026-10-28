import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import type { RepositoryError, SolutionReleases } from '../domain/repository-ports.js';
import { makeReleasedSlot, type ReleasedSlot } from '../domain/solution-release.js';
import { fromDatabaseError } from './repository-errors.js';

/**
 * Reads the effort gate where it is stated: `assessment.solution_release` (migration `20261030110000`). The rule is the view's and is written nowhere
 * else; this asks one question of it and builds a `ReleasedSlot` from a row it returned, which is the only way one comes to exist.
 */
export class PostgresSolutionReleases implements SolutionReleases {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async releasedSlot(attemptId: string, slotId: string): Promise<Result<ReleasedSlot | undefined, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<{ attempt_id: string; slot_id: string; item_version_id: string }>(
        `SELECT attempt_id, slot_id, item_version_id
           FROM assessment.solution_release
          WHERE attempt_id = $1 AND slot_id = $2 AND released`,
        [attemptId, slotId],
      );
      const row = rows[0];
      return ok(row === undefined ? undefined : makeReleasedSlot(row.attempt_id, row.slot_id, row.item_version_id));
    } catch (error) {
      return err(fromDatabaseError(error));
    }
  }
}
