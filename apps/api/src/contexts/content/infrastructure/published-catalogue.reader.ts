import type { Pool } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { validationError } from '../domain/content-error.js';
import type {
  PublishedCatalogueCriteria,
  PublishedCatalogueEntry,
  PublishedCataloguePage,
  PublishedCatalogueReader,
  RepositoryError,
} from '../domain/repository-ports.js';

interface CatalogueRow {
  readonly item_id: string;
  readonly item_version_id: string;
  readonly version_no: number;
  readonly item_type: PublishedCatalogueEntry['itemType'];
  readonly difficulty_estimate: PublishedCatalogueEntry['difficultyBand'];
  readonly authoring_subject: string;
  readonly stimulus_version_id: string | null;
  readonly taxonomy_version_id: string;
  readonly primary_concept: string;
  readonly concepts: string[];
}

/**
 * The published catalogue, read from the database in one query.
 *
 * The state restriction is a `WHERE`, never a post-filter: only an item whose
 * `lifecycle_state` is `published` can leave this query, on any argument. A
 * suspended item still names the version it published (history is retained),
 * and that retained pointer is exactly what would keep listing content
 * somebody withdrew — so the pointer alone is never the test.
 *
 * Paged by keyset on `item_id` rather than `OFFSET`, which a concurrent
 * publication would shift a page boundary through.
 *
 * `SELECT` names columns. No column of an option, a numeric specification, a
 * matching pair or a solution is touched, so there is nothing to forget to
 * leave out.
 */
export class PostgresPublishedCatalogue implements PublishedCatalogueReader {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async list(criteria: PublishedCatalogueCriteria): Promise<Result<PublishedCataloguePage, RepositoryError>> {
    try {
      const { rows } = await this.#pool.query<CatalogueRow>(
        `SELECT i.item_id, v.item_version_id, v.version_no, v.item_type, v.difficulty_estimate,
                i.authoring_subject, v.stimulus_version_id,
                (SELECT t.taxonomy_version_id FROM content.item_taxonomy_tag t
                  WHERE t.item_version_id = v.item_version_id AND t.is_primary) AS taxonomy_version_id,
                (SELECT t.concept_identity_id FROM content.item_taxonomy_tag t
                  WHERE t.item_version_id = v.item_version_id AND t.is_primary) AS primary_concept,
                ARRAY(SELECT t.concept_identity_id::text FROM content.item_taxonomy_tag t
                       WHERE t.item_version_id = v.item_version_id ORDER BY t.concept_identity_id) AS concepts
           FROM content.item i
           JOIN content.item_version v ON v.item_version_id = i.current_published_version_id
          WHERE i.deleted_at IS NULL
            AND i.lifecycle_state = 'published'
            AND ($1::text IS NULL OR i.authoring_subject = $1)
            AND ($2::text[] IS NULL OR v.item_type = ANY($2))
            AND ($3::text[] IS NULL OR v.difficulty_estimate = ANY($3))
            AND ($4::uuid[] IS NULL OR EXISTS (
                  SELECT 1 FROM content.item_taxonomy_tag t
                   WHERE t.item_version_id = v.item_version_id AND t.concept_identity_id = ANY($4)))
            AND ($5::uuid IS NULL OR i.item_id > $5)
          ORDER BY i.item_id
          LIMIT $6`,
        [
          criteria.subject ?? null,
          criteria.itemTypes ?? null,
          criteria.difficultyBands ?? null,
          criteria.conceptIdentityIds ?? null,
          criteria.cursor ?? null,
          criteria.limit,
        ],
      );

      const entries = rows.map((row) =>
        Object.freeze({
          itemId: row.item_id,
          itemVersionId: row.item_version_id,
          versionNo: row.version_no,
          itemType: row.item_type,
          difficultyBand: row.difficulty_estimate,
          subject: row.authoring_subject,
          taxonomyVersionId: row.taxonomy_version_id,
          primaryConceptIdentityId: row.primary_concept,
          conceptIdentityIds: Object.freeze([...row.concepts]),
          ...(row.stimulus_version_id === null ? {} : { stimulusVersionId: row.stimulus_version_id }),
        }),
      );
      // A page shorter than the limit is the last one — no cursor to hand back.
      const nextCursor = entries.length === criteria.limit ? entries[entries.length - 1]!.itemId : undefined;
      return ok(Object.freeze({ entries: Object.freeze(entries), ...(nextCursor === undefined ? {} : { nextCursor }) }));
    } catch {
      // Never the statement or the driver's message (§8): a caller can only act on "could not be read".
      return err(validationError('PERSISTENCE_REJECTED', 'the published catalogue could not be read', 'catalogue'));
    }
  }
}
