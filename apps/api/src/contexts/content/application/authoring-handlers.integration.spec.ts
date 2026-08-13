import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  NUMERIC_SPEC,
  itemOption,
  numericSpec,
  originalProvenance,
  singleCorrectSpec,
  textBody,
} from '../../../testing/content-fixtures.js';
import type { Result } from '../domain/result.js';
import { createContentBody } from '../domain/content-body.js';
import { transitionItem } from '../domain/item.js';
import { createMediaAsset, createMediaAssetVersion } from '../domain/media-asset.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import { PostgresMediaAssetRepository } from '../infrastructure/media-asset.repository.js';
import type { AuthoredItemContent } from './commands/authoring-commands.js';
import {
  CreateItemDraftHandler,
  DeleteItemDraftHandler,
  DeriveDraftFromVersionHandler,
  UpdateItemDraftHandler,
  type ItemAuthoringDependencies,
} from './handlers/authoring-handlers.js';
import type { ApplicationError } from './authorization.js';
import {
  InMemoryAuditRecorder,
  InMemoryIdempotencyStore,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
} from './ports.js';

type Refusal = Result<unknown, ApplicationError>;

/**
 * Track C against a real database (§5 — integration never mocks the database).
 * The handlers are the first code in this milestone that writes content on
 * somebody's behalf, so every criterion here is proven end to end rather than
 * against a stub repository that would agree with whatever the handler did.
 */

let database: TestDatabase;
let items: PostgresItemRepository;
let assets: PostgresMediaAssetRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  assets = new PostgresMediaAssetRepository(database.pool);
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
const OTHER_AUTHOR_ID = freshUuid();
const OPS_ID = freshUuid();
const LEARNER_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const OTHER_CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();

const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author'] };
const otherAuthor: PrincipalRef = { kind: 'human', id: OTHER_AUTHOR_ID, roleContext: ['author'] };
const contentOps: PrincipalRef = { kind: 'human', id: OPS_ID, roleContext: ['content_ops'] };
const learner: PrincipalRef = { kind: 'human', id: LEARNER_ID, roleContext: ['learner'] };

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-1' });

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: () => freshUuid() };

function bench(): ItemAuthoringDependencies & {
  readonly audit: InMemoryAuditRecorder;
  readonly idempotency: InMemoryIdempotencyStore;
} {
  return {
    items,
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    idempotency: new InMemoryIdempotencyStore(),
  };
}

function content(overrides: Partial<AuthoredItemContent> = {}): AuthoredItemContent {
  return {
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [
      { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
    ],
    difficultyEstimate: 'moderate',
    provenance: originalProvenance(),
    licensing: { status: 'owned' },
    ...overrides,
  };
}

async function draftFor(
  deps: ItemAuthoringDependencies,
  principal: PrincipalRef = author,
  overrides: Partial<AuthoredItemContent> = {},
) {
  return expectValue(
    await new CreateItemDraftHandler(deps).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: content(overrides) },
      as(principal),
    ),
  );
}

/** A saved, draft media asset version, so an edge has something to reference. */
async function mediaVersionId(): Promise<string> {
  const version = expectValue(
    createMediaAssetVersion(
      {
        versionId: freshUuid(),
        versionNo: 1,
        storageKey: 'content/media/ramp.png',
        checksum: 'sha256:abcd',
        mimeType: 'image/png',
        width: 800,
        height: 600,
        altText: 'A block on a ramp inclined at thirty degrees',
        longDescription: 'The ramp rises left to right at 30°, with weight and normal-force arrows.',
        licensing: { status: 'owned' },
        authoredBy: author,
        createdAt: '2026-08-09T10:00:00Z',
      },
      'diagram',
    ),
  );
  const asset = expectValue(
    createMediaAsset({ assetId: freshUuid(), assetType: 'diagram', initialVersion: version }),
  );
  expectValue(await assets.save(asset));
  return version.versionId;
}

describe('CreateItemDraft', () => {
  it('persists a draft holding exactly one version, authored by the principal', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const loaded = expectValue(await items.findById(created.itemId));
    expect(loaded.lifecycleState).toBe('draft');
    expect(loaded.versions).toHaveLength(1);
    expect(loaded.versions[0]!.versionNo).toBe(1);
    expect(loaded.versions[0]!.authoredBy.id).toBe(AUTHOR_ID);
  });

  it('stamps createdAt from the clock port rather than from the caller', async () => {
    const created = await draftFor(bench());
    expect(created.versions[0]!.createdAt).toBe(NOW.toISOString());
  });

  it('writes one audit record naming the principal and the item', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    expect(deps.audit.entriesFor(created.itemId)).toHaveLength(1);
    expect(deps.audit.entries[0]).toMatchObject({
      action: 'CreateItemDraft',
      targetContext: 'content',
      targetType: 'Item',
      correlationId: 'corr-1',
      occurredAt: NOW,
    });
    expect(deps.audit.entries[0]!.principal.id).toBe(AUTHOR_ID);
  });

  it('reports an invalid body with the location the editor can point at', async () => {
    const deps = bench();
    const failed = await new CreateItemDraftHandler(deps).handle(
      { itemType: 'SINGLE_CORRECT_MCQ', content: content({ taxonomyTags: [] }) },
      as(author),
    );
    const error = expectError(failed);
    expect(error.kind).toBe('Validation');
    expect(error.location).toContain('taxonomyTags');
    expect(deps.audit.entries).toHaveLength(0);
  });

  it('refuses an item type the specification does not match', async () => {
    const failed = await new CreateItemDraftHandler(bench()).handle(
      { itemType: 'NUMERIC', content: content() },
      as(author),
    );
    expect(expectError(failed).code).toBe('ITEM_TYPE_MISMATCH');
  });
});

/**
 * DEC-3's guarantee on the write path: a specification whose projection the
 * executor refuses cannot be saved. Before M3-45's corpus found this, the
 * refusal came from a database CHECK constraint — so the author was told a
 * constraint name instead of that their numeric item has no tolerance.
 */
describe('a specification the executor refuses cannot be saved (DEC-3)', () => {
  function numericWithoutTolerance(): AuthoredItemContent {
    const { toleranceValue: _dropped, ...spec } = NUMERIC_SPEC;
    return content({
      responseSpec: { itemType: 'NUMERIC', spec } as AuthoredItemContent['responseSpec'],
    });
  }

  it('refuses to create a numeric draft with no tolerance, naming the field', async () => {
    const refused: Refusal = await new CreateItemDraftHandler(bench()).handle(
      { itemType: 'NUMERIC', content: numericWithoutTolerance() },
      as(author),
    );
    const error = expectError(refused);
    expect(error.code).toBe('ANSWER_KEY_REJECTED_BY_EXECUTOR');
    expect(error.location).toBe('version.responseSpec');
    expect(error.message).not.toMatch(/violates check constraint/u);
  });

  // The draft has to be numeric to begin with, or the item-type cross-check
  // refuses first and this would be testing that instead.
  it('refuses the same edit to an existing numeric draft', async () => {
    const deps = bench();
    const created = expectValue(
      await new CreateItemDraftHandler(deps).handle(
        { itemType: 'NUMERIC', content: content({ responseSpec: numericSpec() }) },
        as(author),
      ),
    );

    const refused: Refusal = await new UpdateItemDraftHandler(deps).handle(
      { itemId: created.itemId, content: numericWithoutTolerance(), idempotencyKey: 'save-bad' },
      as(author),
    );
    expect(expectError(refused).code).toBe('ANSWER_KEY_REJECTED_BY_EXECUTOR');
  });

  it('accepts the same item once the tolerance is there', async () => {
    const created = expectValue(
      await new CreateItemDraftHandler(bench()).handle(
        { itemType: 'NUMERIC', content: content({ responseSpec: numericSpec() }) },
        as(author),
      ),
    );
    expect(created.lifecycleState).toBe('draft');
  });
});

describe('UpdateItemDraft — autosave', () => {
  it('edits the draft in place instead of appending a version', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const updated = expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        {
          itemId: created.itemId,
          content: content({ stem: textBody('A block slides down a rough ramp.') }),
          idempotencyKey: 'save-1',
        },
        as(author),
      ),
    );

    expect(updated.versions).toHaveLength(1);
    expect(updated.versions[0]!.versionId).toBe(created.versions[0]!.versionId);

    const loaded = expectValue(await items.findById(created.itemId));
    expect(loaded.versions).toHaveLength(1);
    expect(loaded.versions[0]!.stem).toEqual(textBody('A block slides down a rough ramp.'));
  });

  it('leaves createdAt and authorship where they were', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content(), idempotencyKey: 'k' },
        as(contentOps),
      ),
    );

    const loaded = expectValue(await items.findById(created.itemId));
    expect(loaded.versions[0]!.createdAt).toBe(created.versions[0]!.createdAt);
    // Content Ops fixing a typo does not take ownership of somebody's draft.
    expect(loaded.versions[0]!.authoredBy.id).toBe(AUTHOR_ID);
  });

  it('moves updated_at while leaving created_at alone', async () => {
    const deps = bench();
    const created = await draftFor(deps);
    const before = await database.pool.query<{ created_at: Date; updated_at: Date }>(
      `SELECT created_at, updated_at FROM content.item_version WHERE item_id = $1`,
      [created.itemId],
    );

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content({ difficultyEstimate: 'challenging' }), idempotencyKey: 'k' },
        as(author),
      ),
    );

    const after = await database.pool.query<{ created_at: Date; updated_at: Date }>(
      `SELECT created_at, updated_at FROM content.item_version WHERE item_id = $1`,
      [created.itemId],
    );
    expect(after.rows[0]!.created_at).toEqual(before.rows[0]!.created_at);
    expect(after.rows[0]!.updated_at.getTime()).toBeGreaterThanOrEqual(
      before.rows[0]!.updated_at.getTime(),
    );
  });

  it('treats a repeated idempotency key as a no-op returning the current version', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const first = expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content({ difficultyEstimate: 'advanced' }), idempotencyKey: 'retry' },
        as(author),
      ),
    );
    const second = expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content({ difficultyEstimate: 'foundational' }), idempotencyKey: 'retry' },
        as(author),
      ),
    );

    expect(second.aggregateVersion).toBe(first.aggregateVersion);
    expect(second.versions[0]!.difficultyEstimate).toBe('advanced');

    const loaded = expectValue(await items.findById(created.itemId));
    expect(loaded.versions).toHaveLength(1);
    expect(loaded.versions[0]!.difficultyEstimate).toBe('advanced');
    // Create plus one applied update, and nothing for the retry.
    expect(deps.audit.entries).toHaveLength(2);
  });

  it('applies a genuinely later save under a new key', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content({ difficultyEstimate: 'advanced' }), idempotencyKey: 'a' },
        as(author),
      ),
    );
    const later = expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content({ difficultyEstimate: 'foundational' }), idempotencyKey: 'b' },
        as(author),
      ),
    );

    expect(later.versions[0]!.difficultyEstimate).toBe('foundational');
    expect(deps.audit.entries).toHaveLength(3);
  });

  it('reconciles the option set rather than accumulating it', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        {
          itemId: created.itemId,
          content: content({
            responseSpec: singleCorrectSpec({
              options: [itemOption('a', 1), itemOption('b', 2)],
              correctOptionId: 'b',
            }),
          }),
          idempotencyKey: 'k',
        },
        as(author),
      ),
    );

    const stored = await database.pool.query<{ option_id: string }>(
      `SELECT option_id FROM content.item_option WHERE item_version_id = $1 ORDER BY ordinal`,
      [created.versions[0]!.versionId],
    );
    expect(stored.rows.map((row) => row.option_id)).toEqual(['a', 'b']);
  });

  it('reconciles the tag set', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        {
          itemId: created.itemId,
          content: content({
            taxonomyTags: [
              { conceptIdentityId: OTHER_CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
            ],
          }),
          idempotencyKey: 'k',
        },
        as(author),
      ),
    );

    const stored = await database.pool.query<{ concept_identity_id: string }>(
      `SELECT concept_identity_id FROM content.item_taxonomy_tag WHERE item_version_id = $1`,
      [created.versions[0]!.versionId],
    );
    expect(stored.rows.map((row) => row.concept_identity_id)).toEqual([OTHER_CONCEPT_ID]);
  });

  it('removes a media edge the author dropped, so the asset stops looking in use', async () => {
    const deps = bench();
    const assetVersionId = await mediaVersionId();
    const withMedia = expectValue(
      createContentBody([{ kind: 'MEDIA_BLOCK', assetVersionId, sizeHint: 'FULL_WIDTH' }]),
    );
    const created = await draftFor(deps, author, { stem: withMedia });

    const edgesBefore = await database.pool.query(
      `SELECT 1 FROM content.content_media_ref WHERE owner_version_id = $1`,
      [created.versions[0]!.versionId],
    );
    expect(edgesBefore.rowCount).toBe(1);

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content(), idempotencyKey: 'k' },
        as(author),
      ),
    );

    const edgesAfter = await database.pool.query(
      `SELECT 1 FROM content.content_media_ref WHERE owner_version_id = $1`,
      [created.versions[0]!.versionId],
    );
    expect(edgesAfter.rowCount).toBe(0);
  });

  it('carries a numeric decimal literal through an edit as text', async () => {
    const deps = bench();
    const created = expectValue(
      await new CreateItemDraftHandler(deps).handle(
        { itemType: 'NUMERIC', content: content({ responseSpec: numericSpec() }) },
        as(author),
      ),
    );

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        {
          itemId: created.itemId,
          content: content({ responseSpec: numericSpec({ expectedValue: '0.1000', toleranceValue: '0.1' }) }),
          idempotencyKey: 'k',
        },
        as(author),
      ),
    );

    const stored = await database.pool.query<{ expected_value: string; tolerance_value: string }>(
      `SELECT expected_value, tolerance_value FROM content.item_numeric_spec WHERE item_version_id = $1`,
      [created.versions[0]!.versionId],
    );
    expect(stored.rows[0]!.expected_value).toBe('0.1000');
    expect(stored.rows[0]!.tolerance_value).toBe('0.1');
  });

  it('refuses an edit once the draft has been submitted for review', async () => {
    const deps = bench();
    const created = await draftFor(deps);
    expectValue(
      await items.save(expectValue(transitionItem(created, { transition: 'submit_for_review' }))),
    );

    const refused = await new UpdateItemDraftHandler(deps).handle(
      { itemId: created.itemId, content: content(), idempotencyKey: 'k' },
      as(author),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('RuleViolation');
    expect(error.code).toBe('VERSION_NOT_EDITABLE');
  });

  it('reports an item that does not exist rather than creating one', async () => {
    const refused = await new UpdateItemDraftHandler(bench()).handle(
      { itemId: freshUuid(), content: content(), idempotencyKey: 'k' },
      as(author),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('reports invalid edited content and leaves the stored draft untouched', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const refused = await new UpdateItemDraftHandler(deps).handle(
      { itemId: created.itemId, content: content({ taxonomyTags: [] }), idempotencyKey: 'k' },
      as(author),
    );
    expect(expectError(refused).kind).toBe('Validation');

    const loaded = expectValue(await items.findById(created.itemId));
    expect(loaded.versions[0]!.taxonomyTags).toHaveLength(1);
  });
});

describe('DeriveDraftFromVersion', () => {
  it('appends a successor authored by the principal making the edit', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const derived = expectValue(
      await new DeriveDraftFromVersionHandler(deps).handle(
        { itemId: created.itemId, fromVersionId: created.versions[0]!.versionId },
        as(contentOps),
      ),
    );

    expect(derived.versions).toHaveLength(2);
    expect(derived.versions[1]!.versionNo).toBe(2);
    expect(derived.versions[1]!.authoredBy.id).toBe(OPS_ID);

    const loaded = expectValue(await items.findById(created.itemId));
    expect(loaded.versions).toHaveLength(2);
    // The original is untouched — INV-03 and INV-04 both rest on this.
    expect(loaded.versions[0]!.versionId).toBe(created.versions[0]!.versionId);
  });

  it('reports a version the item does not hold', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const refused = await new DeriveDraftFromVersionHandler(deps).handle(
      { itemId: created.itemId, fromVersionId: freshUuid() },
      as(author),
    );
    const error = expectError(refused);
    expect(error.kind).toBe('NotFound');
    expect(error.code).toBe('VERSION_NOT_FOUND');
  });

  it('reports an item that does not exist', async () => {
    const refused = await new DeriveDraftFromVersionHandler(bench()).handle(
      { itemId: freshUuid(), fromVersionId: freshUuid() },
      as(author),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('refuses a successor while the item is under review', async () => {
    const deps = bench();
    const created = await draftFor(deps);
    expectValue(
      await items.save(expectValue(transitionItem(created, { transition: 'submit_for_review' }))),
    );

    const refused = await new DeriveDraftFromVersionHandler(deps).handle(
      { itemId: created.itemId, fromVersionId: created.versions[0]!.versionId },
      as(author),
    );
    expect(expectError(refused).code).toBe('VERSION_NOT_EDITABLE');
  });

  it('audits the derived version', async () => {
    const deps = bench();
    const created = await draftFor(deps);
    const derived = expectValue(
      await new DeriveDraftFromVersionHandler(deps).handle(
        { itemId: created.itemId, fromVersionId: created.versions[0]!.versionId },
        as(author),
      ),
    );

    expect(deps.audit.entriesFor(derived.versions[1]!.versionId)).toHaveLength(1);
  });
});

describe('DeleteItemDraft', () => {
  it('discards the draft and audits the justification', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    expectValue(
      await new DeleteItemDraftHandler(deps).handle(
        { itemId: created.itemId, justification: 'duplicate of an existing item' },
        as(author),
      ),
    );

    expect(expectError(await items.findById(created.itemId)).kind).toBe('NotFound');
    expect(deps.audit.entriesFor(created.itemId).at(-1)).toMatchObject({
      action: 'DeleteItemDraft',
      justification: 'duplicate of an existing item',
    });
  });

  it('refuses to delete anything past draft, and the item survives', async () => {
    const deps = bench();
    const created = await draftFor(deps);
    expectValue(
      await items.save(expectValue(transitionItem(created, { transition: 'submit_for_review' }))),
    );

    const refused = await new DeleteItemDraftHandler(deps).handle(
      { itemId: created.itemId, justification: 'changed my mind' },
      as(author),
    );
    expect(expectError(refused).code).toBe('ITEM_NOT_DELETABLE');
    expectValue(await items.findById(created.itemId));
  });

  it('reports an item that does not exist', async () => {
    const refused = await new DeleteItemDraftHandler(bench()).handle(
      { itemId: freshUuid(), justification: 'x' },
      as(author),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });
});

describe('drafts are scoped to their author (FR-TCH-06 rule 1)', () => {
  it('refuses another author reaching a draft, and says why rather than returning nothing', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const refusals: readonly Refusal[] = [
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content(), idempotencyKey: 'k' },
        as(otherAuthor),
      ),
      await new DeriveDraftFromVersionHandler(deps).handle(
        { itemId: created.itemId, fromVersionId: created.versions[0]!.versionId },
        as(otherAuthor),
      ),
      await new DeleteItemDraftHandler(deps).handle(
        { itemId: created.itemId, justification: 'not mine' },
        as(otherAuthor),
      ),
    ];
    for (const refused of refusals) {
      const error = expectError(refused);
      expect(error.kind).toBe('Authorization');
      expect(error.code).toBe('NOT_THE_DRAFT_OWNER');
    }
  });

  it('permits Content Ops on somebody else’s draft', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content({ difficultyEstimate: 'advanced' }), idempotencyKey: 'k' },
        as(contentOps),
      ),
    );
    const loaded = expectValue(await items.findById(created.itemId));
    expect(loaded.versions[0]!.difficultyEstimate).toBe('advanced');
  });

  it('refuses a principal holding no authoring role at all', async () => {
    const deps = bench();
    const created = await draftFor(deps);

    const refusals: readonly Refusal[] = [
      await new CreateItemDraftHandler(deps).handle(
        { itemType: 'SINGLE_CORRECT_MCQ', content: content() },
        as(learner),
      ),
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content(), idempotencyKey: 'k' },
        as(learner),
      ),
      await new DeriveDraftFromVersionHandler(deps).handle(
        { itemId: created.itemId, fromVersionId: created.versions[0]!.versionId },
        as(learner),
      ),
      await new DeleteItemDraftHandler(deps).handle(
        { itemId: created.itemId, justification: 'x' },
        as(learner),
      ),
    ];
    for (const refused of refusals) {
      const error = expectError(refused);
      expect(error.kind).toBe('Authorization');
      expect(error.code).toBe('NOT_PERMITTED');
    }
  });

  it('refuses an unauthorized retry before the idempotency store is consulted', async () => {
    const deps = bench();
    const created = await draftFor(deps);
    expectValue(
      await new UpdateItemDraftHandler(deps).handle(
        { itemId: created.itemId, content: content(), idempotencyKey: 'shared' },
        as(author),
      ),
    );

    const refused = await new UpdateItemDraftHandler(deps).handle(
      { itemId: created.itemId, content: content(), idempotencyKey: 'shared' },
      as(otherAuthor),
    );
    expect(expectError(refused).code).toBe('NOT_THE_DRAFT_OWNER');
  });
});
