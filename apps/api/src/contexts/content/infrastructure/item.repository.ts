import type { Pool, PoolClient } from 'pg';
import { err, ok, type Result } from '../domain/result.js';
import type { ContentEvent } from '../domain/events/content-events.js';
import { ContentOutboxEmitter } from './outbox-emitter.js';
import { conflictError, notFoundError, validationError } from '../domain/content-error.js';
import type {
  ItemRepository,
  RepositoryError,
  SubmittedForReviewCriteria,
  SubmittedForReviewPage,
} from '../domain/repository-ports.js';
import { reconstituteItem, type Item } from '../domain/item.js';
import type { ItemVersion } from '../domain/item-version.js';
import type { LifecycleState } from '../domain/item-lifecycle.js';
import type { ContentBody } from '../domain/content-body.js';
import { projectContentBody } from '../domain/content-body-projections.js';
import type { DifficultyBand } from '../domain/item-version.js';
import type { LicensingStatus } from '../domain/licensing-status.js';
import type { Provenance } from '../domain/provenance.js';
import type { TaxonomyTag } from '../domain/taxonomy-tag.js';
import type {
  ItemOption,
  ItemType,
  MatchingMember,
  NumericAnswerSpecData,
  ResponseSpecification,
} from '../domain/response-specification.js';

/**
 * The casing boundary (§2): the database is `snake_case`, the domain is
 * `camelCase`, and the mapping happens here and nowhere else.
 *
 * **The derived projections are written from the document, in the same
 * statement.** `stem_plain_text` and `notation_terms` are recomputed on every
 * save rather than accepted from the caller, because a projection that can be
 * supplied is a projection that can disagree with what it claims to summarize
 * — and the disagreement is invisible until an author swears an item exists
 * and search says otherwise.
 *
 * **Decimal literals cross as text.** `expected_value` is `text` in the schema
 * for the reason ADR-0007 gives; nothing here parses it.
 *
 * **Licensing lives in `content_licensing`**, per DATA-ARCHITECTURE §4. Its
 * owner is polymorphic and therefore carries no foreign key — the same trade
 * `content_media_ref` makes. A version with no licensing row has made no
 * statement about rights, which is what `unresolved` means, and it blocks
 * publication (FR-QM-05 rule 4).
 */

interface ItemRow {
  readonly item_id: string;
  readonly item_type: ItemType;
  readonly lifecycle_state: LifecycleState;
  readonly current_published_version_id: string | null;
  readonly retirement_reason: string | null;
  readonly replaced_by_item_id: string | null;
  readonly aggregate_version: number;
  readonly state_entered_at: Date;
  readonly authoring_subject: string;
}

interface VersionRow {
  readonly item_version_id: string;
  readonly version_no: number;
  readonly item_type: ItemType;
  readonly stem_body: ContentBody;
  readonly difficulty_estimate: DifficultyBand;
  readonly stimulus_version_id: string | null;
  readonly authored_by_kind: 'human' | 'ai_agent' | 'system';
  readonly authored_by_id: string;
  readonly edited_by_kind: 'human' | 'ai_agent' | 'system' | null;
  readonly edited_by_id: string | null;
  readonly created_at: Date;
}

interface LicensingRow {
  readonly owner_version_id: string;
  readonly status: LicensingStatus['status'];
  readonly license_ref: string | null;
  readonly attribution: string | null;
  readonly expires_at: Date | null;
}

interface OptionRow {
  readonly item_version_id: string;
  readonly option_id: string;
  readonly ordinal: number;
  readonly body: ContentBody;
  readonly is_correct: boolean;
}

interface MemberRow {
  readonly item_version_id: string;
  readonly side: 'left' | 'right';
  readonly member_id: string;
  readonly ordinal: number;
  readonly body: ContentBody;
}

interface PairRow {
  readonly item_version_id: string;
  readonly left_member_id: string;
  readonly right_member_id: string;
}

interface NumericRow {
  readonly item_version_id: string;
  readonly expected_value: string;
  readonly comparison_mode: NumericAnswerSpecData['comparisonMode'];
  readonly tolerance_value: string | null;
  readonly significant_figures: number | null;
  readonly range_min: string | null;
  readonly range_max: string | null;
  readonly unit_canonical: string | null;
  readonly unit_accepted_equivalents: readonly string[];
  readonly unit_required: boolean;
  readonly accepted_forms: readonly NumericAnswerSpecData['acceptedForms'][number][];
}

interface TagRow {
  readonly item_version_id: string;
  readonly concept_identity_id: string;
  readonly taxonomy_version_id: string;
  readonly weight: string;
  readonly is_primary: boolean;
}

interface ProvenanceRow {
  readonly item_version_id: string;
  readonly source_type: Provenance['sourceType'];
  readonly source_exam: string | null;
  readonly source_year: number | null;
  readonly source_session: string | null;
  readonly author_ref: string | null;
  readonly model_version_id: string | null;
  readonly prompt_version_id: string | null;
  readonly generation_run_id: string | null;
  readonly confidence: string | null;
  readonly import_batch_id: string | null;
}

function toIsoInstant(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, '.000Z');
}

function persistenceRejected(message: string): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', message, 'item');
}

/**
 * Only the fields a value actually has, so an absent one stays absent rather
 * than becoming `undefined`. Under `exactOptionalPropertyTypes` those are
 * different things, and the domain's constructors distinguish them.
 */
type WithoutNulls<T> = { [K in keyof T]?: Exclude<T[K], null> };

function omitNulls<T extends Record<string, unknown>>(source: T): WithoutNulls<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => value !== null),
  ) as WithoutNulls<T>;
}

export class PostgresItemRepository implements ItemRepository {
  readonly #pool: Pool;
  readonly #outbox = new ContentOutboxEmitter();

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async save(
    item: Item,
    events: readonly ContentEvent[] = [],
  ): Promise<Result<Item, RepositoryError>> {
    const client = await this.#pool.connect();
    let outcome: Result<Item, RepositoryError>;

    // No `finally`: the catch never rethrows, so the release below runs on both
    // paths. A `finally` here carries an abrupt-completion path that nothing
    // can reach — untestable code in a module the 100% rule covers. Same shape
    // as the scoring repositories, for the same reason.
    try {
      await client.query('BEGIN');
      outcome = await this.#saveWithin(client, item);
      // §9 rule 4 / P4: the events go in with the aggregate, so a rolled-back
      // change leaves nothing behind claiming it happened.
      if (outcome.ok) {
        for (const event of events) await this.#outbox.emit(client, event);
      }
      await client.query(outcome.ok ? 'COMMIT' : 'ROLLBACK');
    } catch (error) {
      await client.query('ROLLBACK');
      // Infrastructure faults are the only throws (§8); a rejected write is a
      // value so the handler can report it.
      outcome = err(persistenceRejected((error as Error).message));
    }

    client.release();
    return outcome;
  }

  async #saveWithin(client: PoolClient, item: Item): Promise<Result<Item, RepositoryError>> {
    const existing = await client.query<{ aggregate_version: number }>(
      `SELECT aggregate_version FROM content.item WHERE item_id = $1 FOR UPDATE`,
      [item.itemId],
    );

    if (existing.rowCount === 0) {
      // Inserted as a draft naming no version, whatever state the aggregate is
      // actually in. `item_published_names_a_version` is a CHECK and CHECKs
      // cannot be deferred, so a published item has to reach its real state in
      // the final UPDATE below — after its versions exist for the foreign key
      // to resolve.
      // state_entered_at: the domain-supplied instant if createItem was given
      // one, else the database's own now() — never a clock read in the
      // domain, and never NULL, since the column is NOT NULL (M4-13).
      //
      // authoring_subject is fixed at creation and never revisited by the
      // final UPDATE below — it is a fact about the item, not something a
      // later save changes (M4-14). 'unclassified' is the same placeholder
      // the migration backfills pre-existing rows with, for a caller that
      // saves an Item the domain never resolved a subject for.
      await client.query(
        `INSERT INTO content.item (item_id, item_type, lifecycle_state, aggregate_version, state_entered_at, authoring_subject)
         VALUES ($1, $2, 'draft', $3, COALESCE($4, now()), COALESCE($5, 'unclassified'))`,
        [item.itemId, item.itemType, item.aggregateVersion, item.stateEnteredAt ?? null, item.authoringSubject ?? null],
      );
    } else {
      // P8 optimistic concurrency. A stale write is a Conflict, never a silent
      // overwrite of somebody else's edit.
      const stored = existing.rows[0]!.aggregate_version;
      if (stored >= item.aggregateVersion) {
        return err(
          conflictError(
            'CONFLICT',
            `item ${item.itemId} moved on: stored aggregate version ${stored}, attempted ${item.aggregateVersion}`,
            'aggregateVersion',
          ),
        );
      }
    }

    for (const version of item.versions) {
      await this.#saveVersion(client, item.itemId, version);
    }

    // Arm the immutability trigger. Without this the trigger from
    // `*_content_immutability.sql` never fires for anything the application
    // writes — INV-03 would hold against psql and not against us, which is
    // exactly backwards. Set only while still NULL, so republishing a
    // superseded version cannot move the instant it was first published.
    //
    // `now()` is read in infrastructure, which is where clocks belong; the
    // domain still supplies every instant it reasons about.
    if (item.currentPublishedVersionId !== undefined) {
      await client.query(
        `UPDATE content.item_version SET published_at = now()
          WHERE item_version_id = $1 AND published_at IS NULL`,
        [item.currentPublishedVersionId],
      );
    }

    // State and published version move together, and last. The column
    // references item_version, so the version must exist; the CHECK requires
    // both to agree, so they cannot be set in separate statements.
    //
    // state_entered_at moves only when lifecycle_state actually changes
    // (compared against the row's own pre-update value, which is what the
    // right-hand `lifecycle_state` in the CASE reads — every SET expression
    // in one UPDATE sees the old row). An autosave (replaceDraftVersion) or
    // a version add leaves it untouched, whatever the domain object does or
    // does not carry; a real transition stamps the supplied instant, or
    // now() if the domain did not supply one.
    //
    // `$8` repeats `$2`'s value under its own placeholder rather than reusing
    // $2: the enum column's assignment context (`SET lifecycle_state = $2`)
    // and its comparison context (`IS DISTINCT FROM`) resolve an untyped
    // parameter's type by different rules, and Postgres refuses to unify one
    // placeholder across both ("inconsistent types deduced for parameter")
    // — found the hard way, by every save in this file failing at once.
    await client.query(
      `UPDATE content.item
          SET lifecycle_state = $2,
              current_published_version_id = $3,
              retirement_reason = $4,
              replaced_by_item_id = $5,
              aggregate_version = $6,
              state_entered_at = CASE
                WHEN lifecycle_state IS DISTINCT FROM $8 THEN COALESCE($7, now())
                ELSE state_entered_at
              END
        WHERE item_id = $1`,
      [
        item.itemId,
        item.lifecycleState,
        item.currentPublishedVersionId ?? null,
        item.retirementReason ?? null,
        item.replacedByItemId ?? null,
        item.aggregateVersion,
        item.stateEnteredAt ?? null,
        item.lifecycleState,
      ],
    );

    return ok(item);
  }

  async #saveVersion(client: PoolClient, itemId: string, version: ItemVersion): Promise<void> {
    const known = await client.query<{ published_at: Date | null }>(
      `SELECT published_at FROM content.item_version WHERE item_version_id = $1`,
      [version.versionId],
    );

    // A published version is immutable (INV-03) and the database enforces it,
    // so it is left exactly as it is rather than rewritten with identical
    // values — which would fail the trigger.
    //
    // **A draft version is rewritten**, because that is what the draft state is
    // for and what autosave does (FR-TCH-02 rule 6). Skipping it instead would
    // make the repository refuse an edit the database explicitly permits, and
    // the author's work would vanish silently on save.
    if (known.rowCount !== 0) {
      if (known.rows[0]!.published_at !== null) return;
      await this.#discardVersionParts(client, version.versionId);
    }

    const projections = projectContentBody(version.stem);

    await client.query(
      `INSERT INTO content.item_version
         (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, notation_terms,
          difficulty_estimate, stimulus_version_id, authored_by_kind, authored_by_id, created_at,
          edited_by_kind, edited_by_id)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       ON CONFLICT (item_version_id) DO UPDATE SET
         version_no = EXCLUDED.version_no,
         item_type = EXCLUDED.item_type,
         stem_body = EXCLUDED.stem_body,
         stem_plain_text = EXCLUDED.stem_plain_text,
         notation_terms = EXCLUDED.notation_terms,
         difficulty_estimate = EXCLUDED.difficulty_estimate,
         stimulus_version_id = EXCLUDED.stimulus_version_id,
         -- now() in infrastructure, where clocks belong. The domain models no
         -- "last edited" instant, so there is nothing for it to supply.
         updated_at = now()`,
      [
        version.versionId,
        itemId,
        version.versionNo,
        version.itemType,
        JSON.stringify(version.stem),
        projections.plainText,
        [...projections.notationTerms],
        version.difficultyEstimate,
        version.stimulusVersionRef ?? null,
        version.authoredBy.kind,
        version.authoredBy.id,
        version.createdAt,
        version.editedBy?.kind ?? null,
        version.editedBy?.id ?? null,
      ],
    );

    await client.query(
      `INSERT INTO content.content_licensing
         (owner_type, owner_version_id, status, license_ref, attribution, expires_at)
       VALUES ('item_version', $1, $2, $3, $4, $5)`,
      [
        version.versionId,
        version.licensing.status,
        version.licensing.licenseRef ?? null,
        version.licensing.attribution ?? null,
        version.licensing.expiresAt ?? null,
      ],
    );

    await this.#saveResponseSpec(client, version.versionId, version.responseSpec);
    await this.#saveTags(client, version.versionId, version.taxonomyTags);
    await this.#saveProvenance(client, version.versionId, version.provenance);
    await this.#saveMediaRefs(client, version.versionId, projections.referencedMediaIds);
  }

  /**
   * Clears everything that belongs to a draft version before it is rewritten,
   * so the edge set, the option set and the tag set are **reconciled** rather
   * than accumulated: an option the author deleted has to disappear, and a
   * media reference they removed has to leave the usage graph or an unused
   * asset stays unretirable forever (FR-QM-06 rule 3).
   *
   * Every one of these tables carries the `*_frozen_with_its_version` trigger,
   * so this is refused outright once the owning version publishes — the caller
   * above never reaches here in that case, and the trigger is the backstop.
   */
  async #discardVersionParts(client: PoolClient, versionId: string): Promise<void> {
    // Pairs before members: the pair's composite foreign key names the member.
    for (const table of [
      'item_matching_pair',
      'item_matching_member',
      'item_option',
      'item_numeric_spec',
      'item_taxonomy_tag',
      'item_provenance',
    ]) {
      await client.query(`DELETE FROM content.${table} WHERE item_version_id = $1`, [versionId]);
    }
    await client.query(
      `DELETE FROM content.content_licensing WHERE owner_type = 'item_version' AND owner_version_id = $1`,
      [versionId],
    );
    await client.query(
      `DELETE FROM content.content_media_ref WHERE owner_type = 'item_version' AND owner_version_id = $1`,
      [versionId],
    );
  }

  async #saveResponseSpec(
    client: PoolClient,
    versionId: string,
    spec: ResponseSpecification,
  ): Promise<void> {
    switch (spec.itemType) {
      case 'SINGLE_CORRECT_MCQ':
      case 'MULTIPLE_CORRECT_MCQ': {
        const correct =
          spec.itemType === 'SINGLE_CORRECT_MCQ' ? [spec.correctOptionId] : [...spec.correctOptionIds];
        for (const option of spec.options) {
          await client.query(
            `INSERT INTO content.item_option
               (item_version_id, option_id, ordinal, body, body_plain_text, is_correct)
             VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
            [
              versionId,
              option.optionId,
              option.ordinal,
              JSON.stringify(option.body),
              projectContentBody(option.body).plainText,
              correct.includes(option.optionId),
            ],
          );
        }
        return;
      }

      case 'MATCHING': {
        const write = async (side: 'left' | 'right', members: readonly MatchingMember[]): Promise<void> => {
          for (const member of members) {
            await client.query(
              `INSERT INTO content.item_matching_member
                 (item_version_id, side, member_id, ordinal, body, body_plain_text)
               VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
              [
                versionId,
                side,
                member.memberId,
                member.ordinal,
                JSON.stringify(member.body),
                projectContentBody(member.body).plainText,
              ],
            );
          }
        };
        await write('left', spec.left);
        await write('right', spec.right);
        for (const pair of spec.pairs) {
          await client.query(
            `INSERT INTO content.item_matching_pair (item_version_id, left_member_id, right_member_id)
             VALUES ($1, $2, $3)`,
            [versionId, pair.left, pair.right],
          );
        }
        return;
      }

      case 'NUMERIC':
        await client.query(
          `INSERT INTO content.item_numeric_spec
             (item_version_id, expected_value, comparison_mode, tolerance_value, significant_figures,
              range_min, range_max, unit_canonical, unit_accepted_equivalents, unit_required, accepted_forms)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            versionId,
            // Text in, text out. Never parsed here (ADR-0007).
            spec.spec.expectedValue,
            spec.spec.comparisonMode,
            spec.spec.toleranceValue ?? null,
            spec.spec.significantFigures ?? null,
            spec.spec.rangeMin ?? null,
            spec.spec.rangeMax ?? null,
            spec.spec.unit?.canonical ?? null,
            [...(spec.spec.unit?.acceptedEquivalents ?? [])],
            spec.spec.unit?.required ?? false,
            [...spec.spec.acceptedForms],
          ],
        );
    }
  }

  async #saveTags(client: PoolClient, versionId: string, tags: readonly TaxonomyTag[]): Promise<void> {
    for (const tag of tags) {
      await client.query(
        `INSERT INTO content.item_taxonomy_tag
           (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
         VALUES ($1, $2, $3, $4, $5)`,
        [versionId, tag.conceptIdentityId, tag.taxonomyVersionId, tag.weight, tag.isPrimary],
      );
    }
  }

  async #saveProvenance(client: PoolClient, versionId: string, provenance: Provenance): Promise<void> {
    await client.query(
      `INSERT INTO content.item_provenance
         (item_version_id, source_type, source_exam, source_year, source_session, author_ref,
          model_version_id, prompt_version_id, generation_run_id, confidence, import_batch_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        versionId,
        provenance.sourceType,
        provenance.sourceExam ?? null,
        provenance.sourceYear ?? null,
        provenance.sourceSession ?? null,
        provenance.authorRef ?? null,
        provenance.modelVersionId ?? null,
        provenance.promptVersionId ?? null,
        provenance.generationRunId ?? null,
        provenance.confidence ?? null,
        provenance.importBatchId ?? null,
      ],
    );
  }

  /**
   * The usage graph, derived from the document and written with it. Deriving
   * it later would leave a window in which an in-use asset reads as unused and
   * can be retired (FR-QM-06 rule 3).
   */
  async #saveMediaRefs(
    client: PoolClient,
    versionId: string,
    assetVersionIds: readonly string[],
  ): Promise<void> {
    for (const assetVersionId of assetVersionIds) {
      await client.query(
        `INSERT INTO content.content_media_ref (owner_type, owner_version_id, media_asset_version_id)
         VALUES ('item_version', $1, $2)
         ON CONFLICT DO NOTHING`,
        [versionId, assetVersionId],
      );
    }
  }

  async findById(itemId: string): Promise<Result<Item, RepositoryError>> {
    const items = await this.#pool.query<ItemRow>(
      `SELECT item_id, item_type, lifecycle_state, current_published_version_id,
              retirement_reason, replaced_by_item_id, aggregate_version, state_entered_at, authoring_subject
         FROM content.item WHERE item_id = $1 AND deleted_at IS NULL`,
      [itemId],
    );
    if (items.rowCount === 0) {
      return err(notFoundError('NOT_FOUND', `no item ${itemId}`, 'itemId'));
    }
    return this.#hydrate(items.rows[0]!);
  }

  /**
   * FR-TCH-06 rule 3. `item_only_drafts_are_deleted` refuses anything that is
   * not an unpublished draft, so the guarantee does not depend on the handler
   * having checked first — but the handler does check, because the domain owns
   * the rule and a CHECK cannot produce a message an author can act on.
   */
  async deleteDraft(itemId: string): Promise<Result<true, RepositoryError>> {
    try {
      const deleted = await this.#pool.query(
        `UPDATE content.item SET deleted_at = now()
          WHERE item_id = $1 AND deleted_at IS NULL`,
        [itemId],
      );
      return deleted.rowCount === 0
        ? err(notFoundError('NOT_FOUND', `no item ${itemId} to delete`, 'itemId'))
        : ok(true);
    } catch (error) {
      return err(persistenceRejected((error as Error).message));
    }
  }

  async findDraftsByAuthor(authorId: string): Promise<Result<readonly Item[], RepositoryError>> {
    // FR-TCH-06 rule 1. Authorship is per version, so an item counts as the
    // author's when they wrote its latest version.
    const items = await this.#pool.query<ItemRow>(
      `SELECT DISTINCT i.item_id, i.item_type, i.lifecycle_state, i.current_published_version_id,
              i.retirement_reason, i.replaced_by_item_id, i.aggregate_version, i.state_entered_at, i.authoring_subject
         FROM content.item i
         JOIN content.item_version v ON v.item_id = i.item_id
        WHERE i.deleted_at IS NULL
          AND i.lifecycle_state = 'draft'
          AND v.authored_by_id = $1
        ORDER BY i.item_id`,
      [authorId],
    );

    const hydrated: Item[] = [];
    for (const row of items.rows) {
      const item = await this.#hydrate(row);
      if (!item.ok) return err(item.error);
      hydrated.push(item.value);
    }
    return ok(hydrated);
  }

  async findPublishedVersion(itemId: string): Promise<Result<ItemVersion, RepositoryError>> {
    const item = await this.findById(itemId);
    if (!item.ok) return err(item.error);

    const published = item.value.versions.find(
      (version) => version.versionId === item.value.currentPublishedVersionId,
    );
    return published === undefined
      ? err(notFoundError('NOT_FOUND', `item ${itemId} has no published version`, 'itemId'))
      : ok(published);
  }

  async countPublishedItemsUsingStimulusVersion(
    stimulusVersionId: string,
  ): Promise<Result<number, RepositoryError>> {
    const result = await this.#pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM content.item i
         JOIN content.item_version v ON v.item_version_id = i.current_published_version_id
        WHERE v.stimulus_version_id = $1
          AND i.lifecycle_state IN ('published', 'suspended')
          AND i.deleted_at IS NULL`,
      [stimulusVersionId],
    );
    return ok(Number(result.rows[0]!.count));
  }

  /**
   * The review queue's candidate source (M4-16). The state restriction is a
   * `WHERE`, never a post-filter: only `in_review` items can leave this
   * query, on any argument. Paged by keyset on `item_id` (UUIDv7, so
   * ascending order is also insertion order) rather than `OFFSET`, which a
   * concurrent insert would shift a page boundary through — keyset never
   * duplicates or skips a row, because `> cursor` names a fixed point instead
   * of a position that moves under it.
   */
  async findSubmittedForReview(
    criteria: SubmittedForReviewCriteria,
  ): Promise<Result<SubmittedForReviewPage, RepositoryError>> {
    const items = await this.#pool.query<ItemRow>(
      `SELECT i.item_id, i.item_type, i.lifecycle_state, i.current_published_version_id,
              i.retirement_reason, i.replaced_by_item_id, i.aggregate_version, i.state_entered_at,
              i.authoring_subject
         FROM content.item i
         JOIN content.item_version v
           ON v.item_id = i.item_id
          AND v.version_no = (SELECT max(v2.version_no) FROM content.item_version v2 WHERE v2.item_id = i.item_id)
        WHERE i.deleted_at IS NULL
          AND i.lifecycle_state = 'in_review'
          AND ($1::text IS NULL OR i.authoring_subject = $1)
          AND ($2::uuid IS NULL OR v.authored_by_id <> $2)
          AND ($3::uuid IS NULL OR i.item_id > $3)
        ORDER BY i.item_id
        LIMIT $4`,
      [criteria.subject ?? null, criteria.excludeAuthorId ?? null, criteria.cursor ?? null, criteria.limit],
    );

    const hydrated: Item[] = [];
    for (const row of items.rows) {
      const item = await this.#hydrate(row);
      if (!item.ok) return err(item.error);
      hydrated.push(item.value);
    }

    // A page shorter than the limit is the last one — no cursor to hand back.
    const nextCursor =
      hydrated.length === criteria.limit ? hydrated[hydrated.length - 1]!.itemId : undefined;

    return ok(
      Object.freeze({
        items: Object.freeze(hydrated),
        ...(nextCursor === undefined ? {} : { nextCursor }),
      }),
    );
  }

  async #hydrate(row: ItemRow): Promise<Result<Item, RepositoryError>> {
    const versions = await this.#pool.query<VersionRow>(
      `SELECT item_version_id, version_no, item_type, stem_body, difficulty_estimate,
              stimulus_version_id, authored_by_kind, authored_by_id, created_at,
              edited_by_kind, edited_by_id
         FROM content.item_version WHERE item_id = $1 ORDER BY version_no`,
      [row.item_id],
    );

    const versionIds = versions.rows.map((version) => version.item_version_id);
    const [options, members, pairs, numerics, tags, provenances, licensings] = await Promise.all([
      this.#pool.query<OptionRow>(
        `SELECT item_version_id, option_id, ordinal, body, is_correct
           FROM content.item_option WHERE item_version_id = ANY($1::uuid[]) ORDER BY ordinal`,
        [versionIds],
      ),
      this.#pool.query<MemberRow>(
        `SELECT item_version_id, side, member_id, ordinal, body
           FROM content.item_matching_member WHERE item_version_id = ANY($1::uuid[]) ORDER BY side, ordinal`,
        [versionIds],
      ),
      this.#pool.query<PairRow>(
        `SELECT item_version_id, left_member_id, right_member_id
           FROM content.item_matching_pair WHERE item_version_id = ANY($1::uuid[]) ORDER BY left_member_id`,
        [versionIds],
      ),
      this.#pool.query<NumericRow>(
        `SELECT * FROM content.item_numeric_spec WHERE item_version_id = ANY($1::uuid[])`,
        [versionIds],
      ),
      this.#pool.query<TagRow>(
        `SELECT item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary
           FROM content.item_taxonomy_tag WHERE item_version_id = ANY($1::uuid[])
          ORDER BY is_primary DESC, concept_identity_id`,
        [versionIds],
      ),
      this.#pool.query<ProvenanceRow>(
        `SELECT * FROM content.item_provenance WHERE item_version_id = ANY($1::uuid[])`,
        [versionIds],
      ),
      this.#pool.query<LicensingRow>(
        `SELECT owner_version_id, status, license_ref, attribution, expires_at
           FROM content.content_licensing
          WHERE owner_type = 'item_version' AND owner_version_id = ANY($1::uuid[])`,
        [versionIds],
      ),
    ]);

    const hydratedVersions: ItemVersion[] = versions.rows.map((version) =>
      this.#hydrateVersion(version, {
        options: options.rows.filter((entry) => entry.item_version_id === version.item_version_id),
        members: members.rows.filter((entry) => entry.item_version_id === version.item_version_id),
        pairs: pairs.rows.filter((entry) => entry.item_version_id === version.item_version_id),
        numeric: numerics.rows.find((entry) => entry.item_version_id === version.item_version_id),
        tags: tags.rows.filter((entry) => entry.item_version_id === version.item_version_id),
        provenance: provenances.rows.find((entry) => entry.item_version_id === version.item_version_id),
        licensing: licensings.rows.find((entry) => entry.owner_version_id === version.item_version_id),
      }),
    );

    const item = reconstituteItem({
      itemId: row.item_id,
      itemType: row.item_type,
      lifecycleState: row.lifecycle_state,
      versions: hydratedVersions,
      aggregateVersion: row.aggregate_version,
      ...(row.current_published_version_id === null
        ? {}
        : { currentPublishedVersionId: row.current_published_version_id }),
      ...(row.retirement_reason === null ? {} : { retirementReason: row.retirement_reason }),
      ...(row.replaced_by_item_id === null ? {} : { replacedByItemId: row.replaced_by_item_id }),
      stateEnteredAt: toIsoInstant(row.state_entered_at),
      authoringSubject: row.authoring_subject,
    });

    return item.ok
      ? ok(item.value)
      : err(persistenceRejected(`stored item ${row.item_id} does not reconstitute: ${item.error.message}`));
  }

  #hydrateVersion(
    row: VersionRow,
    parts: {
      readonly options: readonly OptionRow[];
      readonly members: readonly MemberRow[];
      readonly pairs: readonly PairRow[];
      readonly numeric: NumericRow | undefined;
      readonly tags: readonly TagRow[];
      readonly provenance: ProvenanceRow | undefined;
      readonly licensing: LicensingRow | undefined;
    },
  ): ItemVersion {
    const responseSpec = this.#hydrateResponseSpec(row.item_type, parts);

    const licensingRow = parts.licensing;
    const licensing: LicensingStatus = Object.freeze({
      // A version with no licensing row has made no statement about rights,
      // which is exactly what `unresolved` means — and it blocks publication.
      status: licensingRow?.status ?? 'unresolved',
      ...omitNulls({
        licenseRef: licensingRow?.license_ref ?? null,
        attribution: licensingRow?.attribution ?? null,
        expiresAt:
          licensingRow?.expires_at === undefined || licensingRow.expires_at === null
            ? null
            : toIsoInstant(licensingRow.expires_at),
      }),
    });

    const provenanceRow = parts.provenance;
    const provenance: Provenance = Object.freeze({
      sourceType: provenanceRow?.source_type ?? 'original',
      ...omitNulls({
        sourceExam: provenanceRow?.source_exam ?? null,
        sourceYear: provenanceRow?.source_year ?? null,
        sourceSession: provenanceRow?.source_session ?? null,
        authorRef: provenanceRow?.author_ref ?? null,
        modelVersionId: provenanceRow?.model_version_id ?? null,
        promptVersionId: provenanceRow?.prompt_version_id ?? null,
        generationRunId: provenanceRow?.generation_run_id ?? null,
        confidence: provenanceRow?.confidence === undefined || provenanceRow.confidence === null
          ? null
          : Number(provenanceRow.confidence),
        importBatchId: provenanceRow?.import_batch_id ?? null,
      }),
    });

    return Object.freeze({
      versionId: row.item_version_id,
      versionNo: row.version_no,
      itemType: row.item_type,
      stem: row.stem_body,
      responseSpec,
      taxonomyTags: Object.freeze(
        parts.tags.map((tag) =>
          Object.freeze({
            conceptIdentityId: tag.concept_identity_id,
            taxonomyVersionId: tag.taxonomy_version_id,
            weight: Number(tag.weight),
            isPrimary: tag.is_primary,
          }),
        ),
      ),
      difficultyEstimate: row.difficulty_estimate,
      provenance,
      licensing,
      ...(row.stimulus_version_id === null ? {} : { stimulusVersionRef: row.stimulus_version_id }),
      authoredBy: Object.freeze({
        kind: row.authored_by_kind,
        id: row.authored_by_id,
        roleContext: Object.freeze([]),
      }),
      createdAt: toIsoInstant(row.created_at),
      ...(row.edited_by_kind === null || row.edited_by_id === null
        ? {}
        : {
            editedBy: Object.freeze({
              kind: row.edited_by_kind,
              id: row.edited_by_id,
              roleContext: Object.freeze([]),
            }),
          }),
    });
  }

  #hydrateResponseSpec(
    itemType: ItemType,
    parts: {
      readonly options: readonly OptionRow[];
      readonly members: readonly MemberRow[];
      readonly pairs: readonly PairRow[];
      readonly numeric: NumericRow | undefined;
    },
  ): ResponseSpecification {
    const options: readonly ItemOption[] = Object.freeze(
      parts.options.map((option) =>
        Object.freeze({ optionId: option.option_id, ordinal: option.ordinal, body: option.body }),
      ),
    );

    switch (itemType) {
      case 'SINGLE_CORRECT_MCQ':
        return Object.freeze({
          itemType,
          options,
          correctOptionId: parts.options.find((option) => option.is_correct)?.option_id ?? '',
        });

      case 'MULTIPLE_CORRECT_MCQ':
        return Object.freeze({
          itemType,
          options,
          correctOptionIds: Object.freeze(
            parts.options.filter((option) => option.is_correct).map((option) => option.option_id),
          ),
        });

      case 'MATCHING': {
        const side = (which: 'left' | 'right'): readonly MatchingMember[] =>
          Object.freeze(
            parts.members
              .filter((member) => member.side === which)
              .map((member) =>
                Object.freeze({ memberId: member.member_id, ordinal: member.ordinal, body: member.body }),
              ),
          );
        return Object.freeze({
          itemType,
          left: side('left'),
          right: side('right'),
          pairs: Object.freeze(
            parts.pairs.map((pair) =>
              Object.freeze({ left: pair.left_member_id, right: pair.right_member_id }),
            ),
          ),
        });
      }

      case 'NUMERIC': {
        const numeric = parts.numeric;
        if (numeric === undefined) {
          // A NUMERIC item with no specification row cannot be reconstituted,
          // and guessing one would produce an item that scores against a value
          // nobody authored. Infrastructure faults throw (§8).
          throw new Error('content: a NUMERIC item version has no numeric specification row');
        }
        return Object.freeze({
          itemType,
          spec: Object.freeze({
            // Text in, text out — the authored literal, unparsed (ADR-0007).
            expectedValue: numeric.expected_value,
            comparisonMode: numeric.comparison_mode,
            ...omitNulls({
              toleranceValue: numeric.tolerance_value,
              significantFigures: numeric.significant_figures,
              rangeMin: numeric.range_min,
              rangeMax: numeric.range_max,
            }),
            ...(numeric.unit_canonical === null
              ? {}
              : {
                  unit: Object.freeze({
                    canonical: numeric.unit_canonical,
                    acceptedEquivalents: Object.freeze([...numeric.unit_accepted_equivalents]),
                    required: numeric.unit_required,
                  }),
                }),
            acceptedForms: Object.freeze([...numeric.accepted_forms]),
          }),
        });
      }
    }
  }
}
