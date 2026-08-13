import type { PrincipalRef } from '@questionbank/domain-types';
import { describe, expect, it } from 'vitest';
import { expectError } from '../../../testing/expect-result.js';
import { singleCorrectSpec, textBody } from '../../../testing/content-fixtures.js';
import { err, ok, type Result } from '../domain/result.js';
import type { ItemRepository, RepositoryError } from '../domain/repository-ports.js';
import type { Item } from '../domain/item.js';
import type { ItemVersion } from '../domain/item-version.js';
import { ImportItemBatchHandler, type ImportDependencies } from './handlers/import-handlers.js';
import type { ImportBatchHeader, ImportItemRecord } from './import/import-batch.js';
import { InMemoryAuditRecorder, type ApplicationContext, type Clock, type IdentifierFactory } from './ports.js';

/**
 * Import's failure paths. A broken identifier adapter must stop a record, not
 * produce a half-item — an import that writes anything it cannot name is an
 * import nobody can re-run.
 */

const contentOps: PrincipalRef = {
  kind: 'human',
  id: '00000000-0000-4000-8e00-000000000001',
  roleContext: ['content_ops'],
};
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });

let seed = 0;
const nextId = (): string => {
  seed += 1;
  return `00000000-0000-4000-8f00-${seed.toString(16).padStart(12, '0')}`;
};

const header: ImportBatchHeader = {
  kind: 'batch_header',
  batchId: '00000000-0000-4000-8e00-000000000009',
  source: 'JEE Main 2019 Paper 1',
  subject: 'physics',
  licensing: { status: 'owned' },
};

const record: ImportItemRecord = {
  kind: 'item',
  recordId: 'src-1',
  itemType: 'SINGLE_CORRECT_MCQ',
  stem: textBody('A block slides down a frictionless ramp.'),
  responseSpec: singleCorrectSpec(),
  taxonomyTags: [
    {
      conceptIdentityId: '00000000-0000-4000-8e00-00000000000a',
      taxonomyVersionId: '00000000-0000-4000-8e00-00000000000b',
      weight: 1,
      isPrimary: true,
    },
  ],
  difficultyEstimate: 'moderate',
  sourceYear: 2019,
};

const contents = [header, record].map((line) => JSON.stringify(line)).join('\n');

class StubItems implements ItemRepository {
  async save(item: Item) {
    return ok(item);
  }
  async findById(): Promise<Result<Item, RepositoryError>> {
    return err({ kind: 'NotFound', code: 'NOT_FOUND', message: 'gone' });
  }
  async deleteDraft(): Promise<Result<true, RepositoryError>> {
    return ok(true);
  }
  async findDraftsByAuthor(): Promise<Result<readonly Item[], RepositoryError>> {
    return ok([]);
  }
  async findPublishedVersion(): Promise<Result<ItemVersion, RepositoryError>> {
    return err({ kind: 'NotFound', code: 'NOT_FOUND', message: 'gone' });
  }
  async countPublishedItemsUsingStimulusVersion(): Promise<Result<number, RepositoryError>> {
    return ok(0);
  }
}

const clock: Clock = { now: () => new Date('2026-08-11T09:00:00.000Z') };

function deps(identifiers: IdentifierFactory): ImportDependencies {
  return { items: new StubItems(), clock, identifiers, audit: new InMemoryAuditRecorder() };
}

describe('a record the handler cannot name is rejected, not half-written', () => {
  it('reports the item identifier as the reason', async () => {
    let call = 0;
    const identifiers: IdentifierFactory = { next: () => (call++ === 0 ? nextId() : '   ') };
    const report = await new ImportItemBatchHandler(deps(identifiers)).handle({ contents }, as(contentOps));

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.rejected[0]).toMatchObject({ recordId: 'src-1', code: 'ITEM_ID_REQUIRED' });
    expect(report.value.imported).toHaveLength(0);
  });

  it('reports the version identifier as the reason', async () => {
    const identifiers: IdentifierFactory = { next: () => '   ' };
    const report = await new ImportItemBatchHandler(deps(identifiers)).handle({ contents }, as(contentOps));

    expect(report.ok).toBe(true);
    if (!report.ok) return;
    expect(report.value.rejected[0]!.code).toBe('VERSION_ID_REQUIRED');
  });

  it('still refuses a principal without the role, before parsing anything', async () => {
    const refused = await new ImportItemBatchHandler(deps({ next: nextId })).handle(
      { contents: 'not even a batch' },
      as({ kind: 'human', id: nextId(), roleContext: ['learner'] }),
    );
    expect(expectError(refused).code).toBe('NOT_PERMITTED');
  });
});
