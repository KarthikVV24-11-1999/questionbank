import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { validationError } from '../domain/content-error.js';
import type { RepositoryError, VersionTaxonomyEntry, VersionTaxonomyReader } from '../domain/repository-ports.js';

interface Row {
  readonly item_version_id: string;
  readonly concept_identity_id: string;
  readonly taxonomy_version_id: string;
  readonly difficulty_estimate: VersionTaxonomyEntry['difficultyEstimate'];
}

/**
 * The primary tag and authored difficulty of a set of item versions, in one query however many there are: an attempt is
 * seventy-five slots, and a call per slot is seventy-five round trips.
 *
 * "Has been published" is `published_at IS NOT NULL`, the test the immutability triggers key on (INV-03) and the one
 * `PostgresPublishedVersions` uses — not the owner's current state, so a superseded version is still found. Tags are frozen
 * with their version, so what this returns for a version never changes.
 *
 * `is_primary` is the restriction and `weight` is never selected (DEC-M7-5, D70). `SELECT` names columns; no option, key, numeric
 * specification or solution is touched.
 */
export class PostgresVersionTaxonomy implements VersionTaxonomyReader {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async forVersions(itemVersionIds: readonly string[]): Promise<Result<readonly VersionTaxonomyEntry[], RepositoryError>> {
    if (itemVersionIds.length === 0) return ok(Object.freeze([]));
    try {
      const { rows } = await this.#pool.query<Row>(
        `SELECT v.item_version_id, t.concept_identity_id, t.taxonomy_version_id, v.difficulty_estimate
           FROM content.item_version v
           JOIN content.item_taxonomy_tag t ON t.item_version_id = v.item_version_id AND t.is_primary
          WHERE v.item_version_id = ANY($1::uuid[])
            AND v.published_at IS NOT NULL
          ORDER BY v.item_version_id`,
        [[...new Set(itemVersionIds)]],
      );
      return ok(
        Object.freeze(
          rows.map((row) =>
            Object.freeze({
              itemVersionId: row.item_version_id,
              conceptIdentityId: row.concept_identity_id,
              taxonomyVersionId: row.taxonomy_version_id,
              difficultyEstimate: row.difficulty_estimate,
            }),
          ),
        ),
      );
    } catch {
      // Never the statement or the driver's message (§8).
      return err(validationError('PERSISTENCE_REJECTED', 'the version taxonomy could not be read', 'itemVersionIds'));
    }
  }
}
