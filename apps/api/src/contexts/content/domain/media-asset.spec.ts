import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { AUTHOR, AUTHORED_AT } from '../../../testing/content-fixtures.js';
import { LIFECYCLE_STATES, type LifecycleState } from './item-lifecycle.js';
import {
  accessibleDescriptionOf,
  addMediaAssetVersion,
  ALLOWED_MIME_TYPES,
  ASSET_TYPES,
  createMediaAsset,
  createMediaAssetVersion,
  INFORMATION_BEARING_ASSET_TYPES,
  isAllowedMimeType,
  isAssetType,
  latestMediaVersionOf,
  publishedMediaVersionOf,
  reconstituteMediaAsset,
  requiresLongDescription,
  transitionMediaAsset,
  type AssetType,
  type CreateMediaAssetVersionProps,
  type MediaAsset,
  type MediaAssetVersion,
} from './media-asset.js';

const MODULE_SOURCE = readFileSync(fileURLToPath(new URL('./media-asset.ts', import.meta.url)), 'utf8');

function versionProps(overrides: Partial<CreateMediaAssetVersionProps> = {}): CreateMediaAssetVersionProps {
  return {
    versionId: 'asset-version-1',
    versionNo: 1,
    storageKey: 'content/media/ramp-diagram-v1.svg',
    checksum: 'sha256:3f1a…',
    mimeType: 'image/svg+xml',
    width: 800,
    height: 600,
    altText: 'A block on a ramp inclined at thirty degrees',
    longDescription: 'The ramp rises left to right at 30°, with the block partway up and arrows for weight and normal force.',
    licensing: { status: 'owned' },
    authoredBy: AUTHOR,
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

const V1 = version();
const V2 = version({ versionId: 'asset-version-2', versionNo: 2, checksum: 'sha256:9c2b…' });

function draft(): MediaAsset {
  return expectValue(createMediaAsset({ assetId: 'asset-1', assetType: 'diagram', initialVersion: V1 }));
}

function inState(state: LifecycleState, versions: readonly MediaAssetVersion[] = [V1]): MediaAsset {
  const needsPublished = state === 'published' || state === 'suspended';
  return expectValue(
    reconstituteMediaAsset({
      assetId: 'asset-1',
      assetType: 'diagram',
      lifecycleState: state,
      versions,
      aggregateVersion: 1,
      ...(needsPublished ? { currentPublishedVersionId: V1.versionId } : {}),
    }),
  );
}

describe('the vocabularies', () => {
  it('names the closed set of asset types', () => {
    expect([...ASSET_TYPES]).toEqual(['photograph', 'diagram', 'chart', 'graph', 'reaction_scheme']);
  });

  it('treats everything but a photograph as information-bearing', () => {
    expect([...INFORMATION_BEARING_ASSET_TYPES]).toEqual(['diagram', 'chart', 'graph', 'reaction_scheme']);
    for (const assetType of ASSET_TYPES) {
      expect(requiresLongDescription(assetType)).toBe(assetType !== 'photograph');
    }
  });

  it('recognises each asset type and rejects anything else', () => {
    for (const assetType of ASSET_TYPES) expect(isAssetType(assetType)).toBe(true);
    expect(isAssetType('video')).toBe(false);
  });

  it('names the closed set of storable formats', () => {
    expect([...ALLOWED_MIME_TYPES]).toEqual(['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml']);
  });

  it('recognises each allowed format and rejects anything else', () => {
    for (const mimeType of ALLOWED_MIME_TYPES) expect(isAllowedMimeType(mimeType)).toBe(true);
    expect(isAllowedMimeType('application/pdf')).toBe(false);
  });
});

describe('bytes never enter the domain (DEC-6)', () => {
  // The failure mode being prevented is a base64 blob in a JSONB column,
  // which is invisible until the table is unmanageable.
  it('declares no byte-bearing field anywhere on the module', () => {
    expect(MODULE_SOURCE).not.toMatch(/readonly\s+(bytes|data|buffer|content|base64|blob|file)\s*\??:/iu);
  });

  it('holds a storage key and a checksum instead', () => {
    expect(V1.storageKey).toBe('content/media/ramp-diagram-v1.svg');
    expect(V1.checksum).toBe('sha256:3f1a…');
  });

  it('requires a storage key', () => {
    expect(
      expectError(createMediaAssetVersion(versionProps({ storageKey: '  ' }), 'diagram')).code,
    ).toBe('STORAGE_KEY_REQUIRED');
  });

  // Re-verified before publication (M3-27), so a replaced object is
  // detectable rather than silently served.
  it('requires a checksum', () => {
    expect(expectError(createMediaAssetVersion(versionProps({ checksum: '' }), 'diagram')).code).toBe(
      'CHECKSUM_REQUIRED',
    );
  });
});

describe('alt text is required at construction, not at publication (ACC-03)', () => {
  it('carries the alt text it was given', () => {
    expect(V1.altText).toBe('A block on a ramp inclined at thirty degrees');
  });

  it.each([
    ['empty', ''],
    ['whitespace only', '   '],
    ['a tab', '\t'],
  ])('refuses an asset whose alt text is %s', (_label, altText) => {
    expect(expectError(createMediaAssetVersion(versionProps({ altText }), 'diagram')).code).toBe(
      'ALT_TEXT_REQUIRED',
    );
  });

  // The point of construction-time enforcement: there is no state in which an
  // asset exists without alt text and might be published under pressure.
  it('cannot produce an asset version lacking alt text under any asset type', () => {
    for (const assetType of ASSET_TYPES) {
      expect(expectError(createMediaAssetVersion(versionProps({ altText: '' }), assetType)).code).toBe(
        'ALT_TEXT_REQUIRED',
      );
    }
  });
});

describe('an information-bearing asset needs a long description', () => {
  it.each([...INFORMATION_BEARING_ASSET_TYPES])('requires one for a %s', (assetType) => {
    const props = versionProps();
    delete (props as { longDescription?: unknown }).longDescription;
    expect(expectError(createMediaAssetVersion(props, assetType)).code).toBe('LONG_DESCRIPTION_REQUIRED');
  });

  it('refuses a blank long description', () => {
    expect(
      expectError(createMediaAssetVersion(versionProps({ longDescription: '  ' }), 'chart')).code,
    ).toBe('LONG_DESCRIPTION_REQUIRED');
  });

  it('does not require one for a photograph', () => {
    const props = versionProps();
    delete (props as { longDescription?: unknown }).longDescription;
    expect(expectValue(createMediaAssetVersion(props, 'photograph')).altText).toBeDefined();
  });

  it('omits the key entirely when there is none', () => {
    const props = versionProps();
    delete (props as { longDescription?: unknown }).longDescription;
    const built = expectValue(createMediaAssetVersion(props, 'photograph'));
    expect(Object.hasOwn(built, 'longDescription')).toBe(false);
  });

  it('reports the accessible description a renderer emits', () => {
    expect(accessibleDescriptionOf(V1)).toEqual({
      altText: V1.altText,
      longDescription: V1.longDescription,
    });
  });

  it('reports alt text alone where there is no long description', () => {
    const props = versionProps();
    delete (props as { longDescription?: unknown }).longDescription;
    const photograph = expectValue(createMediaAssetVersion(props, 'photograph'));
    expect(accessibleDescriptionOf(photograph)).toEqual({ altText: photograph.altText });
  });
});

describe('format and dimensions', () => {
  it.each([...ALLOWED_MIME_TYPES])('accepts %s', (mimeType) => {
    expect(version({ mimeType }).mimeType).toBe(mimeType);
  });

  it.each([
    ['a document', 'application/pdf'],
    ['a video', 'video/mp4'],
    ['nothing recognisable', 'image/tiff'],
  ])('refuses %s, naming what is allowed', (_label, mimeType) => {
    const failure = expectError(createMediaAssetVersion(versionProps({ mimeType }), 'diagram'));
    expect(failure.code).toBe('MIME_TYPE_NOT_ALLOWED');
    expect(failure.message).toContain('image/png');
  });

  it.each([
    ['zero width', { width: 0 }],
    ['zero height', { height: 0 }],
    ['negative width', { width: -10 }],
    ['fractional height', { height: 12.5 }],
  ])('refuses %s', (_label, overrides) => {
    expect(expectError(createMediaAssetVersion(versionProps(overrides), 'diagram')).code).toBe(
      'DIMENSIONS_INVALID',
    );
  });

  it('accepts a one-pixel asset, which is small but not invalid', () => {
    expect(version({ width: 1, height: 1 }).width).toBe(1);
  });
});

describe('version construction', () => {
  it('rejects a blank version id', () => {
    expect(expectError(createMediaAssetVersion(versionProps({ versionId: ' ' }), 'diagram')).code).toBe(
      'VERSION_ID_REQUIRED',
    );
  });

  it.each([
    ['zero', 0],
    ['fractional', 1.5],
  ])('rejects a versionNo that is %s', (_label, versionNo) => {
    expect(expectError(createMediaAssetVersion(versionProps({ versionNo }), 'diagram')).code).toBe(
      'VERSION_NO_INVALID',
    );
  });

  it('requires an author (INV-02)', () => {
    expect(
      expectError(
        createMediaAssetVersion(versionProps({ authoredBy: { ...AUTHOR, id: '' } }), 'diagram'),
      ).code,
    ).toBe('AUTHORED_BY_REQUIRED');
  });

  it('rejects a malformed timestamp', () => {
    expect(expectError(createMediaAssetVersion(versionProps({ createdAt: 'today' }), 'diagram')).code).toBe(
      'CREATED_AT_NOT_A_TIMESTAMP',
    );
  });

  // FR-QM-06 rule 2 — assets carry licensing independent of the item.
  it('defaults licensing to unresolved', () => {
    const props = versionProps();
    delete (props as { licensing?: unknown }).licensing;
    expect(expectValue(createMediaAssetVersion(props, 'diagram')).licensing).toEqual({
      status: 'unresolved',
    });
  });

  it('propagates a licensing failure', () => {
    expect(
      expectError(createMediaAssetVersion(versionProps({ licensing: { status: 'licensed' } }), 'diagram')).code,
    ).toBe('LICENSE_REF_REQUIRED');
  });

  it('is frozen, including the author role context', () => {
    expect(Object.isFrozen(V1)).toBe(true);
    expect(Object.isFrozen(V1.authoredBy.roleContext)).toBe(true);
  });
});

describe('asset creation and reconstitution', () => {
  it('starts as a draft holding one version', () => {
    expect(draft()).toMatchObject({ lifecycleState: 'draft', aggregateVersion: 1 });
  });

  it('rejects a blank asset id', () => {
    expect(
      expectError(createMediaAsset({ assetId: ' ', assetType: 'diagram', initialVersion: V1 })).code,
    ).toBe('ASSET_ID_REQUIRED');
  });

  it('rejects an unknown asset type', () => {
    expect(
      expectError(
        createMediaAsset({ assetId: 'a', assetType: 'video' as never, initialVersion: V1 }),
      ).code,
    ).toBe('ASSET_TYPE_UNKNOWN');
  });

  it('rejects a first version that is not version 1', () => {
    expect(
      expectError(createMediaAsset({ assetId: 'a', assetType: 'diagram', initialVersion: V2 })).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('restores an asset in any state', () => {
    for (const state of LIFECYCLE_STATES) {
      expect(inState(state).lifecycleState).toBe(state);
    }
  });

  it('rejects a blank id on reconstitution', () => {
    expect(
      expectError(
        reconstituteMediaAsset({
          assetId: '',
          assetType: 'diagram',
          lifecycleState: 'draft',
          versions: [V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('ASSET_ID_REQUIRED');
  });

  it('rejects an empty version list', () => {
    expect(
      expectError(
        reconstituteMediaAsset({
          assetId: 'a',
          assetType: 'diagram',
          lifecycleState: 'draft',
          versions: [],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSIONS_REQUIRED');
  });

  it('rejects a duplicate version id', () => {
    expect(
      expectError(
        reconstituteMediaAsset({
          assetId: 'a',
          assetType: 'diagram',
          lifecycleState: 'draft',
          versions: [V1, V1],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_ID_DUPLICATE');
  });

  it('rejects a gap in the version numbers', () => {
    const third = version({ versionId: 'asset-version-3', versionNo: 3 });
    expect(
      expectError(
        reconstituteMediaAsset({
          assetId: 'a',
          assetType: 'diagram',
          lifecycleState: 'draft',
          versions: [V1, third],
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('rejects a published reference it does not hold', () => {
    expect(
      expectError(
        reconstituteMediaAsset({
          assetId: 'a',
          assetType: 'diagram',
          lifecycleState: 'published',
          versions: [V1],
          currentPublishedVersionId: 'elsewhere',
          aggregateVersion: 1,
        }),
      ).code,
    ).toBe('PUBLISHED_VERSION_UNKNOWN');
  });

  it.each([['published'], ['suspended']] as const)(
    'rejects a %s asset naming no published version',
    (lifecycleState) => {
      expect(
        expectError(
          reconstituteMediaAsset({
            assetId: 'a',
            assetType: 'diagram',
            lifecycleState,
            versions: [V1],
            aggregateVersion: 1,
          }),
        ).code,
      ).toBe('PUBLISHED_VERSION_REQUIRED');
    },
  );

  it('carries a retirement reason forward', () => {
    const retired = expectValue(
      reconstituteMediaAsset({
        assetId: 'a',
        assetType: 'diagram',
        lifecycleState: 'retired',
        versions: [V1],
        retirementReason: 'licence lapsed',
        aggregateVersion: 5,
      }),
    );
    expect(retired.retirementReason).toBe('licence lapsed');
  });

  it('omits absent optional keys', () => {
    const asset = inState('draft');
    expect(Object.hasOwn(asset, 'currentPublishedVersionId')).toBe(false);
    expect(Object.hasOwn(asset, 'retirementReason')).toBe(false);
  });
});

describe('replacement via versioning (FR-QM-06 rule 3)', () => {
  it('appends a version and bumps the aggregate version', () => {
    const updated = expectValue(addMediaAssetVersion(draft(), V2));
    expect(updated.versions).toHaveLength(2);
    expect(updated.aggregateVersion).toBe(2);
  });

  it('permits a new version while published, since replacement is how an asset changes', () => {
    expect(expectValue(addMediaAssetVersion(inState('published'), V2)).versions).toHaveLength(2);
  });

  it('refuses a new version on a retired asset', () => {
    expect(expectError(addMediaAssetVersion(inState('retired'), V2)).code).toBe('VERSION_NOT_EDITABLE');
  });

  it('refuses a duplicate version id as a Conflict', () => {
    const failure = expectError(addMediaAssetVersion(draft(), V1));
    expect(failure.code).toBe('VERSION_ID_DUPLICATE');
    expect(failure.kind).toBe('Conflict');
  });

  it('refuses a version number that skips ahead', () => {
    const third = version({ versionId: 'asset-version-3', versionNo: 3 });
    expect(expectError(addMediaAssetVersion(draft(), third)).code).toBe('VERSION_NUMBERS_NOT_CONTIGUOUS');
  });

  it('leaves the previously published version resolvable', () => {
    const updated = expectValue(addMediaAssetVersion(inState('published'), V2));
    expect(publishedMediaVersionOf(updated)?.versionId).toBe(V1.versionId);
  });

  it('reports the latest version in order and out of order', () => {
    expect(latestMediaVersionOf(expectValue(addMediaAssetVersion(draft(), V2))).versionNo).toBe(2);
    const outOfOrder = expectValue(
      reconstituteMediaAsset({
        assetId: 'a',
        assetType: 'diagram',
        lifecycleState: 'draft',
        versions: [V2, V1],
        aggregateVersion: 2,
      }),
    );
    expect(latestMediaVersionOf(outOfOrder).versionNo).toBe(2);
  });

  it('reports no published version before publication', () => {
    expect(publishedMediaVersionOf(draft())).toBeUndefined();
  });
});

describe('transitions and retirement', () => {
  it('uses the item lifecycle unchanged', () => {
    expect(expectValue(transitionMediaAsset(draft(), { transition: 'submit_for_review' })).lifecycleState).toBe(
      'in_review',
    );
  });

  it('refuses an illegal transition', () => {
    expect(expectError(transitionMediaAsset(draft(), { transition: 'publish' })).code).toBe(
      'TRANSITION_ILLEGAL',
    );
  });

  it('publishes a named version', () => {
    const published = expectValue(
      transitionMediaAsset(inState('approved'), { transition: 'publish', versionId: V1.versionId }),
    );
    expect(published.currentPublishedVersionId).toBe(V1.versionId);
  });

  it('refuses publication naming no version', () => {
    expect(expectError(transitionMediaAsset(inState('approved'), { transition: 'publish' })).code).toBe(
      'VERSION_NOT_FOUND',
    );
  });

  it('refuses publication naming a version it does not hold', () => {
    expect(
      expectError(
        transitionMediaAsset(inState('approved'), { transition: 'publish', versionId: 'elsewhere' }),
      ).code,
    ).toBe('VERSION_NOT_FOUND');
  });

  it('retires when nothing published references it', () => {
    const retired = expectValue(
      transitionMediaAsset(inState('published'), {
        transition: 'retire',
        retirementReason: 'superseded by a clearer figure',
        referencingPublishedContentCount: 0,
      }),
    );
    expect(retired.lifecycleState).toBe('retired');
  });

  // An in-use asset is replaced via versioning, never deleted.
  it('refuses while published content references it, naming the count', () => {
    const failure = expectError(
      transitionMediaAsset(inState('published'), {
        transition: 'retire',
        retirementReason: 'superseded',
        referencingPublishedContentCount: 7,
      }),
    );
    expect(failure.code).toBe('STILL_REFERENCED');
    expect(failure.kind).toBe('RuleViolation');
    expect(failure.message).toContain('7');
  });

  // Unknown is not zero; defaulting it would make the rule advisory.
  it('refuses when the reference count was never resolved', () => {
    expect(
      expectError(
        transitionMediaAsset(inState('published'), {
          transition: 'retire',
          retirementReason: 'superseded',
        }),
      ).code,
    ).toBe('STILL_REFERENCED');
  });

  it('requires a reason to retire', () => {
    expect(
      expectError(
        transitionMediaAsset(inState('published'), {
          transition: 'retire',
          referencingPublishedContentCount: 0,
        }),
      ).code,
    ).toBe('RETIREMENT_REASON_REQUIRED');
  });

  it('rejects a blank reason', () => {
    expect(
      expectError(
        transitionMediaAsset(inState('published'), {
          transition: 'retire',
          retirementReason: '  ',
          referencingPublishedContentCount: 0,
        }),
      ).code,
    ).toBe('RETIREMENT_REASON_REQUIRED');
  });

  it('retires from suspended too', () => {
    expect(
      expectValue(
        transitionMediaAsset(inState('suspended'), {
          transition: 'retire',
          retirementReason: 'replaced',
          referencingPublishedContentCount: 0,
        }),
      ).lifecycleState,
    ).toBe('retired');
  });
});

describe('immutability', () => {
  it('freezes the asset and its version list', () => {
    const asset = draft();
    expect(Object.isFrozen(asset)).toBe(true);
    expect(Object.isFrozen(asset.versions)).toBe(true);
  });

  it('leaves the original untouched when changed', () => {
    const original = draft();
    expectValue(addMediaAssetVersion(original, V2));
    expectValue(transitionMediaAsset(original, { transition: 'submit_for_review' }));
    expect(original.versions).toHaveLength(1);
    expect(original.lifecycleState).toBe('draft');
  });
});
