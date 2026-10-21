import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { notFoundError, validationError } from '../domain/content-error.js';
import type { PublishedVersionReader, RepositoryError } from '../domain/repository-ports.js';

/**
 * Finds the owner of a version that has been published. **"Has been published"
 * is `published_at IS NOT NULL`, the same test the immutability triggers key
 * on (INV-03)** — not the owner's current state. A version published and then
 * superseded keeps its `published_at`, so it is found; a draft never had one,
 * so it is not.
 *
 * It selects two columns and nothing of the version's content: the caller
 * reads the version through the repository that already builds delivery views
 * field by field.
 */
export class PostgresPublishedVersions implements PublishedVersionReader {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  itemOfPublishedVersion(itemVersionId: string): Promise<Result<string, RepositoryError>> {
    return this.#owner('item_id', 'item_version', 'item_version_id', 'item version', itemVersionId);
  }

  stimulusOfPublishedVersion(stimulusVersionId: string): Promise<Result<string, RepositoryError>> {
    return this.#owner('stimulus_id', 'stimulus_version', 'stimulus_version_id', 'stimulus version', stimulusVersionId);
  }

  async #owner(ownerColumn: string, table: string, keyColumn: string, what: string, id: string): Promise<Result<string, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<Record<string, string>>(
        `SELECT ${ownerColumn} FROM content.${table} WHERE ${keyColumn} = $1 AND published_at IS NOT NULL`,
        [id],
      );
      const row = rows[0];
      return row === undefined ? err(notFoundError('NOT_FOUND', `no published ${what} ${id}`, what)) : ok(row[ownerColumn] as string);
    } catch {
      return err(validationError('PERSISTENCE_REJECTED', `the published ${what} could not be read`, what));
    }
  }
}
