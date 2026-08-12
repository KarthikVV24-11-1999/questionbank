import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { conflictError, notFoundError, validationError } from '../domain/content-error.js';
import type { MediaAssetRepository, RepositoryError } from '../domain/repository-ports.js';
import {
  reconstituteMediaAsset,
  type AllowedMimeType,
  type AssetType,
  type MediaAsset,
  type MediaAssetVersion,
} from '../domain/media-asset.js';
import type { LifecycleState } from '../domain/item-lifecycle.js';
import type { LicensingStatus } from '../domain/licensing-status.js';

/**
 * The casing boundary for `MediaAsset` (§2).
 *
 * **No bytes cross this file.** The aggregate holds a `storageKey` and a
 * `checksum`; the object lives behind the `MediaStore` port (M3-27). A spec
 * asserts the module declares no byte-bearing field, which is the check that
 * would have caught a base64 blob before it became a table nobody can migrate.
 *
 * **The usage graph is read here and written by the content repositories.**
 * Each of item, stimulus and solution writes its own edges as it saves a
 * version, because the edge is derived from that version's document. This file
 * only *counts* them — and it counts across all three owners in one query,
 * since "is anything published using this asset" is the question FR-QM-06
 * rule 3 asks, not "how many of each kind".
 */

interface AssetRow {
  readonly asset_id: string;
  readonly asset_type: AssetType;
  readonly lifecycle_state: LifecycleState;
  readonly current_published_version_id: string | null;
  readonly retirement_reason: string | null;
  readonly aggregate_version: number;
}

interface VersionRow {
  readonly asset_version_id: string;
  readonly version_no: number;
  readonly storage_key: string;
  readonly checksum: string;
  readonly mime_type: AllowedMimeType;
  readonly width: number;
  readonly height: number;
  readonly alt_text: string;
  readonly long_description: string | null;
  readonly authored_by_kind: 'human' | 'ai_agent' | 'system';
  readonly authored_by_id: string;
  readonly created_at: Date;
}

interface LicensingRow {
  readonly owner_version_id: string;
  readonly status: LicensingStatus['status'];
  readonly license_ref: string | null;
  readonly attribution: string | null;
  readonly expires_at: Date | null;
}

type WithoutNulls<T> = { [K in keyof T]?: Exclude<T[K], null> };

function omitNulls<T extends Record<string, unknown>>(source: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== null),
  ) as WithoutNulls<T>;
}

function toIsoInstant(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, '.000Z');
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'mediaAsset');
}

export class PostgresMediaAssetRepository implements MediaAssetRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(asset: MediaAsset): Promise<Result<MediaAsset, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<MediaAsset, RepositoryError>;

    // No `finally` — see the note in `item.repository.ts`.
    try {
      await client.query('BEGIN');
      outcome = await this.#saveWithin(client, asset);
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }

  async #saveWithin(client: PoolClient, asset: MediaAsset): Promise<Result<MediaAsset, RepositoryError>> {
    const existing = await client.query<{ aggregate_version: number }>(
      `SELECT aggregate_version FROM content.media_asset WHERE asset_id = $1 FOR UPDATE`,
      [asset.assetId],
    );

    if (existing.rowCount === 0) {
      await client.query(
        `INSERT INTO content.media_asset (asset_id, asset_type, lifecycle_state, aggregate_version)
         VALUES ($1, $2, 'draft', $3)`,
        [asset.assetId, asset.assetType, asset.aggregateVersion],
      );
    } else {
      const stored = existing.rows[0]!.aggregate_version;
      if (stored >= asset.aggregateVersion) {
        return err(
          conflictError(
            'CONFLICT',
            `media asset ${asset.assetId} moved on: stored aggregate version ${stored}, attempted ${asset.aggregateVersion}`,
            'aggregateVersion',
          ),
        );
      }
    }

    for (const version of asset.versions) {
      await this.#saveVersion(client, asset.assetId, version);
    }

    if (asset.currentPublishedVersionId !== undefined) {
      await client.query(
        `UPDATE content.media_asset_version SET published_at = now()
          WHERE asset_version_id = $1 AND published_at IS NULL`,
        [asset.currentPublishedVersionId],
      );
    }

    await client.query(
      `UPDATE content.media_asset
          SET lifecycle_state = $2,
              current_published_version_id = $3,
              retirement_reason = $4,
              aggregate_version = $5
        WHERE asset_id = $1`,
      [
        asset.assetId,
        asset.lifecycleState,
        asset.currentPublishedVersionId ?? null,
        asset.retirementReason ?? null,
        asset.aggregateVersion,
      ],
    );

    return ok(asset);
  }

  async #saveVersion(client: PoolClient, assetId: string, version: MediaAssetVersion): Promise<void> {
    const known = await client.query(
      `SELECT 1 FROM content.media_asset_version WHERE asset_version_id = $1`,
      [version.versionId],
    );
    if (known.rowCount !== 0) return;

    await client.query(
      `INSERT INTO content.media_asset_version
         (asset_version_id, asset_id, version_no, storage_key, checksum, mime_type, width, height,
          alt_text, long_description, authored_by_kind, authored_by_id, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        version.versionId,
        assetId,
        version.versionNo,
        version.storageKey,
        version.checksum,
        version.mimeType,
        version.width,
        version.height,
        version.altText,
        version.longDescription ?? null,
        version.authoredBy.kind,
        version.authoredBy.id,
        version.createdAt,
      ],
    );

    await client.query(
      `INSERT INTO content.content_licensing
         (owner_type, owner_version_id, status, license_ref, attribution, expires_at)
       VALUES ('media_asset_version', $1, $2, $3, $4, $5)`,
      [
        version.versionId,
        version.licensing.status,
        version.licensing.licenseRef ?? null,
        version.licensing.attribution ?? null,
        version.licensing.expiresAt ?? null,
      ],
    );
  }

  async findById(assetId: string): Promise<Result<MediaAsset, RepositoryError>> {
    const found = await this.#pool.query<AssetRow>(
      `SELECT asset_id, asset_type, lifecycle_state, current_published_version_id,
              retirement_reason, aggregate_version
         FROM content.media_asset WHERE asset_id = $1`,
      [assetId],
    );
    if (found.rowCount === 0) {
      return err(notFoundError('NOT_FOUND', `no media asset ${assetId}`, 'assetId'));
    }

    const row = found.rows[0]!;
    const [versions, licensings] = await Promise.all([
      this.#pool.query<VersionRow>(
        `SELECT asset_version_id, version_no, storage_key, checksum, mime_type, width, height,
                alt_text, long_description, authored_by_kind, authored_by_id, created_at
           FROM content.media_asset_version WHERE asset_id = $1 ORDER BY version_no`,
        [assetId],
      ),
      this.#pool.query<LicensingRow>(
        `SELECT l.owner_version_id, l.status, l.license_ref, l.attribution, l.expires_at
           FROM content.content_licensing l
           JOIN content.media_asset_version v ON v.asset_version_id = l.owner_version_id
          WHERE l.owner_type = 'media_asset_version' AND v.asset_id = $1`,
        [assetId],
      ),
    ]);

    const hydrated: MediaAssetVersion[] = versions.rows.map((version) => {
      const licensingRow = licensings.rows.find(
        (entry) => entry.owner_version_id === version.asset_version_id,
      );
      return Object.freeze({
        versionId: version.asset_version_id,
        versionNo: version.version_no,
        storageKey: version.storage_key,
        checksum: version.checksum,
        mimeType: version.mime_type,
        width: version.width,
        height: version.height,
        altText: version.alt_text,
        ...(version.long_description === null ? {} : { longDescription: version.long_description }),
        licensing: Object.freeze({
          status: licensingRow?.status ?? 'unresolved',
          ...omitNulls({
            licenseRef: licensingRow?.license_ref ?? null,
            attribution: licensingRow?.attribution ?? null,
            expiresAt:
              licensingRow?.expires_at === undefined || licensingRow.expires_at === null
                ? null
                : toIsoInstant(licensingRow.expires_at),
          }),
        }),
        authoredBy: Object.freeze({
          kind: version.authored_by_kind,
          id: version.authored_by_id,
          roleContext: Object.freeze([]),
        }),
        createdAt: toIsoInstant(version.created_at),
      });
    });

    const asset = reconstituteMediaAsset({
      assetId: row.asset_id,
      assetType: row.asset_type,
      lifecycleState: row.lifecycle_state,
      versions: hydrated,
      aggregateVersion: row.aggregate_version,
      ...(row.current_published_version_id === null
        ? {}
        : { currentPublishedVersionId: row.current_published_version_id }),
      ...(row.retirement_reason === null ? {} : { retirementReason: row.retirement_reason }),
    });

    return asset.ok
      ? ok(asset.value)
      : err(
          persistenceRejected(
            `stored media asset ${row.asset_id} does not reconstitute: ${asset.error.message}`,
          ),
        );
  }

  async findPublishedVersion(assetId: string): Promise<Result<MediaAssetVersion, RepositoryError>> {
    const asset = await this.findById(assetId);
    if (!asset.ok) return err(asset.error);

    const published = asset.value.versions.find(
      (version) => version.versionId === asset.value.currentPublishedVersionId,
    );
    return published === undefined
      ? err(notFoundError('NOT_FOUND', `media asset ${assetId} has no published version`, 'assetId'))
      : ok(published);
  }

  /**
   * One query across all three owner kinds. Published content only: a draft
   * referencing an asset is not circulating, so it does not block retirement
   * — but a *suspended* item is still pinned and can be reinstated, so it
   * counts.
   */
  async countReferencingPublishedContent(
    assetVersionId: string,
  ): Promise<Result<number, RepositoryError>> {
    const result = await this.#pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM content.content_media_ref r
        WHERE r.media_asset_version_id = $1
          AND (
            EXISTS (
              SELECT 1 FROM content.item i
               WHERE r.owner_type = 'item_version'
                 AND i.current_published_version_id = r.owner_version_id
                 AND i.lifecycle_state IN ('published', 'suspended')
                 AND i.deleted_at IS NULL)
            OR EXISTS (
              SELECT 1 FROM content.stimulus s
               WHERE r.owner_type = 'stimulus_version'
                 AND s.current_published_version_id = r.owner_version_id
                 AND s.lifecycle_state IN ('published', 'suspended'))
            OR EXISTS (
              SELECT 1 FROM content.solution sol
               WHERE r.owner_type = 'solution_version'
                 AND sol.current_published_version_id = r.owner_version_id
                 AND sol.lifecycle_state IN ('published', 'suspended'))
          )`,
      [assetVersionId],
    );
    return ok(Number(result.rows[0]!.count));
  }
}
