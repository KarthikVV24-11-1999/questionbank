import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { expectError } from '../../../testing/expect-result.js';
import { err, ok, type Result } from '../domain/result.js';
import type {
  ItemRepository,
  MediaAssetRepository,
  RepositoryError,
  SolutionRepository,
} from '../domain/repository-ports.js';
import type { Item } from '../domain/item.js';
import type { ItemVersion } from '../domain/item-version.js';
import type { MediaAsset, MediaAssetVersion } from '../domain/media-asset.js';
import type { SolutionVersion } from '../domain/solution.js';
import {
  ListMediaAssetsHandler,
  ListMyDraftsHandler,
  type AuthoringQueryDependencies,
} from './queries/authoring-queries.js';
import type { ApplicationContext, Clock, RenderValidator } from './ports.js';

/**
 * The read paths fail closed too. A list that swallowed a repository error and
 * returned `[]` would tell an author their drafts are gone.
 */

const AUTHOR_ID = '00000000-0000-4000-8d00-000000000001';
const author: PrincipalRef = { kind: 'human', id: AUTHOR_ID, roleContext: ['author'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });

const rejected: RepositoryError = { kind: 'Conflict', code: 'CONFLICT', message: 'unavailable' };
const missing: RepositoryError = { kind: 'NotFound', code: 'NOT_FOUND', message: 'gone' };

class StubItems implements ItemRepository {
  async save(item: Item) {
    return ok(item);
  }
  async findById(): Promise<Result<Item, RepositoryError>> {
    return err(missing);
  }
  async deleteDraft(): Promise<Result<true, RepositoryError>> {
    return ok(true);
  }
  async findDraftsByAuthor(): Promise<Result<readonly Item[], RepositoryError>> {
    return err(rejected);
  }
  async findPublishedVersion(): Promise<Result<ItemVersion, RepositoryError>> {
    return err(missing);
  }
  async countPublishedItemsUsingStimulusVersion(): Promise<Result<number, RepositoryError>> {
    return ok(0);
  }
}

class StubAssets implements MediaAssetRepository {
  async save(asset: MediaAsset) {
    return ok(asset);
  }
  async findById(): Promise<Result<MediaAsset, RepositoryError>> {
    return err(missing);
  }
  async findPublishedVersion(): Promise<Result<MediaAssetVersion, RepositoryError>> {
    return err(missing);
  }
  async list(): Promise<Result<readonly MediaAsset[], RepositoryError>> {
    return err(rejected);
  }
  async countReferencingPublishedContent(): Promise<Result<number, RepositoryError>> {
    return ok(0);
  }
}

class StubSolutions implements SolutionRepository {
  async save(solution: never) {
    return ok(solution);
  }
  async findById(): Promise<Result<never, RepositoryError>> {
    return err(missing);
  }
  async findPublishedForItemVersion(): Promise<Result<SolutionVersion, RepositoryError>> {
    return err(missing);
  }
}

const renderer: RenderValidator = {
  async validate(version: ItemVersion) {
    return { itemVersionId: version.versionId, surfacesChecked: [], failures: [] };
  },
};

const clock: Clock = { now: () => new Date('2026-08-11T09:00:00.000Z') };

const deps: AuthoringQueryDependencies = {
  items: new StubItems(),
  solutions: new StubSolutions() as unknown as SolutionRepository,
  assets: new StubAssets(),
  renderer,
  clock,
};

describe('a read the repository will not answer is reported, not emptied', () => {
  it('on listing drafts', async () => {
    const refused = await new ListMyDraftsHandler(deps).handle({ authorId: AUTHOR_ID }, as(author));
    expect(expectError(refused).code).toBe('CONFLICT');
  });

  it('on listing media assets', async () => {
    const refused = await new ListMediaAssetsHandler(deps).handle({}, as(author));
    expect(expectError(refused).code).toBe('CONFLICT');
  });
});
