import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import { conflictError, notFoundError, validationError } from '../domain/content-error.js';
import type { RepositoryError, StimulusRepository } from '../domain/repository-ports.js';
import { reconstituteStimulus, type Stimulus, type StimulusVersion, type StimulusType } from '../domain/stimulus.js';
import type { LifecycleState } from '../domain/item-lifecycle.js';
import type { ContentBody } from '../domain/content-body.js';
import { projectContentBody } from '../domain/content-body-projections.js';
import type { LicensingStatus } from '../domain/licensing-status.js';

/**
 * The casing boundary for `Stimulus` (§2), and the same discipline the item
 * repository keeps: projections recomputed rather than accepted, licensing in
 * `content_licensing`, and `published_at` stamped so INV-03's trigger arms
 * against the application's own writes rather than only against `psql`.
 *
 * **The reference count FR-TCH-03 rule 3 needs is not here.** It counts
 * *items*, so it lives on `ItemRepository` — one query, one implementation.
 * The handler that retires a stimulus (M3-26) reads it from there.
 */

interface StimulusRow {
  readonly stimulus_id: string;
  readonly stimulus_type: StimulusType;
  readonly lifecycle_state: LifecycleState;
  readonly current_published_version_id: string | null;
  readonly retirement_reason: string | null;
  readonly aggregate_version: number;
}

interface VersionRow {
  readonly stimulus_version_id: string;
  readonly version_no: number;
  readonly body: ContentBody;
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
  return validationError('PERSISTENCE_REJECTED', message, 'stimulus');
}

export class PostgresStimulusRepository implements StimulusRepository {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(stimulus: Stimulus): Promise<Result<Stimulus, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<Stimulus, RepositoryError>;

    // No `finally` — see the note in `item.repository.ts`.
    try {
      await client.query('BEGIN');
      outcome = await this.#saveWithin(client, stimulus);
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }

  async #saveWithin(client: PoolClient, stimulus: Stimulus): Promise<Result<Stimulus, RepositoryError>> {
    const existing = await client.query<{ aggregate_version: number }>(
      `SELECT aggregate_version FROM content.stimulus WHERE stimulus_id = $1 FOR UPDATE`,
      [stimulus.stimulusId],
    );

    if (existing.rowCount === 0) {
      // Inserted as a draft naming no version; the real state lands in the
      // final UPDATE, once the versions exist for the foreign key to resolve.
      await client.query(
        `INSERT INTO content.stimulus (stimulus_id, stimulus_type, lifecycle_state, aggregate_version)
         VALUES ($1, $2, 'draft', $3)`,
        [stimulus.stimulusId, stimulus.stimulusType, stimulus.aggregateVersion],
      );
    } else {
      const stored = existing.rows[0]!.aggregate_version;
      if (stored >= stimulus.aggregateVersion) {
        return err(
          conflictError(
            'CONFLICT',
            `stimulus ${stimulus.stimulusId} moved on: stored aggregate version ${stored}, attempted ${stimulus.aggregateVersion}`,
            'aggregateVersion',
          ),
        );
      }
    }

    for (const version of stimulus.versions) {
      await this.#saveVersion(client, stimulus.stimulusId, version);
    }

    if (stimulus.currentPublishedVersionId !== undefined) {
      await client.query(
        `UPDATE content.stimulus_version SET published_at = now()
          WHERE stimulus_version_id = $1 AND published_at IS NULL`,
        [stimulus.currentPublishedVersionId],
      );
    }

    await client.query(
      `UPDATE content.stimulus
          SET lifecycle_state = $2,
              current_published_version_id = $3,
              retirement_reason = $4,
              aggregate_version = $5
        WHERE stimulus_id = $1`,
      [
        stimulus.stimulusId,
        stimulus.lifecycleState,
        stimulus.currentPublishedVersionId ?? null,
        stimulus.retirementReason ?? null,
        stimulus.aggregateVersion,
      ],
    );

    return ok(stimulus);
  }

  async #saveVersion(client: PoolClient, stimulusId: string, version: StimulusVersion): Promise<void> {
    const known = await client.query(
      `SELECT 1 FROM content.stimulus_version WHERE stimulus_version_id = $1`,
      [version.versionId],
    );
    // Published versions are immutable, so an existing one is left alone
    // rather than rewritten with identical values.
    if (known.rowCount !== 0) return;

    const projections = projectContentBody(version.body);

    await client.query(
      `INSERT INTO content.stimulus_version
         (stimulus_version_id, stimulus_id, version_no, body, body_plain_text, notation_terms,
          authored_by_kind, authored_by_id, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, $7, $8, $9)`,
      [
        version.versionId,
        stimulusId,
        version.versionNo,
        JSON.stringify(version.body),
        projections.plainText,
        [...projections.notationTerms],
        version.authoredBy.kind,
        version.authoredBy.id,
        version.createdAt,
      ],
    );

    await client.query(
      `INSERT INTO content.content_licensing
         (owner_type, owner_version_id, status, license_ref, attribution, expires_at)
       VALUES ('stimulus_version', $1, $2, $3, $4, $5)`,
      [
        version.versionId,
        version.licensing.status,
        version.licensing.licenseRef ?? null,
        version.licensing.attribution ?? null,
        version.licensing.expiresAt ?? null,
      ],
    );

    for (const assetVersionId of projections.referencedMediaIds) {
      await client.query(
        `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
         VALUES ('stimulus_version', $1, $2)
         ON CONFLICT DO NOTHING`,
        [version.versionId, assetVersionId],
      );
    }
  }

  async findById(stimulusId: string): Promise<Result<Stimulus, RepositoryError>> {
    const found = await this.#pool.query<StimulusRow>(
      `SELECT stimulus_id, stimulus_type, lifecycle_state, current_published_version_id,
              retirement_reason, aggregate_version
         FROM content.stimulus WHERE stimulus_id = $1`,
      [stimulusId],
    );
    if (found.rowCount === 0) {
      return err(notFoundError('NOT_FOUND', `no stimulus ${stimulusId}`, 'stimulusId'));
    }

    const row = found.rows[0]!;
    const [versions, licensings] = await Promise.all([
      this.#pool.query<VersionRow>(
        `SELECT stimulus_version_id, version_no, body, authored_by_kind, authored_by_id, created_at
           FROM content.stimulus_version WHERE stimulus_id = $1 ORDER BY version_no`,
        [stimulusId],
      ),
      this.#pool.query<LicensingRow>(
        `SELECT l.owner_version_id, l.status, l.license_ref, l.attribution, l.expires_at
           FROM content.content_licensing l
           JOIN content.stimulus_version v ON v.stimulus_version_id = l.owner_version_id
          WHERE l.owner_type = 'stimulus_version' AND v.stimulus_id = $1`,
        [stimulusId],
      ),
    ]);

    const hydrated: StimulusVersion[] = versions.rows.map((version) => {
      const licensingRow = licensings.rows.find(
        (entry) => entry.owner_version_id === version.stimulus_version_id,
      );
      return Object.freeze({
        versionId: version.stimulus_version_id,
        versionNo: version.version_no,
        body: version.body,
        licensing: Object.freeze({
          // No licensing row means no statement about rights was made, which
          // is what `unresolved` means — and it blocks publication.
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

    const stimulus = reconstituteStimulus({
      stimulusId: row.stimulus_id,
      stimulusType: row.stimulus_type,
      lifecycleState: row.lifecycle_state,
      versions: hydrated,
      aggregateVersion: row.aggregate_version,
      ...(row.current_published_version_id === null
        ? {}
        : { currentPublishedVersionId: row.current_published_version_id }),
      ...(row.retirement_reason === null ? {} : { retirementReason: row.retirement_reason }),
    });

    return stimulus.ok
      ? ok(stimulus.value)
      : err(
          persistenceRejected(
            `stored stimulus ${row.stimulus_id} does not reconstitute: ${stimulus.error.message}`,
          ),
        );
  }

  async findPublishedVersion(stimulusId: string): Promise<Result<StimulusVersion, RepositoryError>> {
    const stimulus = await this.findById(stimulusId);
    if (!stimulus.ok) return err(stimulus.error);

    const published = stimulus.value.versions.find(
      (version) => version.versionId === stimulus.value.currentPublishedVersionId,
    );
    return published === undefined
      ? err(notFoundError('NOT_FOUND', `stimulus ${stimulusId} has no published version`, 'stimulusId'))
      : ok(published);
  }
}
