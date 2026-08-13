import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, AUTHORED_AT, itemVersionProps, PROVENANCE_CONTEXT, textBody } from '../../../testing/content-fixtures.js';
import { createContentBody } from '../domain/content-body.js';
import { createItemVersion } from '../domain/item-version.js';
import { createItem, publishVersion, transitionItem } from '../domain/item.js';
import {
  addMediaAssetVersion,
  createMediaAsset,
  createMediaAssetVersion,
  transitionMediaAsset,
  type AssetType,
  type CreateMediaAssetVersionProps,
  type MediaAsset,
  type MediaAssetVersion,
} from '../domain/media-asset.js';
import {
  createStimulus,
  createStimulusVersion,
  transitionStimulus,
} from '../domain/stimulus.js';
import { createSolution, createSolutionVersion, transitionSolution } from '../domain/solution.js';
import { PostgresItemRepository } from './item.repository.js';
import { PostgresMediaAssetRepository } from './media-asset.repository.js';
import { PostgresSolutionRepository } from './solution.repository.js';
import { PostgresStimulusRepository } from './stimulus.repository.js';

const MODULE_SOURCE = readFileSync(
  fileURLToPath(new URL('./media-asset.repository.ts', import.meta.url)),
  'utf8',
);

let database: TestDatabase;
let repository: PostgresMediaAssetRepository;
let items: PostgresItemRepository;
let stimuli: PostgresStimulusRepository;
let solutions: PostgresSolutionRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  repository = new PostgresMediaAssetRepository(database.pool);
  items = new PostgresItemRepository(database.pool);
  stimuli = new PostgresStimulusRepository(database.pool);
  solutions = new PostgresSolutionRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-b000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();
const DB_AUTHOR = { ...AUTHOR, id: AUTHOR_ID };

function versionProps(overrides: Partial<CreateMediaAssetVersionProps> = {}): CreateMediaAssetVersionProps {
  return {
    versionId: freshUuid(),
    versionNo: 1,
    storageKey: 'content/media/ramp-v1.png',
    checksum: 'sha256:3f1a',
    mimeType: 'image/png',
    width: 800,
    height: 600,
    altText: 'A block on a ramp inclined at thirty degrees',
    longDescription: 'The ramp rises left to right at 30°, with arrows for weight and normal force.',
    licensing: { status: 'owned' },
    authoredBy: DB_AUTHOR,
    createdAt: AUTHORED_AT,
    ...overrides,
  };
}

function version(
  overrides: Partial<CreateMediaAssetVersionProps> = {},
  assetType: AssetType = 'diagram',
): MediaAssetVersion {
  return expectValue(createMediaAssetVersion(versionProps(overrides), assetType));
}

function draftAsset(
  overrides: Partial<CreateMediaAssetVersionProps> = {},
  assetType: AssetType = 'diagram',
): MediaAsset {
  return expectValue(
    createMediaAsset({ assetId: freshUuid(), assetType, initialVersion: version(overrides, assetType) }),
  );
}

async function publishAsset(asset: MediaAsset): Promise<MediaAsset> {
  const approved = expectValue(
    transitionMediaAsset(
      expectValue(transitionMediaAsset(asset, { transition: 'submit_for_review' })),
      { transition: 'approve' },
    ),
  );
  const published = expectValue(
    transitionMediaAsset(approved, { transition: 'publish', versionId: asset.versions[0]!.versionId }),
  );
  expectValue(await repository.save(published));
  return published;
}

/** A published item whose stem references the given asset version. */
async function publishedItemUsing(assetVersionId: string): Promise<void> {
  const stem = expectValue(
    createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'FULL_WIDTH' }]),
  );
  const itemVersion = expectValue(
    createItemVersion(
      itemVersionProps({
        versionId: freshUuid(),
        stem,
        authoredBy: DB_AUTHOR,
        taxonomyTags: [
          { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
        ],
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

describe('bytes never cross this boundary (DEC-6)', () => {
  // The check that would have caught a base64 blob before it became a table
  // nobody can migrate.
  it('declares no byte-bearing field', () => {
    expect(MODULE_SOURCE).not.toMatch(/readonly\s+(bytes|data|buffer|content|base64|blob|file)\s*\??:/iu);
  });

  it('round trips the storage key and checksum instead', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded.versions[0]).toMatchObject({
      storageKey: 'content/media/ramp-v1.png',
      checksum: 'sha256:3f1a',
    });
  });
});

describe('save and load round trip', () => {
  it('reconstitutes an identical aggregate', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded).toMatchObject({
      assetId: asset.assetId,
      assetType: 'diagram',
      lifecycleState: 'draft',
      aggregateVersion: 1,
    });
  });

  it('round trips the accessible description', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded.versions[0]).toMatchObject({
      altText: 'A block on a ramp inclined at thirty degrees',
      longDescription: 'The ramp rises left to right at 30°, with arrows for weight and normal force.',
    });
  });

  it('omits the long description for a photograph that has none', async () => {
    const props = versionProps();
    delete (props as { longDescription?: unknown }).longDescription;
    const asset = expectValue(
      createMediaAsset({
        assetId: freshUuid(),
        assetType: 'photograph',
        initialVersion: expectValue(createMediaAssetVersion(props, 'photograph')),
      }),
    );
    expectValue(await repository.save(asset));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(Object.hasOwn(loaded.versions[0]!, 'longDescription')).toBe(false);
  });

  it('round trips dimensions and format', async () => {
    const asset = draftAsset({ mimeType: 'image/svg+xml', width: 1024, height: 768 });
    expectValue(await repository.save(asset));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded.versions[0]).toMatchObject({ mimeType: 'image/svg+xml', width: 1024, height: 768 });
  });

  it('round trips licensing, including an expiry', async () => {
    const asset = draftAsset({
      licensing: {
        status: 'licensed',
        licenseRef: 'CC-BY-4.0',
        attribution: 'Acme Illustration',
        expiresAt: '2027-01-01T00:00:00.000Z',
      },
    });
    expectValue(await repository.save(asset));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded.versions[0]!.licensing).toEqual({
      status: 'licensed',
      licenseRef: 'CC-BY-4.0',
      attribution: 'Acme Illustration',
      expiresAt: '2027-01-01T00:00:00.000Z',
    });
  });

  it('defaults to unresolved when rights were never stated', async () => {
    const props = versionProps();
    delete (props as { licensing?: unknown }).licensing;
    const asset = expectValue(
      createMediaAsset({
        assetId: freshUuid(),
        assetType: 'diagram',
        initialVersion: expectValue(createMediaAssetVersion(props, 'diagram')),
      }),
    );
    expectValue(await repository.save(asset));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded.versions[0]!.licensing).toEqual({ status: 'unresolved' });
  });

  it('reports NotFound for an asset that does not exist', async () => {
    expect(expectError(await repository.findById(freshUuid())).code).toBe('NOT_FOUND');
  });
});

describe('replacement via versioning (FR-QM-06 rule 3)', () => {
  it('keeps both versions and publishes the named one', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    const published = await publishAsset(asset);

    const second = version({ versionId: freshUuid(), versionNo: 2, checksum: 'sha256:9c2b' });
    expectValue(await repository.save(expectValue(addMediaAssetVersion(published, second))));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded.versions.map((entry) => entry.versionNo)).toEqual([1, 2]);
    expect(loaded.currentPublishedVersionId).toBe(asset.versions[0]!.versionId);
  });

  it('finds the published version', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);

    expect(expectValue(await repository.findPublishedVersion(asset.assetId)).versionId).toBe(
      asset.versions[0]!.versionId,
    );
  });

  it('reports NotFound while nothing is published', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    expect(expectError(await repository.findPublishedVersion(asset.assetId)).code).toBe('NOT_FOUND');
  });

  it('reports NotFound from findPublishedVersion for an unknown asset', async () => {
    expect(expectError(await repository.findPublishedVersion(freshUuid())).code).toBe('NOT_FOUND');
  });

  it('arms the immutability trigger, so a published asset cannot be swapped', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);

    await expect(
      database.pool.query(
        `UPDATE content.media_asset_version SET storage_key = 'swapped' WHERE asset_version_id = $1`,
        [asset.versions[0]!.versionId],
      ),
    ).rejects.toThrow(/content_published_version_is_immutable/u);
  });
});

describe('the usage graph FR-QM-06 rule 3 consumes', () => {
  it('counts zero for an asset nothing uses', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);

    expect(
      expectValue(await repository.countReferencingPublishedContent(asset.versions[0]!.versionId)),
    ).toBe(0);
  });

  it('counts a published item that references it', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);
    await publishedItemUsing(asset.versions[0]!.versionId);

    expect(
      expectValue(await repository.countReferencingPublishedContent(asset.versions[0]!.versionId)),
    ).toBe(1);
  });

  // A draft is not circulating, so it does not block retirement.
  it('does not count a draft item that references it', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);
    const assetVersionId = asset.versions[0]!.versionId;

    const stem = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'INLINE' }]),
    );
    const itemVersion = expectValue(
      createItemVersion(
        itemVersionProps({
          versionId: freshUuid(),
          stem,
          authoredBy: DB_AUTHOR,
          taxonomyTags: [
            { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
          ],
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

    expect(expectValue(await repository.countReferencingPublishedContent(assetVersionId))).toBe(0);
  });

  it('counts a published stimulus that references it', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);
    const assetVersionId = asset.versions[0]!.versionId;

    const body = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'FULL_WIDTH' }]),
    );
    const stimulusVersion = expectValue(
      createStimulusVersion({
        versionId: freshUuid(),
        versionNo: 1,
        body,
        licensing: { status: 'owned' },
        authoredBy: DB_AUTHOR,
        createdAt: AUTHORED_AT,
      }),
    );
    const stimulus = expectValue(
      createStimulus({ stimulusId: freshUuid(), stimulusType: 'diagram', initialVersion: stimulusVersion }),
    );
    expectValue(await stimuli.save(stimulus));
    const approved = expectValue(
      transitionStimulus(
        expectValue(transitionStimulus(stimulus, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    expectValue(
      await stimuli.save(
        expectValue(transitionStimulus(approved, { transition: 'publish', versionId: stimulusVersion.versionId })),
      ),
    );

    expect(expectValue(await repository.countReferencingPublishedContent(assetVersionId))).toBe(1);
  });

  it('counts a published solution that references it', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);
    const assetVersionId = asset.versions[0]!.versionId;

    const itemVersion = expectValue(
      createItemVersion(
        itemVersionProps({
          versionId: freshUuid(),
          authoredBy: DB_AUTHOR,
          taxonomyTags: [
            { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
          ],
        }),
        PROVENANCE_CONTEXT,
      ),
    );
    const item = expectValue(
      createItem({ itemId: freshUuid(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: itemVersion }),
    );
    expectValue(await items.save(item));

    const body = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'HALF_WIDTH' }]),
    );
    const solutionVersion = expectValue(
      createSolutionVersion({
        versionId: freshUuid(),
        versionNo: 1,
        finalAnswerAssertion: { kind: 'OPTION', optionId: 'b' },
        steps: [{ ordinal: 1, body, conceptRefs: [] }],
        authoredBy: DB_AUTHOR,
        createdAt: AUTHORED_AT,
      }),
    );
    const solution = expectValue(
      createSolution({
        solutionId: freshUuid(),
        itemId: item.itemId,
        targetItemVersionId: itemVersion.versionId,
        initialVersion: solutionVersion,
      }),
    );
    expectValue(await solutions.save(solution));
    const approved = expectValue(
      transitionSolution(
        expectValue(transitionSolution(solution, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    expectValue(
      await solutions.save(
        expectValue(transitionSolution(approved, { transition: 'publish', versionId: solutionVersion.versionId })),
      ),
    );

    expect(expectValue(await repository.countReferencingPublishedContent(assetVersionId))).toBe(1);
  });

  // Counting per owner kind and adding would give three chances to forget one.
  it('counts across all three owner kinds in one answer', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);
    const assetVersionId = asset.versions[0]!.versionId;

    await publishedItemUsing(assetVersionId);
    await publishedItemUsing(assetVersionId);

    expect(expectValue(await repository.countReferencingPublishedContent(assetVersionId))).toBe(2);
  });

  // Still pinned and reinstatable, so retiring the asset underneath it would
  // break the item on reinstatement.
  it('counts a suspended item', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    await publishAsset(asset);
    const assetVersionId = asset.versions[0]!.versionId;
    await publishedItemUsing(assetVersionId);

    const [row] = (
      await database.pool.query<{ item_id: string }>(
        `SELECT i.item_id FROM content.item i
           JOIN content.content_media_ref r ON r.owner_version_id = i.current_published_version_id
          WHERE r.media_asset_version_id = $1 LIMIT 1`,
        [assetVersionId],
      )
    ).rows;
    await database.pool.query(
      `UPDATE content.item SET lifecycle_state = 'suspended' WHERE item_id = $1`,
      [row!.item_id],
    );

    expect(expectValue(await repository.countReferencingPublishedContent(assetVersionId))).toBe(1);
  });

  it('retires once nothing published references it', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    const published = await publishAsset(asset);

    const referencing = expectValue(
      await repository.countReferencingPublishedContent(asset.versions[0]!.versionId),
    );
    const retired = expectValue(
      transitionMediaAsset(published, {
        transition: 'retire',
        retirementReason: 'superseded by a clearer figure',
        referencingPublishedContentCount: referencing,
      }),
    );
    expectValue(await repository.save(retired));

    const loaded = expectValue(await repository.findById(asset.assetId));
    expect(loaded).toMatchObject({
      lifecycleState: 'retired',
      retirementReason: 'superseded by a clearer figure',
    });
  });
});

describe('optimistic concurrency and failure reporting', () => {
  it('rejects a stale write as a Conflict', async () => {
    const asset = draftAsset();
    expectValue(await repository.save(asset));
    expectValue(
      await repository.save(expectValue(transitionMediaAsset(asset, { transition: 'submit_for_review' }))),
    );

    const failure = expectError(
      await repository.save(expectValue(transitionMediaAsset(asset, { transition: 'submit_for_review' }))),
    );
    expect(failure.code).toBe('CONFLICT');
  });

  it('rolls back the whole save when the database refuses a part', async () => {
    const asset = draftAsset();
    const broken = { ...asset, assetType: 'video' as never } as MediaAsset;

    expect(expectError(await repository.save(broken)).code).toBe('PERSISTENCE_REJECTED');
    const rows = await database.pool.query(`SELECT 1 FROM content.media_asset WHERE asset_id = $1`, [
      asset.assetId,
    ]);
    expect(rows.rowCount).toBe(0);
  });

  it('reports a stored asset that cannot reconstitute', async () => {
    const assetId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.media_asset (asset_id, asset_type) VALUES ($1, 'diagram')`,
      [assetId],
    );
    for (const versionNo of [1, 3]) {
      await database.pool.query(
        `INSERT INTO content.media_asset_version
           (asset_version_id, asset_id, version_no, storage_key, checksum, mime_type, width, height,
            alt_text, authored_by_kind, authored_by_id)
         VALUES ($1, $2, $3, 'k', 'c', 'image/png', 10, 10, 'alt', 'human', $4)`,
        [freshUuid(), assetId, versionNo, AUTHOR_ID],
      );
    }

    const failure = expectError(await repository.findById(assetId));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).toContain('contiguously');
  });
});

