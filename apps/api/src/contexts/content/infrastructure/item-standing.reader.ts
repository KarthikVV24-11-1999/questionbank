import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { validationError } from '../domain/content-error.js';
import type { ItemStandingEntry, ItemStandingReader, RepositoryError } from '../domain/repository-ports.js';

interface Row {
  readonly item_id: string;
  readonly lifecycle_state: ItemStandingEntry['state'];
  readonly current_published_version_id: string | null;
}

/**
 * Where a set of items stand, in one query: published and suspended items show their current published version, and a retired item the one it last had — it is
 * kept, never deleted (FR-QM-01 rule 5). Identifiers and a lifecycle word; no stem, no key, no solution.
 */
export class PostgresItemStanding implements ItemStandingReader {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async forItems(itemIds: readonly string[]): Promise<Result<readonly ItemStandingEntry[], RepositoryError>> {
    if (itemIds.length === 0) return ok(Object.freeze([]));
    try {
      const { rows } = await this.#pool.query<Row>(
        `SELECT item_id, lifecycle_state, current_published_version_id
           FROM content.item
          WHERE item_id = ANY($1::uuid[])
            AND lifecycle_state IN ('published', 'suspended', 'retired')
          ORDER BY item_id`,
        [[...new Set(itemIds)]],
      );
      return ok(Object.freeze(rows.map((row) => Object.freeze({ itemId: row.item_id, state: row.lifecycle_state, itemVersionId: row.current_published_version_id }))));
    } catch {
      return err(validationError('PERSISTENCE_REJECTED', 'the standing of the items could not be read', 'itemIds'));
    }
  }
}
