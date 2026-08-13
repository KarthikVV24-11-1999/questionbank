import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { err, ok, type Result } from '../domain/result.js';
import type { MediaAssetRepository, RepositoryError } from '../domain/repository-ports.js';
import {
  createMediaAsset,
  createMediaAssetVersion,
  reconstituteMediaAsset,
  type MediaAsset,
  type MediaAssetVersion,
} from '../domain/media-asset.js';
import type { AuthoredMediaVersion } from './commands/media-commands.js';
import {
  AddMediaAssetVersionHandler,
  RegisterMediaAssetHandler,
  RetireMediaAssetHandler,
  type MediaAuthoringDependencies,
} from './handlers/media-handlers.js';
import {
  InMemoryAuditRecorder,
  type ApplicationContext,
  type Clock,
  type IdentifierFactory,
  type MediaStore,
  type StoredObject,
} from './ports.js';

/**
 * The failure paths behind FR-QM-06: a rejected write, a reference count the
 * database will not produce, a broken identifier adapter. Each is a place a
 * handler reporting success would leave a figure registered against nothing,
 * or retire an asset published content is still showing.
 */

const author: PrincipalRef = {
  kind: 'human',
  id: '00000000-0000-4000-8700-000000000001',
  roleContext: ['author', 'subject:physics'],
};
const contentOps: PrincipalRef = {
  kind: 'human',
  id: '00000000-0000-4000-8700-000000000002',
  roleContext: ['content_ops'],
};
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };

let seed = 0;
const identifiers: IdentifierFactory = {
  next: () => {
    seed += 1;
    return `00000000-0000-4000-8800-${seed.toString(16).padStart(12, '0')}`;
  },
};

const STORAGE_KEY = 'content/media/ramp.png';

const STORED: StoredObject = Object.freeze({
  storageKey: STORAGE_KEY,
  checksum: 'sha256:abcd',
  contentType: 'image/png',
  byteLength: 8,
});

const store: MediaStore = {
  async put() {
    return STORED;
  },
  async head() {
    return STORED;
  },
};

const authored: AuthoredMediaVersion = Object.freeze<AuthoredMediaVersion>({
  storageKey: STORAGE_KEY,
  mimeType: 'image/png',
  width: 800,
  height: 600,
  altText: 'A block on a ramp inclined at thirty degrees',
  longDescription: 'The ramp rises left to right at 30°, with weight and normal-force arrows.',
  licensing: { status: 'owned' },
});

const rejected: RepositoryError = { kind: 'Conflict', code: 'CONFLICT', message: 'moved on' };
const missing: RepositoryError = { kind: 'NotFound', code: 'NOT_FOUND', message: 'gone' };

function assetVersion(): MediaAssetVersion {
  return expectValue(
    createMediaAssetVersion(
      {
        versionId: identifiers.next(),
        versionNo: 1,
        storageKey: STORAGE_KEY,
        checksum: STORED.checksum,
        mimeType: 'image/png',
        width: 800,
        height: 600,
        altText: authored.altText,
        longDescription: authored.longDescription as string,
        licensing: { status: 'owned' },
        authoredBy: author,
        createdAt: NOW.toISOString(),
      },
      'diagram',
    ),
  );
}

function draftAsset(): MediaAsset {
  return expectValue(
    createMediaAsset({ assetId: identifiers.next(), assetType: 'diagram', initialVersion: assetVersion() }),
  );
}

/** A published asset — the only state from which retirement is even legal. */
function publishedAsset(): MediaAsset {
  const version = assetVersion();
  return expectValue(
    reconstituteMediaAsset({
      assetId: identifiers.next(),
      assetType: 'diagram',
      lifecycleState: 'published',
      versions: [version],
      currentPublishedVersionId: version.versionId,
      aggregateVersion: 3,
    }),
  );
}

class StubAssets implements MediaAssetRepository {
  constructor(
    private readonly onFind: () => Result<MediaAsset, RepositoryError>,
    private readonly onSave: (asset: MediaAsset) => Result<MediaAsset, RepositoryError> = ok,
    private readonly onCount: () => Result<number, RepositoryError> = () => ok(0),
  ) {}
  async save(asset: MediaAsset) {
    return this.onSave(asset);
  }
  async findById() {
    return this.onFind();
  }
  async findPublishedVersion(): Promise<Result<MediaAssetVersion, RepositoryError>> {
    return err(missing);
  }
  async list(): Promise<Result<readonly MediaAsset[], RepositoryError>> {
    return ok([]);
  }
  async countReferencingPublishedContent() {
    return this.onCount();
  }
}

function deps(over: Partial<MediaAuthoringDependencies> = {}): MediaAuthoringDependencies {
  return {
    assets: new StubAssets(() => err(missing)),
    store,
    clock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    ...over,
  };
}

describe('registration fails closed', () => {
  it('refuses an asset the domain will not build', async () => {
    let call = 0;
    const bench = deps({ identifiers: { next: () => (call++ === 0 ? identifiers.next() : '   ') } });
    const refused = await new RegisterMediaAssetHandler(bench).handle(
      { assetType: 'diagram', subject: 'physics', version: authored },
      as(author),
    );
    expect(expectError(refused).code).toBe('ASSET_ID_REQUIRED');
  });

  it('reports a registration the repository refused, and writes no audit record', async () => {
    const audit = new InMemoryAuditRecorder();
    const bench = deps({ assets: new StubAssets(() => err(missing), () => err(rejected)), audit });
    const refused = await new RegisterMediaAssetHandler(bench).handle(
      { assetType: 'diagram', subject: 'physics', version: authored },
      as(author),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
    expect(audit.entries).toHaveLength(0);
  });
});

describe('adding a version fails closed', () => {
  it('refuses a subject the principal is not scoped to', async () => {
    const bench = deps({ assets: new StubAssets(() => ok(draftAsset())) });
    const refused = await new AddMediaAssetVersionHandler(bench).handle(
      { assetId: 'a', subject: 'chemistry', version: authored },
      as(author),
    );
    expect(expectError(refused).code).toBe('OUT_OF_SUBJECT_SCOPE');
  });

  it('refuses a version the domain will not build', async () => {
    const bench = deps({
      assets: new StubAssets(() => ok(draftAsset())),
      identifiers: { next: () => '   ' },
    });
    const refused = await new AddMediaAssetVersionHandler(bench).handle(
      { assetId: 'a', subject: 'physics', version: authored },
      as(author),
    );
    expect(expectError(refused).code).toBe('VERSION_ID_REQUIRED');
  });

  it('reports a version the repository refused', async () => {
    const bench = deps({ assets: new StubAssets(() => ok(draftAsset()), () => err(rejected)) });
    const refused = await new AddMediaAssetVersionHandler(bench).handle(
      { assetId: 'a', subject: 'physics', version: authored },
      as(author),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });
});

describe('retirement fails closed', () => {
  // Unknown is not zero. A count the database cannot produce must stop the
  // retirement, or FR-QM-06 rule 3 becomes advisory at exactly the moment it
  // matters.
  it('refuses retirement when the reference count cannot be resolved', async () => {
    const bench = deps({
      assets: new StubAssets(() => ok(publishedAsset()), ok, () => err(rejected)),
    });
    const refused = await new RetireMediaAssetHandler(bench).handle(
      { assetId: 'a', retirementReason: 'superseded' },
      as(contentOps),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('reports a retirement the repository refused', async () => {
    const bench = deps({ assets: new StubAssets(() => ok(publishedAsset()), () => err(rejected)) });
    const refused = await new RetireMediaAssetHandler(bench).handle(
      { assetId: 'a', retirementReason: 'superseded' },
      as(contentOps),
    );
    expect(expectError(refused).code).toBe('CONFLICT');
  });
});
