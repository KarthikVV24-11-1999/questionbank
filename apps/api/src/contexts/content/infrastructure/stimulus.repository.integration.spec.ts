import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, AUTHORED_AT, mathBody, textBody } from '../../../testing/content-fixtures.js';
import { createContentBody } from '../domain/content-body.js';
import {
  addStimulusVersion,
  createStimulus,
  createStimulusVersion,
  reconstituteStimulus,
  transitionStimulus,
  type CreateStimulusVersionProps,
  type Stimulus,
  type StimulusVersion,
} from '../domain/stimulus.js';
import { PostgresStimulusRepository } from './stimulus.repository.js';
import { PostgresItemRepository } from './item.repository.js';
import { createItemVersion } from '../domain/item-version.js';
import { createItem, publishVersion, transitionItem } from '../domain/item.js';
import { itemVersionProps, PROVENANCE_CONTEXT } from '../../../testing/content-fixtures.js';

let database: TestDatabase;
let repository: PostgresStimulusRepository;
let items: PostgresItemRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresStimulusRepository(database.pool);
  items = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-9000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();
const DB_AUTHOR = { ...AUTHOR, id: AUTHOR_ID };

function versionProps(overrides: Partial<CreateStimulusVersionProps> = {}): CreateStimulusVersionProps {
  return {
    versionId: freshUuid(),
    versionNo: 1,
    body: textBody('A 200 kg trolley rolls along a level track without friction.'),
    licensing: { status: 'owned' },
    authoredBy: DB_AUTHOR,
    createdAt: AUTHORED_AT,
    ...overrides,
  };
}

function version(overrides: Partial<CreateStimulusVersionProps> = {}): StimulusVersion {
  return expectValue(createStimulusVersion(versionProps(overrides)));
}

function draftStimulus(overrides: Partial<CreateStimulusVersionProps> = {}): Stimulus {
  return expectValue(
    createStimulus({
      stimulusId: freshUuid(),
      stimulusType: 'passage',
      initialVersion: version(overrides),
    }),
  );
}

async function publishStimulus(stimulus: Stimulus): Promise<Stimulus> {
  const approved = expectValue(
    transitionStimulus(
      expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' })),
      { transition: 'approve' },
    ),
  );
  const published = expectValue(
    transitionStimulus(approved, { transition: 'publish', versionId: stimulus.versions[0]!.versionId }),
  );
  expectValue(await repository.save(published));
  return published;
}

describe('save and load round trip', () => {
  it('reconstitutes an identical aggregate', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));

    const loaded = expectValue(await repository.findById(stimulus.stimulusId));
    expect(loaded).toMatchObject({
      stimulusId: stimulus.stimulusId,
      stimulusType: 'passage',
      lifecycleState: 'draft',
      aggregateVersion: 1,
    });
    expect(loaded.versions).toHaveLength(1);
  });

  it('round trips the ContentBody document', async () => {
    const body = mathBody('v = u + at', 'v equals u plus a t');
    const stimulus = draftStimulus({ body });
    expectValue(await repository.save(stimulus));

    const loaded = expectValue(await repository.findById(stimulus.stimulusId));
    expect(loaded.versions[0]!.body).toEqual(body);
  });

  it('round trips licensing', async () => {
    const stimulus = draftStimulus({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme Publishing',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
    expectValue(await repository.save(stimulus));

    const loaded = expectValue(await repository.findById(stimulus.stimulusId));
    expect(loaded.versions[0]!.licensing).toEqual({
      status: 'licensed',
      licenseRef: 'CC-BY-4.0',
      attribution: 'Acme Publishing',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('defaults to unresolved when no statement about rights was made', async () => {
    const props = versionProps();
    delete (props as { licensing?: unknown }).licensing;
    const stimulus = expectValue(
      createStimulus({
        stimulusId: freshUuid(),
        stimulusType: 'dataset',
        initialVersion: expectValue(createStimulusVersion(props)),
      }),
    );
    expectValue(await repository.save(stimulus));

    const loaded = expectValue(await repository.findById(stimulus.stimulusId));
    expect(loaded.versions[0]!.licensing).toEqual({ status: 'unresolved' });
  });

  it('stores the derived projections from the document', async () => {
    const stimulus = draftStimulus({ body: mathBody('E=mc^2', 'E equals m c squared') });
    expectValue(await repository.save(stimulus));

    const stored = await database.pool.query<{ body_plain_text: string; notation_terms: string[] }>(
      `SELECT body_plain_text, notation_terms FROM content.stimulus_version WHERE stimulus_id = $1`,
      [stimulus.stimulusId],
    );
    expect(stored.rows[0]!.body_plain_text).toBe('E equals m c squared');
    expect(stored.rows[0]!.notation_terms).toEqual(['e', '=', 'mc', '2']);
  });

  it('writes a media edge for each asset the body references', async () => {
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
       VALUES ($1, $2, 1, 'k', 'c', 'image/png', 10, 10, 'a trolley', 'the trolley rolls right',
               'human', $3)`,
      [assetVersionId, assetId, AUTHOR_ID],
    );

    const body = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'FULL_WIDTH' }]),
    );
    const stimulus = draftStimulus({ body });
    expectValue(await repository.save(stimulus));

    const edges = await database.pool.query<{ media_asset_version_id: string }>(
      `SELECT media_asset_version_id FROM content.content_media_ref
        WHERE owner_type = 'stimulus_version' AND owner_version_id = $1`,
      [stimulus.versions[0]!.versionId],
    );
    expect(edges.rows.map((row) => row.media_asset_version_id)).toEqual([assetVersionId]);
  });

  it('reports NotFound for a stimulus that does not exist', async () => {
    expect(expectError(await repository.findById(freshUuid())).code).toBe('NOT_FOUND');
  });
});

describe('publication', () => {
  it('records the published version and returns it', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    await publishStimulus(stimulus);

    const found = expectValue(await repository.findPublishedVersion(stimulus.stimulusId));
    expect(found.versionId).toBe(stimulus.versions[0]!.versionId);
  });

  it('reports NotFound when nothing is published', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    expect(expectError(await repository.findPublishedVersion(stimulus.stimulusId)).code).toBe('NOT_FOUND');
  });

  it('reports NotFound from findPublishedVersion when the stimulus does not exist', async () => {
    expect(expectError(await repository.findPublishedVersion(freshUuid())).code).toBe('NOT_FOUND');
  });

  it('arms the immutability trigger, so the published body cannot be edited', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    await publishStimulus(stimulus);

    await expect(
      database.pool.query(
        `UPDATE content.stimulus_version SET body_plain_text = 'tampered' WHERE stimulus_version_id = $1`,
        [stimulus.versions[0]!.versionId],
      ),
    ).rejects.toThrow(/content_published_version_is_immutable/u);
  });
});

describe('editing a published stimulus creates a version items do not follow (FR-TCH-03 rule 2)', () => {
  // The whole reason the aggregate exists: an item sat by a candidate must
  // still ask what it asked.
  it('leaves an item pinned to the version it was authored against', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    const published = await publishStimulus(stimulus);
    const firstVersionId = stimulus.versions[0]!.versionId;

    // An item authored against version 1.
    const itemVersion = expectValue(
      createItemVersion(
        itemVersionProps({
          versionId: freshUuid(),
          authoredBy: DB_AUTHOR,
          taxonomyTags: [
            { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
          ],
          stimulusVersionRef: firstVersionId,
        }),
        PROVENANCE_CONTEXT,
      ),
    );
    const item = expectValue(
      createItem({ itemId: freshUuid(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: itemVersion }),
    );
    expectValue(await items.save(item));

    // The stimulus is corrected: a second version, then published.
    const second = version({ versionId: freshUuid(), versionNo: 2, body: textBody('A corrected passage.') });
    const withSecond = expectValue(addStimulusVersion(published, second));
    expectValue(await repository.save(withSecond));

    const republished = expectValue(
      transitionStimulus(
        expectValue(
          reconstituteStimulus({
            stimulusId: withSecond.stimulusId,
            stimulusType: withSecond.stimulusType,
            lifecycleState: 'approved',
            versions: withSecond.versions,
            currentPublishedVersionId: firstVersionId,
            aggregateVersion: withSecond.aggregateVersion,
          }),
        ),
        { transition: 'publish', versionId: second.versionId },
      ),
    );
    expectValue(await repository.save(republished));

    // The stimulus now publishes version 2 …
    expect(expectValue(await repository.findPublishedVersion(stimulus.stimulusId)).versionNo).toBe(2);
    // … and the item still asks version 1.
    const loadedItem = expectValue(await items.findById(item.itemId));
    expect(loadedItem.versions[0]!.stimulusVersionRef).toBe(firstVersionId);
  });

  it('keeps both versions retrievable', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    const published = await publishStimulus(stimulus);

    const second = version({ versionId: freshUuid(), versionNo: 2, body: textBody('A correction.') });
    expectValue(await repository.save(expectValue(addStimulusVersion(published, second))));

    const loaded = expectValue(await repository.findById(stimulus.stimulusId));
    expect(loaded.versions.map((entry) => entry.versionNo)).toEqual([1, 2]);
  });
});

describe('the reference count FR-TCH-03 rule 3 consumes', () => {
  async function publishedItemPinning(stimulusVersionId: string): Promise<void> {
    const itemVersion = expectValue(
      createItemVersion(
        itemVersionProps({
          versionId: freshUuid(),
          authoredBy: DB_AUTHOR,
          taxonomyTags: [
            { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
          ],
          stimulusVersionRef: stimulusVersionId,
        }),
        PROVENANCE_CONTEXT,
      ),
    );
    const item = expectValue(
      createItem({ itemId: freshUuid(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: itemVersion }),
    );
    expectValue(await items.save(item));

    const approved = expectValue(
      transitionItem(
        expectValue(transitionItem(item, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    expectValue(
      await items.save(
        expectValue(publishVersion(approved, { versionId: itemVersion.versionId, preconditionsSatisfied: true })),
      ),
    );
  }

  it('counts zero, one and many', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    const versionId = stimulus.versions[0]!.versionId;

    expect(expectValue(await items.countPublishedItemsUsingStimulusVersion(versionId))).toBe(0);

    await publishedItemPinning(versionId);
    expect(expectValue(await items.countPublishedItemsUsingStimulusVersion(versionId))).toBe(1);

    await publishedItemPinning(versionId);
    await publishedItemPinning(versionId);
    expect(expectValue(await items.countPublishedItemsUsingStimulusVersion(versionId))).toBe(3);
  });

  // A draft referencing it is not circulating, so it does not block
  // retirement — the rule is about published content.
  it('excludes items that are not published', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    const versionId = stimulus.versions[0]!.versionId;

    const itemVersion = expectValue(
      createItemVersion(
        itemVersionProps({
          versionId: freshUuid(),
          authoredBy: DB_AUTHOR,
          taxonomyTags: [
            { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
          ],
          stimulusVersionRef: versionId,
        }),
        PROVENANCE_CONTEXT,
      ),
    );
    expectValue(
      await items.save(
        expectValue(
          createItem({ itemId: freshUuid(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: itemVersion }),
        ),
      ),
    );

    expect(expectValue(await items.countPublishedItemsUsingStimulusVersion(versionId))).toBe(0);
  });

  // A suspended item is still pinned to the stimulus and can be reinstated,
  // so retiring the stimulus underneath it would break it on reinstatement.
  it('counts a suspended item, which can still be reinstated', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    const versionId = stimulus.versions[0]!.versionId;
    await publishedItemPinning(versionId);

    const [row] = (
      await database.pool.query<{ item_id: string }>(
        `SELECT i.item_id FROM content.item i
           JOIN content.item_version v ON v.item_version_id = i.current_published_version_id
          WHERE v.stimulus_version_id = $1 LIMIT 1`,
        [versionId],
      )
    ).rows;
    await database.pool.query(
      `UPDATE content.item SET lifecycle_state = 'suspended' WHERE item_id = $1`,
      [row!.item_id],
    );

    expect(expectValue(await items.countPublishedItemsUsingStimulusVersion(versionId))).toBe(1);
  });
});

describe('optimistic concurrency (P8)', () => {
  it('rejects a stale write as a Conflict', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));

    const submitted = expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' }));
    expectValue(await repository.save(submitted));

    const stale = expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' }));
    const failure = expectError(await repository.save(stale));
    expect(failure.code).toBe('CONFLICT');
    expect(failure.kind).toBe('Conflict');
  });

  it('leaves the winner’s state intact', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    expectValue(
      await repository.save(expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' }))),
    );
    expectError(
      await repository.save(expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' }))),
    );

    const loaded = expectValue(await repository.findById(stimulus.stimulusId));
    expect(loaded.lifecycleState).toBe('in_review');
    expect(loaded.aggregateVersion).toBe(2);
  });
});

describe('failures are reported, not returned as half an aggregate', () => {
  it('rolls back the whole save when the database refuses a part', async () => {
    const stimulus = draftStimulus();
    const broken = {
      ...stimulus,
      stimulusType: 'video' as never,
    } as Stimulus;

    expect(expectError(await repository.save(broken)).code).toBe('PERSISTENCE_REJECTED');
    const rows = await database.pool.query(`SELECT 1 FROM content.stimulus WHERE stimulus_id = $1`, [
      stimulus.stimulusId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('reports a stored stimulus that cannot reconstitute', async () => {
    const stimulusId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.stimulus (stimulus_id, stimulus_type) VALUES ($1, 'passage')`,
      [stimulusId],
    );
    for (const versionNo of [1, 3]) {
      await database.pool.query(
        `INSERT INTO content.stimulus_version
           (stimulus_version_id, stimulus_id, version_no, body, body_plain_text, authored_by_kind, authored_by_id)
         VALUES ($1, $2, $3, '{}'::jsonb, 'p', 'human', $4)`,
        [freshUuid(), stimulusId, versionNo, AUTHOR_ID],
      );
    }

    const failure = expectError(await repository.findById(stimulusId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('contiguously');
  });

  it('retires with a reason once nothing references it', async () => {
    const stimulus = draftStimulus();
    expectValue(await repository.save(stimulus));
    const published = await publishStimulus(stimulus);

    const retired = expectValue(
      transitionStimulus(published, {
        transition: 'retire',
        retirementReason: 'source licence lapsed',
        referencingPublishedItemCount: 0,
      }),
    );
    expectValue(await repository.save(retired));

    const loaded = expectValue(await repository.findById(stimulus.stimulusId));
    expect(loaded).toMatchObject({ lifecycleState: 'retired', retirementReason: 'source licence lapsed' });
  });
});
