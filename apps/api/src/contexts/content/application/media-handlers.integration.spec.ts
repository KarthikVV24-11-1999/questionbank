import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { filesMatching } from '../../../fitness/source-scan.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../testing/content-fixtures.js';
import type { Result } from '../domain/result.js';
import { createContentBody } from '../domain/content-body.js';
import { publishVersion, transitionItem } from '../domain/item.js';
import {
  latestMediaVersionOf,
  transitionMediaAsset,
  type MediaAsset,
} from '../domain/media-asset.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import { PostgresMediaAssetRepository } from '../infrastructure/media-asset.repository.js';
import type { ApplicationError } from './authorization.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';
import type { AuthoredMediaVersion } from './commands/media-commands.js';
import { CreateItemDraftHandler, type ItemAuthoringDependencies } from './handlers/authoring-handlers.js';
import {
  AddMediaAssetVersionHandler,
  checkStoredObjectUnchanged,
  RegisterMediaAssetHandler,
  RetireMediaAssetHandler,
  type MediaAuthoringDependencies,
} from './handlers/media-handlers.js';
import {
  InMemoryAuditRecorder,
  InMemoryIdempotencyStore,
  InMemoryMediaStore,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
} from './ports.js';

/**
 * FR-QM-06 against a real database. Two criteria carry the task: bytes stay
 * outside everything the context stores or passes around, and an object
 * replaced behind a registered key is detectable before it publishes.
 */

let database: TestDatabase;
let assets: PostgresMediaAssetRepository;
let items: PostgresItemRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  assets = new PostgresMediaAssetRepository(database.pool);
  items = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-d000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR_ID = freshUuid();
const OPS_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();

const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author', 'subject:physics'] };
const contentOps: PrincipalRef = { kind: 'human', id: OPS_ID, roleContext: ['content_ops'] };
const learner: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['learner'] };

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-1' });
type Refusal = Result<unknown, ApplicationError>;

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: () => freshUuid() };

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function bench(store = new InMemoryMediaStore()): MediaAuthoringDependencies & {
  readonly audit: InMemoryAuditRecorder;
  readonly store: InMemoryMediaStore;
} {
  return { assets, store, clock, identifiers, audit: new InMemoryAuditRecorder() };
}

function itemBench(): ItemAuthoringDependencies {
  return {
    items,
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
  };
}

function mediaVersion(
  storageKey: string,
  overrides: Partial<AuthoredMediaVersion> = {},
): AuthoredMediaVersion {
  return {
    storageKey,
    mimeType: 'image/png',
    width: 800,
    height: 600,
    altText: 'A block on a ramp inclined at thirty degrees',
    longDescription: 'The ramp rises left to right at 30°, with weight and normal-force arrows.',
    licensing: { status: 'owned' },
    ...overrides,
  };
}

/** Stages an object the way the upload edge would, then registers it. */
async function registered(
  deps: ReturnType<typeof bench>,
  overrides: Partial<AuthoredMediaVersion> = {},
): Promise<{ asset: MediaAsset; storageKey: string }> {
  const stored = await deps.store.put(PNG, 'image/png');
  const asset = expectValue(
    await new RegisterMediaAssetHandler(deps).handle(
      { assetType: 'diagram', subject: 'physics', version: mediaVersion(stored.storageKey, overrides) },
      as(author),
    ),
  );
  return { asset, storageKey: stored.storageKey };
}

async function publishAsset(deps: ReturnType<typeof bench>, asset: MediaAsset): Promise<MediaAsset> {
  const published = expectValue(
    transitionMediaAsset(
      expectValue(
        transitionMediaAsset(
          expectValue(transitionMediaAsset(asset, { transition: 'submit_for_review' })),
          { transition: 'approve' },
        ),
      ),
      { transition: 'publish', versionId: latestMediaVersionOf(asset).versionId },
    ),
  );
  expectValue(await assets.save(published));
  return published;
}

describe('RegisterMediaAsset', () => {
  it('records the checksum the store reports, not one the caller supplied', async () => {
    const deps = bench();
    const { asset, storageKey } = await registered(deps);

    const stored = await deps.store.head(storageKey);
    const loaded = expectValue(await assets.findById(asset.assetId));
    expect(loaded.versions[0]!.checksum).toBe(stored!.checksum);
    expect(loaded.versions[0]!.storageKey).toBe(storageKey);
    expect(loaded.lifecycleState).toBe('draft');
    expect(deps.audit.entriesFor(asset.assetId)).toHaveLength(1);
  });

  it('refuses a key the store does not hold', async () => {
    const deps = bench();
    const refused = await new RegisterMediaAssetHandler(deps).handle(
      { assetType: 'diagram', subject: 'physics', version: mediaVersion('content/media/never-uploaded') },
      as(author),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('NotFound');
    expect(error.code).toBe('OBJECT_NOT_STORED');
  });

  it('refuses a declared mime type the stored object contradicts', async () => {
    const deps = bench();
    const stored = await deps.store.put(PNG, 'image/png');
    const refused = await new RegisterMediaAssetHandler(deps).handle(
      {
        assetType: 'diagram',
        subject: 'physics',
        version: mediaVersion(stored.storageKey, { mimeType: 'image/svg+xml' }),
      },
      as(author),
    );
    expect(expectError(refused).code).toBe('MIME_TYPE_DISAGREES_WITH_STORED_OBJECT');
  });

  it('refuses an asset with no alt text (ACC-03)', async () => {
    const deps = bench();
    const stored = await deps.store.put(PNG, 'image/png');
    const refused = await new RegisterMediaAssetHandler(deps).handle(
      { assetType: 'diagram', subject: 'physics', version: mediaVersion(stored.storageKey, { altText: '  ' }) },
      as(author),
    );
    expect(expectError(refused).code).toBe('ALT_TEXT_REQUIRED');
  });

  it('refuses a diagram with no long description', async () => {
    const deps = bench();
    const stored = await deps.store.put(PNG, 'image/png');
    const { longDescription: _omitted, ...withoutDescription } = mediaVersion(stored.storageKey);
    const refused = await new RegisterMediaAssetHandler(deps).handle(
      { assetType: 'diagram', subject: 'physics', version: withoutDescription },
      as(author),
    );
    expect(expectError(refused).code).toBe('LONG_DESCRIPTION_REQUIRED');
  });
});

describe('AddMediaAssetVersion', () => {
  it('appends a version carrying the new object’s checksum', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const replacement = await deps.store.put(new Uint8Array([1, 2, 3]), 'image/png');

    const extended = expectValue(
      await new AddMediaAssetVersionHandler(deps).handle(
        { assetId: asset.assetId, subject: 'physics', version: mediaVersion(replacement.storageKey) },
        as(author),
      ),
    );

    expect(extended.versions).toHaveLength(2);
    expect(extended.versions[1]!.versionNo).toBe(2);
    expect(extended.versions[1]!.checksum).toBe(replacement.checksum);

    const loaded = expectValue(await assets.findById(asset.assetId));
    expect(loaded.versions).toHaveLength(2);
  });

  it('reports an asset that does not exist', async () => {
    const deps = bench();
    const stored = await deps.store.put(PNG, 'image/png');
    const refused = await new AddMediaAssetVersionHandler(deps).handle(
      { assetId: freshUuid(), subject: 'physics', version: mediaVersion(stored.storageKey) },
      as(author),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('refuses a key the store does not hold', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const refused = await new AddMediaAssetVersionHandler(deps).handle(
      { assetId: asset.assetId, subject: 'physics', version: mediaVersion('content/media/nothing') },
      as(author),
    );
    expect(expectError(refused).code).toBe('OBJECT_NOT_STORED');
  });

  it('refuses a new version on a retired asset', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const published = await publishAsset(deps, asset);
    expectValue(
      await assets.save(
        expectValue(
          transitionMediaAsset(published, {
            transition: 'retire',
            retirementReason: 'superseded',
            referencingPublishedContentCount: 0,
          }),
        ),
      ),
    );

    const stored = await deps.store.put(new Uint8Array([9]), 'image/png');
    const refused = await new AddMediaAssetVersionHandler(deps).handle(
      { assetId: asset.assetId, subject: 'physics', version: mediaVersion(stored.storageKey) },
      as(author),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_EDITABLE');
  });
});

describe('RetireMediaAsset', () => {
  /** A published item whose stem shows the given asset version. */
  async function publishedItemUsing(assetVersionId: string): Promise<void> {
    const stem = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'FULL_WIDTH' }]),
    );
    const content: AuthoredItemContent = {
      stem,
      responseSpec: singleCorrectSpec(),
      taxonomyTags: [
        { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
      ],
      difficultyEstimate: 'moderate',
      provenance: originalProvenance(),
      licensing: { status: 'owned' },
    };
    const item = expectValue(
      await new CreateItemDraftHandler(itemBench()).handle(
        { itemType: 'SINGLE_CORRECT_MCQ', content },
        as(author),
      ),
    );
    const approved = expectValue(
      transitionItem(
        expectValue(transitionItem(item, { transition: 'submit_for_review' })),
        { transition: 'approve' },
      ),
    );
    expectValue(
      await items.save(
        expectValue(
          publishVersion(approved, {
            versionId: item.versions[0]!.versionId,
            preconditionsSatisfied: true,
          }),
        ),
      ),
    );
  }

  it('retires an asset nothing published references', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const published = await publishAsset(deps, asset);

    const retired = expectValue(
      await new RetireMediaAssetHandler(deps).handle(
        { assetId: published.assetId, retirementReason: 'superseded by a clearer diagram' },
        as(contentOps),
      ),
    );
    expect(retired.lifecycleState).toBe('retired');
    expect(deps.audit.entries.at(-1)).toMatchObject({
      action: 'RetireMediaAsset',
      justification: 'superseded by a clearer diagram',
    });
  });

  it('refuses retirement while published content still shows it (FR-QM-06 rule 3)', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const published = await publishAsset(deps, asset);
    await publishedItemUsing(latestMediaVersionOf(published).versionId);

    const refused = await new RetireMediaAssetHandler(deps).handle(
      { assetId: published.assetId, retirementReason: 'no longer wanted' },
      as(contentOps),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('RuleViolation');
    expect(error.code).toBe('STILL_REFERENCED');

    expect(expectValue(await assets.findById(published.assetId)).lifecycleState).toBe('published');
  });

  it('refuses retirement of a draft asset — a draft is discarded, not retired', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const refused = await new RetireMediaAssetHandler(deps).handle(
      { assetId: asset.assetId, retirementReason: 'x' },
      as(contentOps),
    );
    expect(expectError(refused).code).toBe('TRANSITION_ILLEGAL');
  });

  it('reports an asset that does not exist', async () => {
    const refused = await new RetireMediaAssetHandler(bench()).handle(
      { assetId: freshUuid(), retirementReason: 'x' },
      as(contentOps),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('refuses an author — retirement removes a figure from everything downstream', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const refused = await new RetireMediaAssetHandler(deps).handle(
      { assetId: asset.assetId, retirementReason: 'x' },
      as(author),
    );
    expect(expectError(refused).code).toBe('NOT_PERMITTED');
  });
});

describe('the checksum is what makes a swapped object detectable', () => {
  it('accepts a version whose object is unchanged', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    expectValue(await checkStoredObjectUnchanged(deps.store, latestMediaVersionOf(asset)));
  });

  it('refuses publication of a version whose object was replaced', async () => {
    const deps = bench();
    const { asset, storageKey } = await registered(deps);
    await deps.store.replace(storageKey, new Uint8Array([0xff, 0xd8, 0xff]), 'image/png');

    const refused = await checkStoredObjectUnchanged(deps.store, latestMediaVersionOf(asset));
    const error = expectError(refused);
    expect(error.kind).toBe('PreconditionFailed');
    expect(error.code).toBe('CHECKSUM_MISMATCH');
  });

  it('refuses publication of a version whose object is gone', async () => {
    const deps = bench();
    const { asset } = await registered(deps);
    const refused = await checkStoredObjectUnchanged(new InMemoryMediaStore(), latestMediaVersionOf(asset));
    expect(expectError(refused).code).toBe('OBJECT_NOT_STORED');
  });
});

describe('authorization', () => {
  it('refuses a principal holding no authoring role', async () => {
    const deps = bench();
    const stored = await deps.store.put(PNG, 'image/png');
    const refusals: readonly Refusal[] = [
      await new RegisterMediaAssetHandler(deps).handle(
        { assetType: 'diagram', subject: 'physics', version: mediaVersion(stored.storageKey) },
        as(learner),
      ),
      await new AddMediaAssetVersionHandler(deps).handle(
        { assetId: freshUuid(), subject: 'physics', version: mediaVersion(stored.storageKey) },
        as(learner),
      ),
      await new RetireMediaAssetHandler(deps).handle(
        { assetId: freshUuid(), retirementReason: 'x' },
        as(learner),
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).code).toBe('NOT_PERMITTED');
    }
  });

  it('refuses media authoring outside the principal’s subject scope', async () => {
    const deps = bench();
    const stored = await deps.store.put(PNG, 'image/png');
    const refused = await new RegisterMediaAssetHandler(deps).handle(
      { assetType: 'diagram', subject: 'chemistry', version: mediaVersion(stored.storageKey) },
      as(author),
    );
    expect(expectError(refused).code).toBe('OUT_OF_SUBJECT_SCOPE');
  });
});

describe('bytes never cross the context boundary (DEC-6)', () => {
  const CONTEXT_DIR = fileURLToPath(new URL('..', import.meta.url));

  /**
   * `application/ports.ts` is the single exemption, and the reason is the
   * point of the rule: `MediaStore` names a byte array there so that nothing
   * else in the context has to. A second exemption would mean the rule had
   * stopped holding.
   */
  const EXEMPT = 'application/ports.ts';

  // `data` is on the per-module lists of M3-15 and M3-24 but deliberately not
  // here: across a whole context it matches `readonly data: AnswerKeyData`,
  // which carries no bytes at all. A guard that cries wolf gets exempted into
  // uselessness, so the name list here is the one that actually means bytes,
  // and the type scan below is the stronger of the two checks anyway.
  it('declares no byte-bearing field in any command, handler, domain module or event', () => {
    const offenders = filesMatching(CONTEXT_DIR, /readonly\s+(bytes|buffer|base64|blob|binary)\s*\??:/iu, {
      exclude: [EXEMPT],
    });
    expect(offenders).toEqual([]);
  });

  it('names Uint8Array, Buffer and Blob nowhere outside the port', () => {
    const offenders = filesMatching(CONTEXT_DIR, /\b(Uint8Array|Buffer|Blob|ArrayBuffer)\b/u, {
      exclude: [EXEMPT],
    });
    expect(offenders).toEqual([]);
  });

  it('would catch a byte field if one were added — the scan is not vacuous', () => {
    const found = filesMatching(CONTEXT_DIR, /readonly\s+storageKey\s*:/u, { exclude: [EXEMPT] });
    expect(found.length).toBeGreaterThan(0);
  });
});
