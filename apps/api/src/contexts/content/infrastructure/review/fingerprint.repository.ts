import type { Pool } from 'pg';
import { err, ok, type Result } from '../../domain/result.js';
import { validationError } from '../../domain/content-error.js';
import type {
  FingerprintRepository,
  ItemFingerprintRecord,
  RepositoryError,
} from '../../domain/repository-ports.js';
import { trigramSimilarity, rankCandidates } from '../../domain/review/trigram.js';

/**
 * The fingerprint store and its narrowing index (M4-20, DEC-M4-2).
 *
 * `findByExactHash`/`findBySkeletonHash` are the authoritative lookups —
 * exact-match, B-tree backed (the indexes land with the table, M4-17), and
 * neither ever references `normalized_text` or the trigram index. A spec
 * proves this by running both against a database with `pg_trgm` uninstalled:
 * they still answer correctly, because they never needed the extension.
 *
 * `findSimilarCandidates` is the one query with two paths, chosen by
 * checking `pg_extension` rather than by catching a failure — a caught
 * exception is indistinguishable from "the query was wrong" from the
 * outside, and this is a routing decision, not a fault.
 */

interface FingerprintRow {
  readonly item_id: string;
  readonly item_version_id: string;
  readonly subject: string;
  readonly exact_hash: string;
  readonly skeleton_hash: string;
  readonly normalized_text: string;
  readonly computed_at: Date;
}

function toIsoInstant(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, '.000Z');
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'itemFingerprint');
}

const SELECT = `SELECT item_id, item_version_id, subject, exact_hash, skeleton_hash, normalized_text, computed_at
                  FROM content.item_fingerprint`;

export class PostgresFingerprintRepository implements FingerprintRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(fingerprint: ItemFingerprintRecord): Promise<Result<true, RepositoryError>> {
    try {
      await this.#pool.query(
        `INSERT INTO content.item_fingerprint
           (item_version_id, item_id, subject, exact_hash, skeleton_hash, normalized_text, computed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (item_version_id) DO UPDATE SET
           subject = EXCLUDED.subject,
           exact_hash = EXCLUDED.exact_hash,
           skeleton_hash = EXCLUDED.skeleton_hash,
           normalized_text = EXCLUDED.normalized_text,
           computed_at = EXCLUDED.computed_at`,
        [
          fingerprint.itemVersionId,
          fingerprint.itemId,
          fingerprint.subject,
          fingerprint.exactHash,
          fingerprint.skeletonHash,
          fingerprint.normalizedText,
          fingerprint.computedAt,
        ],
      );
      return ok(true);
    } catch (error) {
      return err(persistenceRejected((error as Error).message));
    }
  }

  async findByItemVersionId(itemVersionId: string): Promise<Result<ItemFingerprintRecord | undefined, RepositoryError>> {
    const found = await this.#pool.query<FingerprintRow>(`${SELECT} WHERE item_version_id = $1`, [itemVersionId]);
    return ok(found.rows[0] === undefined ? undefined : this.#hydrate(found.rows[0]));
  }

  async findByExactHash(
    subject: string,
    exactHash: string,
  ): Promise<Result<readonly ItemFingerprintRecord[], RepositoryError>> {
    const found = await this.#pool.query<FingerprintRow>(
      `${SELECT} WHERE subject = $1 AND exact_hash = $2 ORDER BY item_version_id`,
      [subject, exactHash],
    );
    return ok(found.rows.map((row) => this.#hydrate(row)));
  }

  async findBySkeletonHash(
    subject: string,
    skeletonHash: string,
  ): Promise<Result<readonly ItemFingerprintRecord[], RepositoryError>> {
    const found = await this.#pool.query<FingerprintRow>(
      `${SELECT} WHERE subject = $1 AND skeleton_hash = $2 ORDER BY item_version_id`,
      [subject, skeletonHash],
    );
    return ok(found.rows.map((row) => this.#hydrate(row)));
  }

  async findSimilarCandidates(
    subject: string,
    normalizedText: string,
    limit: number,
  ): Promise<Result<readonly { readonly fingerprint: ItemFingerprintRecord; readonly similarity: number }[], RepositoryError>> {
    try {
      const trigramAvailable = await this.#trigramExtensionAvailable();
      const pool = trigramAvailable
        ? await this.#narrowViaTrigramIndex(subject, normalizedText)
        : await this.#fullScan(subject);

      const ranked = rankCandidates(
        pool.map((record) => ({
          id: record.itemVersionId,
          similarity: trigramSimilarity(normalizedText, record.normalizedText),
        })),
        limit,
      );
      const byId = new Map(pool.map((record) => [record.itemVersionId, record]));
      return ok(
        ranked.map((candidate) => ({
          fingerprint: byId.get(candidate.id)!,
          similarity: candidate.similarity,
        })),
      );
    } catch (error) {
      return err(persistenceRejected((error as Error).message));
    }
  }

  async #trigramExtensionAvailable(): Promise<boolean> {
    // `SELECT EXISTS (...)` always returns exactly one row — there is no
    // second case for a `?? false` to guard, so none is written.
    const found = await this.#pool.query<{ installed: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_trgm') AS installed`,
    );
    return found.rows[0]!.installed;
  }

  /**
   * Narrowing only — `%` uses the GIN index (M4-20's migration), then the
   * caller re-scores every row itself with `trigram.ts`'s own metric, which
   * is not pg_trgm's. The threshold is set deliberately low: this row set
   * only has to be a *superset* of the true top-N, and a permissive filter
   * costs a few extra rows to re-score in exchange for never excluding one
   * that belonged.
   */
  async #narrowViaTrigramIndex(subject: string, normalizedText: string): Promise<readonly ItemFingerprintRecord[]> {
    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL pg_trgm.similarity_threshold = 0.1');
      const found = await client.query<FingerprintRow>(
        `${SELECT} WHERE subject = $1 AND normalized_text % $2`,
        [subject, normalizedText],
      );
      await client.query('COMMIT');
      return found.rows.map((row) => this.#hydrate(row));
    } finally {
      // Unconditional and idempotent: a `ROLLBACK` after a successful
      // `COMMIT` is a harmless no-op (no transaction in progress), which is
      // what lets the same cleanup handle both the ordinary path and a query
      // failure — a failure propagates to `findSimilarCandidates`'s own
      // catch either way, so there is nothing for a second one to add here.
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  }

  /** The documented fallback (M4-20) — identical results to the indexed path, slower. */
  async #fullScan(subject: string): Promise<readonly ItemFingerprintRecord[]> {
    const found = await this.#pool.query<FingerprintRow>(`${SELECT} WHERE subject = $1`, [subject]);
    return found.rows.map((row) => this.#hydrate(row));
  }

  #hydrate(row: FingerprintRow): ItemFingerprintRecord {
    return Object.freeze({
      itemId: row.item_id,
      itemVersionId: row.item_version_id,
      subject: row.subject,
      exactHash: row.exact_hash,
      skeletonHash: row.skeleton_hash,
      normalizedText: row.normalized_text,
      computedAt: toIsoInstant(row.computed_at),
    });
  }
}
