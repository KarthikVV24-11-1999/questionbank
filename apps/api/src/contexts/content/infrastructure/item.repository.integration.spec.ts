import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  AUTHOR,
  FOUR_OPTIONS,
  REVIEWER,
  aiProvenance,
  itemVersionProps,
  mathBody,
  numericSpec,
  PROVENANCE_CONTEXT,
  textBody,
} from '../../../testing/content-fixtures.js';
import { createItemVersion, deriveDraft, deriveReviewerEditedVersion, type ItemVersion } from '../domain/item-version.js';
import { addVersion, createItem, publishVersion, transitionItem, type Item } from '../domain/item.js';
import { createContentBody, type Block } from '../domain/content-body.js';
import { projectContentBody } from '../domain/content-body-projections.js';
import { PostgresItemRepository } from './item.repository.js';

let database: TestDatabase;
let repository: PostgresItemRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

/**
 * The shared fixtures use readable identifiers — `author-1`,
 * `concept-kinematics` — which is right for a unit spec and impossible at the
 * database, where these columns are `uuid` (P6). The domain treats an
 * identifier as an opaque string and should: knowing the format is
 * infrastructure's business. So the integration spec supplies real ones.
 */
let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-8000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();
const OTHER_AUTHOR_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();

const DB_AUTHOR = { ...AUTHOR, id: AUTHOR_ID };

function version(overrides: Parameters<typeof itemVersionProps>[0] = {}): ItemVersion {
  return expectValue(
    createItemVersion(
      itemVersionProps({
        versionId: freshUuid(),
        authoredBy: DB_AUTHOR,
        taxonomyTags: [
          {
            conceptIdentityId: CONCEPT_ID,
            taxonomyVersionId: TAXONOMY_ID,
            weight: 1,
            isPrimary: true,
          },
        ],
        ...overrides,
      }),
      PROVENANCE_CONTEXT,
    ),
  );
}

function draftItem(overrides: Parameters<typeof itemVersionProps>[0] = {}): Item {
  const initial = version(overrides);
  return expectValue(
    createItem({
      itemId: freshUuid(),
      itemType: initial.itemType,
      initialVersion: initial,
    }),
  );
}

describe('save and load round trip', () => {
  it('reconstitutes an identical aggregate', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.itemId).toBe(item.itemId);
    expect(loaded.itemType).toBe(item.itemType);
    expect(loaded.lifecycleState).toBe('draft');
    expect(loaded.versions).toHaveLength(1);
    expect(loaded.aggregateVersion).toBe(item.aggregateVersion);
  });

  it('round trips the ContentBody document', async () => {
    const stem = mathBody('\\frac{1}{2}mv^2', 'one half m v squared');
    const item = draftItem({ stem });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.versions[0]!.stem).toEqual(stem);
  });

  // `jsonb` normalises: it sorts object keys and drops insignificant
  // whitespace, so the *document* survives but its serialization does not.
  // Worth pinning, because a later reader could reasonably assume byte
  // identity — as I did on the first run of this spec. Anything that needs a
  // stable serialization (a hash, a determinism check) must not read it from
  // a jsonb column.
  it('does not preserve the serialization, only the document', async () => {
    const stem = mathBody('x^2', 'x squared');
    const item = draftItem({ stem });
    expectValue(await repository.save(item));

    const stored = await database.pool.query<{ stem_body: unknown }>(
      `SELECT stem_body FROM content.item_version WHERE item_id = $1`,
      [item.itemId],
    );
    expect(stored.rows[0]!.stem_body).toEqual(stem);
    expect(Object.keys(stored.rows[0]!.stem_body as object)).toEqual(['blocks', 'schemaVersion']);
    expect(Object.keys(stem)).toEqual(['schemaVersion', 'blocks']);
  });

  it('round trips a stem containing every node kind', async () => {
    const blocks: Block[] = [
      { kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'A ramp', marks: ['BOLD'] }] },
      { kind: 'MATH_BLOCK', latex: 'a=F/m', textAlternative: 'a equals F over m' },
      { kind: 'CHEM_BLOCK', notation: 'H2O', textAlternative: 'water' },
      { kind: 'LIST', ordered: true, items: [[{ kind: 'PARAGRAPH', inlines: [{ kind: 'TEXT', value: 'one', marks: [] }] }]] },
      {
        kind: 'TABLE',
        header: [[{ kind: 'TEXT', value: 'h', marks: [] }]],
        rows: [[[{ kind: 'TEXT', value: 'c', marks: [] }]]],
      },
    ];
    const stem = expectValue(createContentBody(blocks));
    const item = draftItem({ stem });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.versions[0]!.stem).toEqual(stem);
  });

  it('round trips options, their bodies and the key', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const spec = loaded.versions[0]!.responseSpec;
    expect(spec.itemType).toBe('SINGLE_CORRECT_MCQ');
    if (spec.itemType !== 'SINGLE_CORRECT_MCQ') throw new Error('unreachable');
    expect(spec.options.map((option) => option.optionId)).toEqual(['a', 'b', 'c', 'd']);
    expect(spec.correctOptionId).toBe('b');
    expect(spec.options[0]!.body.blocks).toHaveLength(1);
  });

  it('round trips tags, provenance and licensing', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const version = loaded.versions[0]!;
    expect(version.taxonomyTags).toHaveLength(1);
    expect(version.taxonomyTags[0]).toMatchObject({ isPrimary: true, weight: 1 });
    expect(version.provenance.sourceType).toBe('original');
    expect(version.licensing).toEqual({ status: 'owned' });
  });

  it('round trips AI provenance with all four generation fields', async () => {
    const item = draftItem({
      provenance: aiProvenance({
        modelVersionId: freshUuid(),
        promptVersionId: freshUuid(),
        generationRunId: freshUuid(),
      }),
    });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.versions[0]!.provenance).toMatchObject({
      sourceType: 'ai_generated',
      confidence: 0.82,
    });
  });

  it('omits absent optional fields rather than reading them back as null', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const version = loaded.versions[0]!;
    expect(Object.hasOwn(version, 'stimulusVersionRef')).toBe(false);
    expect(Object.hasOwn(version.licensing, 'licenseRef')).toBe(false);
    expect(Object.hasOwn(version.provenance, 'sourceExam')).toBe(false);
  });

  it('reports NotFound for an item that does not exist', async () => {
    const failure = expectError(await repository.findById(freshUuid()));
    expect(failure.code).toBe('NOT_FOUND');
  });
});

describe('the numeric key crosses as text (ADR-0007)', () => {
  it.each([['0.1'], ['0.1000'], ['9.81'], ['-0.0000001']])(
    'preserves the authored literal %s exactly',
    async (expectedValue) => {
      const item = draftItem({
        itemType: 'NUMERIC',
        responseSpec: numericSpec({ expectedValue }),
      });
      expectValue(await repository.save(item));

      const loaded = expectValue(await repository.findById(item.itemId));
      const spec = loaded.versions[0]!.responseSpec;
      expect(spec.itemType === 'NUMERIC' ? spec.spec.expectedValue : null).toBe(expectedValue);
    },
  );

  // A double would collapse these two into the same value, and
  // SIGNIFICANT_FIGURES counts figures in the literal.
  it('keeps 0.1 and 0.1000 distinguishable through storage', async () => {
    const first = draftItem({ itemType: 'NUMERIC', responseSpec: numericSpec({ expectedValue: '0.1' }) });
    const second = draftItem({ itemType: 'NUMERIC', responseSpec: numericSpec({ expectedValue: '0.1000' }) });
    expectValue(await repository.save(first));
    expectValue(await repository.save(second));

    const loadedFirst = expectValue(await repository.findById(first.itemId));
    const loadedSecond = expectValue(await repository.findById(second.itemId));
    const valueOf = (item: Item): string | null => {
      const spec = item.versions[0]!.responseSpec;
      return spec.itemType === 'NUMERIC' ? spec.spec.expectedValue : null;
    };
    expect(valueOf(loadedFirst)).toBe('0.1');
    expect(valueOf(loadedSecond)).toBe('0.1000');
  });

  it('round trips the unit, its equivalents and the accepted forms', async () => {
    const item = draftItem({ itemType: 'NUMERIC', responseSpec: numericSpec() });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const spec = loaded.versions[0]!.responseSpec;
    if (spec.itemType !== 'NUMERIC') throw new Error('unreachable');
    expect(spec.spec.unit).toEqual({
      canonical: 'm/s^2',
      acceptedEquivalents: ['m s^-2'],
      required: true,
    });
    expect(spec.spec.acceptedForms).toEqual(['DECIMAL', 'SCIENTIFIC']);
  });
});

describe('the derived projections are recomputed, never accepted', () => {
  // A projection that can be supplied is one that can disagree with what it
  // summarizes, and the disagreement is invisible until search contradicts an
  // author.
  it('stores plain text matching a fresh recomputation', async () => {
    const stem = mathBody('E=mc^2', 'E equals m c squared');
    const item = draftItem({ stem });
    expectValue(await repository.save(item));

    const stored = await database.pool.query<{ stem_plain_text: string; notation_terms: string[] }>(
      `SELECT stem_plain_text, notation_terms FROM content.item_version WHERE item_id = $1`,
      [item.itemId],
    );
    const recomputed = projectContentBody(stem);
    expect(stored.rows[0]!.stem_plain_text).toBe(recomputed.plainText);
    expect(stored.rows[0]!.notation_terms).toEqual([...recomputed.notationTerms]);
  });

  it('stores the notation alternative rather than the LaTeX', async () => {
    const item = draftItem({ stem: mathBody('\\frac{a}{b}', 'a over b') });
    expectValue(await repository.save(item));

    const stored = await database.pool.query<{ stem_plain_text: string }>(
      `SELECT stem_plain_text FROM content.item_version WHERE item_id = $1`,
      [item.itemId],
    );
    expect(stored.rows[0]!.stem_plain_text).toBe('a over b');
    expect(stored.rows[0]!.stem_plain_text).not.toContain('frac');
  });
});

describe('one aggregate, one transaction (§10)', () => {
  // A rejected part must leave nothing behind, or a half-written item becomes
  // an item whose key is missing.
  it('leaves nothing behind when a part is rejected', async () => {
    const item = draftItem();
    // Force the failure at the tag insert by planting a conflicting row first.
    const version = item.versions[0]!;
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type) VALUES ($1, $2)`,
      [item.itemId, item.itemType],
    );
    await database.pool.query(
      `INSERT INTO content.item_version
         (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text,
          difficulty_estimate, authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, $3, '{}'::jsonb, 's', 'moderate', 'human', $4)`,
      [version.versionId, item.itemId, item.itemType, version.authoredBy.id],
    );
    await database.pool.query(
      `INSERT INTO content.item_taxonomy_tag
         (item_version_id, concept_identity_id, taxonomy_version_id, weight, is_primary)
       VALUES ($1, $2, $3, 1, true)`,
      [version.versionId, version.taxonomyTags[0]!.conceptIdentityId, version.taxonomyTags[0]!.taxonomyVersionId],
    );

    // The repository sees an existing item with a stale aggregate version.
    const failure = expectError(await repository.save(item));
    expect(failure.code).toBe('CONFLICT');
  });

  it('rolls back the whole save when the database refuses a part', async () => {
    const item = draftItem();
    const broken = {
      ...item,
      versions: [{ ...item.versions[0]!, difficultyEstimate: 'impossible' as never }],
    } as Item;

    const failure = expectError(await repository.save(broken));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');

    const rows = await database.pool.query(`SELECT 1 FROM content.item WHERE item_id = $1`, [item.itemId]);
    expect(rows.rowCount).toBe(0);
  });
});

describe('optimistic concurrency (P8)', () => {
  it('rejects a stale write as a Conflict rather than overwriting', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const submitted = expectValue(transitionItem(item, { transition: 'submit_for_review' }));
    expectValue(await repository.save(submitted));

    // A second writer still holding the original aggregate version.
    const stale = expectValue(transitionItem(item, { transition: 'submit_for_review' }));
    const failure = expectError(await repository.save(stale));
    expect(failure.code).toBe('CONFLICT');
    expect(failure.kind).toBe('Conflict');
  });

  it('leaves the winner’s state intact after a rejected stale write', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const submitted = expectValue(transitionItem(item, { transition: 'submit_for_review' }));
    expectValue(await repository.save(submitted));
    expectError(await repository.save(expectValue(transitionItem(item, { transition: 'submit_for_review' }))));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.lifecycleState).toBe('in_review');
    expect(loaded.aggregateVersion).toBe(2);
  });
});

describe('versions accumulate and publication pins one', () => {
  it('saves a second version alongside the first', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const second = expectValue(
      deriveDraft(item.versions[0]!, {
        versionId: freshUuid(),
        authoredBy: DB_AUTHOR,
        createdAt: '2026-08-11T09:00:00Z',
      }),
    );
    const withSecond = expectValue(addVersion(item, second));
    expectValue(await repository.save(withSecond));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.versions.map((version) => version.versionNo)).toEqual([1, 2]);
  });

  it('records the published version and returns it', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const approved = expectValue(
      transitionItem(
        expectValue(transitionItem(item, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    const published = expectValue(
      publishVersion(approved, { versionId: item.versions[0]!.versionId, preconditionsSatisfied: true }),
    );
    expectValue(await repository.save(published));

    const found = expectValue(await repository.findPublishedVersion(item.itemId));
    expect(found.versionId).toBe(item.versions[0]!.versionId);
  });

  it('reports NotFound when nothing is published', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const failure = expectError(await repository.findPublishedVersion(item.itemId));
    expect(failure.code).toBe('NOT_FOUND');
  });
});

describe('publishing through the repository arms the immutability trigger', () => {
  async function publishThroughRepository(item: Item): Promise<Item> {
    const approved = expectValue(
      transitionItem(
        expectValue(transitionItem(item, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    const published = expectValue(
      publishVersion(approved, { versionId: item.versions[0]!.versionId, preconditionsSatisfied: true }),
    );
    expectValue(await repository.save(published));
    return published;
  }

  // Without this the trigger only ever fired against direct SQL — INV-03 would
  // have held against psql and not against the application, which is exactly
  // backwards.
  it('stamps published_at on the version it publishes', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    await publishThroughRepository(item);

    const stored = await database.pool.query<{ published_at: Date | null }>(
      `SELECT published_at FROM content.item_version WHERE item_version_id = $1`,
      [item.versions[0]!.versionId],
    );
    expect(stored.rows[0]!.published_at).not.toBeNull();
  });

  it('makes the version immutable from then on', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    await publishThroughRepository(item);

    await expect(
      database.pool.query(
        `UPDATE content.item_version SET stem_plain_text = 'tampered' WHERE item_version_id = $1`,
        [item.versions[0]!.versionId],
      ),
    ).rejects.toThrow(/content_published_version_is_immutable/u);
  });

  it('makes the answer key immutable from then on', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    await publishThroughRepository(item);

    await expect(
      database.pool.query(
        `UPDATE content.item_option SET is_correct = true WHERE item_version_id = $1 AND option_id = 'a'`,
        [item.versions[0]!.versionId],
      ),
    ).rejects.toThrow(/content_published_version_is_immutable/u);
  });

  it('leaves an unpublished draft editable', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    await database.pool.query(
      `UPDATE content.item_version SET stem_plain_text = 'still a draft' WHERE item_version_id = $1`,
      [item.versions[0]!.versionId],
    );
    const stored = await database.pool.query<{ stem_plain_text: string }>(
      `SELECT stem_plain_text FROM content.item_version WHERE item_version_id = $1`,
      [item.versions[0]!.versionId],
    );
    expect(stored.rows[0]!.stem_plain_text).toBe('still a draft');
  });

  // Republishing must not move the instant a version was first published — an
  // attempt pinned to it is pinned to what it was then.
  it('does not restamp a version that was already published', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const published = await publishThroughRepository(item);

    const first = await database.pool.query<{ published_at: Date }>(
      `SELECT published_at FROM content.item_version WHERE item_version_id = $1`,
      [item.versions[0]!.versionId],
    );

    const suspended = expectValue(transitionItem(published, { transition: 'suspend' }));
    expectValue(await repository.save(suspended));
    expectValue(await repository.save(expectValue(transitionItem(suspended, { transition: 'reinstate' }))));

    const second = await database.pool.query<{ published_at: Date }>(
      `SELECT published_at FROM content.item_version WHERE item_version_id = $1`,
      [item.versions[0]!.versionId],
    );
    expect(second.rows[0]!.published_at.toISOString()).toBe(first.rows[0]!.published_at.toISOString());
  });
});

describe('drafts are scoped to their author (FR-TCH-06 rule 1)', () => {
  it('returns the author’s own drafts', async () => {
    const mine = draftItem();
    expectValue(await repository.save(mine));

    const found = expectValue(await repository.findDraftsByAuthor(AUTHOR_ID));
    expect(found.map((item) => item.itemId)).toContain(mine.itemId);
  });

  it('does not return another author’s drafts', async () => {
    const theirs = draftItem({ authoredBy: { ...AUTHOR, id: OTHER_AUTHOR_ID } });
    expectValue(await repository.save(theirs));

    const found = expectValue(await repository.findDraftsByAuthor(AUTHOR_ID));
    expect(found.map((item) => item.itemId)).not.toContain(theirs.itemId);
  });

  it('does not return items that have left draft', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    expectValue(await repository.save(expectValue(transitionItem(item, { transition: 'submit_for_review' }))));

    const found = expectValue(await repository.findDraftsByAuthor(AUTHOR_ID));
    expect(found.map((entry) => entry.itemId)).not.toContain(item.itemId);
  });
});

describe('discarding a draft (FR-TCH-06 rule 3)', () => {
  it('removes it from every read path', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    expectValue(await repository.deleteDraft(item.itemId));

    expect(expectError(await repository.findById(item.itemId)).kind).toBe('NotFound');
    const drafts = expectValue(await repository.findDraftsByAuthor(AUTHOR_ID));
    expect(drafts.map((entry) => entry.itemId)).not.toContain(item.itemId);
  });

  it('reports an item that is not there rather than claiming a deletion', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    expectValue(await repository.deleteDraft(item.itemId));

    // Deleting twice is not a silent success: the second call had nothing to
    // delete, and a caller told otherwise would audit a deletion that never
    // happened.
    expect(expectError(await repository.deleteDraft(item.itemId)).kind).toBe('NotFound');
  });

  // The handler asks the domain first, so this path is the database refusing
  // an application that got it wrong — the backstop, not the control.
  it('is refused by the database for anything past draft', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    expectValue(await repository.save(expectValue(transitionItem(item, { transition: 'submit_for_review' }))));

    const refused = expectError(await repository.deleteDraft(item.itemId));
    expect(refused.code).toBe('PERSISTENCE_REJECTED');
    expect(refused.message).toContain('item_only_drafts_are_deleted');
    expectValue(await repository.findById(item.itemId));
  });
});

describe('the stimulus reference count FR-TCH-03 rule 3 depends on', () => {
  async function seedStimulusVersion(): Promise<string> {
    const stimulusId = freshUuid();
    const stimulusVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.stimulus (stimulus_id, stimulus_type) VALUES ($1, 'passage')`,
      [stimulusId],
    );
    await database.pool.query(
      `INSERT INTO content.stimulus_version
         (stimulus_version_id, stimulus_id, version_no, body, body_plain_text, authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, '{}'::jsonb, 'p', 'human', $3)`,
      [stimulusVersionId, stimulusId, AUTHOR_ID],
    );
    return stimulusVersionId;
  }

  it('counts zero when nothing published references it', async () => {
    const stimulusVersionId = await seedStimulusVersion();
    expect(expectValue(await repository.countPublishedItemsUsingStimulusVersion(stimulusVersionId))).toBe(0);
  });

  it('counts a published item that pins it', async () => {
    const stimulusVersionId = await seedStimulusVersion();
    const item = draftItem({ stimulusVersionRef: stimulusVersionId });
    expectValue(await repository.save(item));

    const approved = expectValue(
      transitionItem(
        expectValue(transitionItem(item, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    expectValue(
      await repository.save(
        expectValue(
          publishVersion(approved, { versionId: item.versions[0]!.versionId, preconditionsSatisfied: true }),
        ),
      ),
    );

    expect(expectValue(await repository.countPublishedItemsUsingStimulusVersion(stimulusVersionId))).toBe(1);
  });

  it('does not count a draft that pins it', async () => {
    const stimulusVersionId = await seedStimulusVersion();
    const item = draftItem({ stimulusVersionRef: stimulusVersionId });
    expectValue(await repository.save(item));

    expect(expectValue(await repository.countPublishedItemsUsingStimulusVersion(stimulusVersionId))).toBe(0);
  });
});

describe('every item type round trips', () => {
  it('round trips a multi-correct item and its correct set', async () => {
    const item = draftItem({
      itemType: 'MULTIPLE_CORRECT_MCQ',
      responseSpec: {
        itemType: 'MULTIPLE_CORRECT_MCQ',
        options: FOUR_OPTIONS,
        correctOptionIds: ['a', 'c'],
      },
    });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const spec = loaded.versions[0]!.responseSpec;
    if (spec.itemType !== 'MULTIPLE_CORRECT_MCQ') throw new Error('unreachable');
    expect([...spec.correctOptionIds].sort()).toEqual(['a', 'c']);
    expect(spec.options).toHaveLength(4);
  });

  it('round trips a matching item, both sides and the pairing', async () => {
    const item = draftItem({
      itemType: 'MATCHING',
      responseSpec: {
        itemType: 'MATCHING',
        left: [
          { memberId: 'l1', ordinal: 1, body: textBody('left one') },
          { memberId: 'l2', ordinal: 2, body: textBody('left two') },
        ],
        right: [
          { memberId: 'r1', ordinal: 1, body: textBody('right one') },
          { memberId: 'r2', ordinal: 2, body: textBody('right two') },
        ],
        pairs: [
          { left: 'l1', right: 'r2' },
          { left: 'l2', right: 'r1' },
        ],
      },
    });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const spec = loaded.versions[0]!.responseSpec;
    if (spec.itemType !== 'MATCHING') throw new Error('unreachable');
    expect(spec.left.map((member) => member.memberId)).toEqual(['l1', 'l2']);
    expect(spec.right.map((member) => member.memberId)).toEqual(['r1', 'r2']);
    expect(spec.pairs).toEqual([
      { left: 'l1', right: 'r2' },
      { left: 'l2', right: 'r1' },
    ]);
    expect(spec.left[0]!.body.blocks).toHaveLength(1);
  });
});

describe('the media usage graph is written from the document', () => {
  async function seedAssetVersion(): Promise<string> {
    const assetId = freshUuid();
    const assetVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.media_asset (asset_id, asset_type) VALUES ($1, 'diagram')`,
      [assetId],
    );
    await database.pool.query(
      `INSERT INTO content.media_asset_version
         (asset_version_id, asset_id, version_no, storage_key, checksum, mime_type, width, height,
          alt_text, long_description, authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'k', 'c', 'image/png', 10, 10, 'a ramp', 'the ramp rises left to right',
               'human', $3)`,
      [assetVersionId, assetId, AUTHOR_ID],
    );
    return assetVersionId;
  }

  // Derived and written with the version. Deriving it later would leave a
  // window in which an in-use asset reads as unused and can be retired.
  it('writes an edge for every asset the stem references', async () => {
    const assetVersionId = await seedAssetVersion();
    const stem = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'FULL_WIDTH' }]),
    );
    const item = draftItem({ stem });
    expectValue(await repository.save(item));

    const edges = await database.pool.query<{ media_asset_version_id: string }>(
      `SELECT media_asset_version_id FROM content.content_media_ref
        WHERE owner_type = 'item_version' AND owner_version_id = $1`,
      [item.versions[0]!.versionId],
    );
    expect(edges.rows.map((row) => row.media_asset_version_id)).toEqual([assetVersionId]);
  });

  it('writes one edge for an asset referenced twice', async () => {
    const assetVersionId = await seedAssetVersion();
    const stem = expectValue(
      createContentBody([
        { kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'FULL_WIDTH' },
        { kind: 'PARAGRAPH', inlines: [{ kind: 'MEDIA_REF', assetVersionId }] },
      ]),
    );
    const item = draftItem({ stem });
    expectValue(await repository.save(item));

    const edges = await database.pool.query(
      `SELECT 1 FROM content.content_media_ref WHERE owner_version_id = $1`,
      [item.versions[0]!.versionId],
    );
    expect(edges.rowCount).toBe(1);
  });

  it('writes no edge for a stem that references nothing', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const edges = await database.pool.query(
      `SELECT 1 FROM content.content_media_ref WHERE owner_version_id = $1`,
      [item.versions[0]!.versionId],
    );
    expect(edges.rowCount).toBe(0);
  });
});

describe('a corrupt row is a fault, not a defensible-looking item', () => {
  // Guessing a specification would produce an item that scores against a value
  // nobody authored — a wrong mark that looks entirely reasonable.
  it('throws when a NUMERIC version has no specification row', async () => {
    const itemId = freshUuid();
    const versionId = freshUuid();
    await database.pool.query(`INSERT INTO content.item (item_id, item_type) VALUES ($1, 'NUMERIC')`, [
      itemId,
    ]);
    await database.pool.query(
      `INSERT INTO content.item_version
         (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text,
          difficulty_estimate, authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, 'NUMERIC', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
      [versionId, itemId, AUTHOR_ID],
    );

    await expect(repository.findById(itemId)).rejects.toThrow(/no numeric specification/u);
  });
});

describe('every numeric comparison mode survives storage', () => {
  it('round trips a RANGE specification with both bounds', async () => {
    const item = draftItem({
      itemType: 'NUMERIC',
      responseSpec: {
        itemType: 'NUMERIC',
        spec: {
          expectedValue: '5',
          comparisonMode: 'RANGE',
          rangeMin: '4.5',
          rangeMax: '5.5',
          acceptedForms: ['DECIMAL'],
        },
      },
    });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const spec = loaded.versions[0]!.responseSpec;
    if (spec.itemType !== 'NUMERIC') throw new Error('unreachable');
    expect(spec.spec).toMatchObject({ rangeMin: '4.5', rangeMax: '5.5', comparisonMode: 'RANGE' });
  });

  it('round trips a SIGNIFICANT_FIGURES specification', async () => {
    const item = draftItem({
      itemType: 'NUMERIC',
      responseSpec: {
        itemType: 'NUMERIC',
        spec: {
          expectedValue: '0.1000',
          comparisonMode: 'SIGNIFICANT_FIGURES',
          significantFigures: 3,
          acceptedForms: ['DECIMAL'],
        },
      },
    });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const spec = loaded.versions[0]!.responseSpec;
    if (spec.itemType !== 'NUMERIC') throw new Error('unreachable');
    expect(spec.spec.significantFigures).toBe(3);
    expect(spec.spec.expectedValue).toBe('0.1000');
  });

  it('round trips a specification with no unit, leaving the key absent', async () => {
    const item = draftItem({
      itemType: 'NUMERIC',
      responseSpec: {
        itemType: 'NUMERIC',
        spec: { expectedValue: '7', comparisonMode: 'EXACT', acceptedForms: ['DECIMAL', 'FRACTION'] },
      },
    });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    const spec = loaded.versions[0]!.responseSpec;
    if (spec.itemType !== 'NUMERIC') throw new Error('unreachable');
    expect(Object.hasOwn(spec.spec, 'unit')).toBe(false);
    expect(Object.hasOwn(spec.spec, 'toleranceValue')).toBe(false);
    expect(spec.spec.acceptedForms).toEqual(['DECIMAL', 'FRACTION']);
  });
});

describe('optional aggregate state round trips', () => {
  it('round trips a licence with an expiry', async () => {
    const item = draftItem({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme Publishing',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.versions[0]!.licensing).toEqual({
      status: 'licensed',
      licenseRef: 'CC-BY-4.0',
      attribution: 'Acme Publishing',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('round trips a retirement reason and a replacement', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const approved = expectValue(
      transitionItem(
        expectValue(transitionItem(item, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    const published = expectValue(
      publishVersion(approved, { versionId: item.versions[0]!.versionId, preconditionsSatisfied: true }),
    );
    expectValue(await repository.save(published));

    const replacement = draftItem();
    expectValue(await repository.save(replacement));

    const retired = expectValue(
      transitionItem(published, {
        transition: 'retire',
        retirementReason: 'superseded by a clearer phrasing',
        replacedByItemId: replacement.itemId,
      }),
    );
    expectValue(await repository.save(retired));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded).toMatchObject({
      lifecycleState: 'retired',
      retirementReason: 'superseded by a clearer phrasing',
      replacedByItemId: replacement.itemId,
    });
  });

  it('round trips a pinned stimulus version', async () => {
    const stimulusId = freshUuid();
    const stimulusVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.stimulus (stimulus_id, stimulus_type) VALUES ($1, 'passage')`,
      [stimulusId],
    );
    await database.pool.query(
      `INSERT INTO content.stimulus_version
         (stimulus_version_id, stimulus_id, version_no, body, body_plain_text, authored_by_kind, authored_by_id)
       VALUES ($1, $2, 1, '{}'::jsonb, 'p', 'human', $3)`,
      [stimulusVersionId, stimulusId, AUTHOR_ID],
    );

    const item = draftItem({ stimulusVersionRef: stimulusVersionId });
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.versions[0]!.stimulusVersionRef).toBe(stimulusVersionId);
  });

  it('reports NotFound from findPublishedVersion when the item does not exist', async () => {
    const failure = expectError(await repository.findPublishedVersion(freshUuid()));
    expect(failure.code).toBe('NOT_FOUND');
  });
});

describe('a stored row that cannot reconstitute is reported, not returned', () => {
  // Returning a half-valid aggregate would push the corruption downstream,
  // where it looks like an authoring bug rather than a storage one.
  it('reports the reconstitution failure by item id', async () => {
    const itemId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type) VALUES ($1, 'SINGLE_CORRECT_MCQ')`,
      [itemId],
    );
    // Version numbers 1 and 3 — a gap the aggregate refuses.
    for (const versionNo of [1, 3]) {
      await database.pool.query(
        `INSERT INTO content.item_version
           (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text,
            difficulty_estimate, authored_by_kind, authored_by_id)
         VALUES ($1, $2, $3, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $4)`,
        [freshUuid(), itemId, versionNo, AUTHOR_ID],
      );
    }

    const failure = expectError(await repository.findById(itemId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain(itemId);
    expect(failure.message).toContain('contiguously');
  });

  it('propagates the failure out of a draft listing rather than dropping the row', async () => {
    const itemId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type) VALUES ($1, 'SINGLE_CORRECT_MCQ')`,
      [itemId],
    );
    for (const versionNo of [1, 3]) {
      await database.pool.query(
        `INSERT INTO content.item_version
           (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text,
            difficulty_estimate, authored_by_kind, authored_by_id)
         VALUES ($1, $2, $3, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $4)`,
        [freshUuid(), itemId, versionNo, OTHER_AUTHOR_ID],
      );
    }

    const failure = expectError(await repository.findDraftsByAuthor(OTHER_AUTHOR_ID));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
  });

  it('propagates the failure out of the review queue rather than dropping the row', async () => {
    const itemId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.item (item_id, item_type, lifecycle_state) VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review')`,
      [itemId],
    );
    for (const versionNo of [1, 3]) {
      await database.pool.query(
        `INSERT INTO content.item_version
           (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text,
            difficulty_estimate, authored_by_kind, authored_by_id)
         VALUES ($1, $2, $3, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $4)`,
        [freshUuid(), itemId, versionNo, OTHER_AUTHOR_ID],
      );
    }

    const failure = expectError(await repository.findSubmittedForReview({ limit: 10 }));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
  });
});

describe('the casing boundary lives here and nowhere else (§2)', () => {
  it('returns camelCase to the domain from snake_case columns', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const loaded = expectValue(await repository.findById(item.itemId));

    const serialized = JSON.stringify(loaded);
    expect(serialized).toMatch(/"itemId"/u);
    expect(serialized).toMatch(/"lifecycleState"/u);
    expect(serialized).not.toMatch(/"item_id"/u);
    expect(serialized).not.toMatch(/"lifecycle_state"/u);
  });
});

// The review queue's ageing clock (M4-13, DEC-M4-1).
describe('state_entered_at', () => {
  it('is stamped on a freshly inserted draft, even though the domain object never carried one', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.stateEnteredAt).toBeDefined();
    expect(() => new Date(loaded.stateEnteredAt as string)).not.toThrow();
  });

  it('carries the domain-supplied instant through on insert, rather than the database’s own now()', async () => {
    const item = expectValue(
      createItem({
        itemId: freshUuid(),
        itemType: version().itemType,
        initialVersion: version(),
        stateEnteredAt: '2026-08-01T00:00:00.000Z',
      }),
    );
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.stateEnteredAt).toBe('2026-08-01T00:00:00.000Z');
  });

  it('moves forward on a real transition, per transition', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const afterInsert = expectValue(await repository.findById(item.itemId));

    const submitted = expectValue(
      transitionItem(afterInsert, { transition: 'submit_for_review', stateEnteredAt: '2026-08-15T12:00:00.000Z' }),
    );
    expectValue(await repository.save(submitted));
    const afterSubmit = expectValue(await repository.findById(item.itemId));
    expect(afterSubmit.stateEnteredAt).toBe('2026-08-15T12:00:00.000Z');
    expect(afterSubmit.stateEnteredAt).not.toBe(afterInsert.stateEnteredAt);

    const changesRequested = expectValue(
      transitionItem(afterSubmit, {
        transition: 'request_changes',
        stateEnteredAt: '2026-08-16T09:00:00.000Z',
      }),
    );
    expectValue(await repository.save(changesRequested));
    const afterRequestChanges = expectValue(await repository.findById(item.itemId));
    expect(afterRequestChanges.stateEnteredAt).toBe('2026-08-16T09:00:00.000Z');
  });

  it('does not move on a save that is not a transition — adding a version leaves it untouched', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const afterInsert = expectValue(await repository.findById(item.itemId));

    const v2 = expectValue(
      deriveDraft(item.versions[0]!, { versionId: freshUuid(), authoredBy: DB_AUTHOR, createdAt: '2026-08-10T09:00:00Z' }),
    );
    const withSecondVersion = expectValue(addVersion(afterInsert, v2));
    expectValue(await repository.save(withSecondVersion));

    const afterAddVersion = expectValue(await repository.findById(item.itemId));
    expect(afterAddVersion.stateEnteredAt).toBe(afterInsert.stateEnteredAt);
  });

  it('defaults to now() at the database when the domain does not supply one on a real transition', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const afterInsert = expectValue(await repository.findById(item.itemId));

    const submitted = expectValue(transitionItem(afterInsert, { transition: 'submit_for_review' }));
    expectValue(await repository.save(submitted));

    // Not asserted as strictly later than the insert's own now() — a fast
    // test can land both within the same clock second. What matters is that
    // it came from the database's own now(), not a value this test invented.
    const afterSubmit = expectValue(await repository.findById(item.itemId));
    expect(afterSubmit.stateEnteredAt).toBeDefined();
    expect(() => new Date(afterSubmit.stateEnteredAt as string)).not.toThrow();
  });
});

// M4-15, ADR-0018.
describe('editedBy', () => {
  const DB_REVIEWER = { ...REVIEWER, id: freshUuid() };

  it('round trips absent when a version was never reviewer-edited', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));

    const loaded = expectValue(await repository.findById(item.itemId));
    expect(loaded.versions[0]!.editedBy).toBeUndefined();
  });

  it('round trips editedBy on a reviewer-edited version, leaving authoredBy the original author', async () => {
    const item = draftItem();
    expectValue(await repository.save(item));
    const afterInsert = expectValue(await repository.findById(item.itemId));

    const edited = expectValue(
      deriveReviewerEditedVersion(afterInsert.versions[0]!, {
        versionId: freshUuid(),
        editedBy: DB_REVIEWER,
        createdAt: '2026-08-15T09:00:00Z',
        edits: { difficultyEstimate: 'advanced' },
      }),
    );
    expectValue(await repository.save(expectValue(addVersion(afterInsert, edited))));

    const loaded = expectValue(await repository.findById(item.itemId));
    const editedVersion = loaded.versions.find((version) => version.versionId === edited.versionId);
    expect(editedVersion?.editedBy?.id).toBe(DB_REVIEWER.id);
    expect(editedVersion?.authoredBy.id).toBe(AUTHOR_ID);
  });
});
