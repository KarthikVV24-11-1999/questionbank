import { describe, expect, it } from 'vitest';
import { err, ok } from '../../domain/result.js';
import { validationError } from '../../domain/content-error.js';
import type {
  PublishedCatalogueCriteria,
  PublishedCatalogueEntry,
  PublishedCatalogueReader,
} from '../../domain/repository-ports.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import {
  LIST_PUBLISHED_CATALOGUE_POLICY,
  ListPublishedCatalogueHandler,
  MAX_CATALOGUE_PAGE,
  toCatalogueEntryView,
} from './catalogue-queries.js';

const ENTRY: PublishedCatalogueEntry = {
  itemId: '00000000-0000-4000-8000-000000000001',
  itemVersionId: '00000000-0000-4000-8000-000000000002',
  versionNo: 3,
  itemType: 'SINGLE_CORRECT_MCQ',
  difficultyBand: 'moderate',
  subject: 'physics',
  taxonomyVersionId: '00000000-0000-4000-8000-000000000003',
  primaryConceptIdentityId: '00000000-0000-4000-8000-000000000004',
  conceptIdentityIds: ['00000000-0000-4000-8000-000000000004', '00000000-0000-4000-8000-000000000005'],
  stimulusVersionId: '00000000-0000-4000-8000-000000000006',
};

class RecordingReader implements PublishedCatalogueReader {
  readonly seen: PublishedCatalogueCriteria[] = [];
  constructor(private readonly page: { entries: PublishedCatalogueEntry[]; nextCursor?: string } | 'fails' = { entries: [ENTRY] }) {}

  async list(criteria: PublishedCatalogueCriteria) {
    this.seen.push(criteria);
    return this.page === 'fails' ? err(validationError('PERSISTENCE_REJECTED', 'no', 'catalogue')) : ok(this.page);
  }
}

const as = (role: string) => ({
  principal: { kind: 'human' as const, id: '00000000-0000-4000-8000-0000000000aa', roleContext: [role] },
  correlationId: 'c',
});

describe('who may enumerate the catalogue', () => {
  it('admits content ops and the system, and nobody else — not a learner, not a guest, not an author', async () => {
    expect([...LIST_PUBLISHED_CATALOGUE_POLICY.allowedRoles].sort()).toEqual(['content_ops', 'system']);
    const handler = new ListPublishedCatalogueHandler({ catalogue: new RecordingReader() });
    for (const role of ['content_ops', 'system']) expect((await handler.handle({}, as(role))).ok, role).toBe(true);
    for (const role of ['learner', 'guest', 'author', 'reviewer', 'generation_pipeline']) {
      expect(expectError(await handler.handle({}, as(role))).kind, role).toBe('Authorization');
    }
  });
});

describe('the view', () => {
  it('carries exactly the selection-relevant facts, field by field', () => {
    const view = toCatalogueEntryView(ENTRY);
    expect(view.itemId).toBe(ENTRY.itemId);
    expect(view.itemVersionId).toBe(ENTRY.itemVersionId);
    expect(view.versionNo).toBe(3);
    expect(view.itemType).toBe('SINGLE_CORRECT_MCQ');
    expect(view.difficultyBand).toBe('moderate');
    expect(view.subject).toBe('physics');
    expect(view.taxonomyVersionId).toBe(ENTRY.taxonomyVersionId);
    expect(view.primaryConceptIdentityId).toBe(ENTRY.primaryConceptIdentityId);
    expect(view.conceptIdentityIds).toEqual(ENTRY.conceptIdentityIds);
    expect(view.stimulusVersionId).toBe(ENTRY.stimulusVersionId);
    expect(Object.keys(view).sort()).toEqual([
      'conceptIdentityIds', 'difficultyBand', 'itemId', 'itemType', 'itemVersionId', 'primaryConceptIdentityId',
      'stimulusVersionId', 'subject', 'taxonomyVersionId', 'versionNo',
    ]);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.conceptIdentityIds)).toBe(true);
  });

  it('omits the stimulus when the item has none, rather than carrying an undefined', () => {
    const { stimulusVersionId: _omitted, ...bare } = ENTRY;
    expect('stimulusVersionId' in toCatalogueEntryView(bare)).toBe(false);
  });

  it('does not copy a field the source gains: a stray key never crosses', () => {
    const carrying = { ...ENTRY, correctOptionId: 'b', marks: 4 } as PublishedCatalogueEntry;
    expect(Object.keys(toCatalogueEntryView(carrying))).not.toContain('correctOptionId');
    expect(Object.keys(toCatalogueEntryView(carrying))).not.toContain('marks');
  });
});

describe('the query', () => {
  it('passes only what it was given to the reader, with the default page size', async () => {
    const reader = new RecordingReader();
    const handler = new ListPublishedCatalogueHandler({ catalogue: reader });
    await handler.handle({}, as('system'));
    expect(reader.seen[0]).toEqual({ limit: 100 });
    await handler.handle(
      { subject: 'physics', itemTypes: ['NUMERIC'], difficultyBands: ['advanced'], conceptIdentityIds: [ENTRY.primaryConceptIdentityId], cursor: ENTRY.itemId, limit: 7 },
      as('system'),
    );
    expect(reader.seen[1]).toEqual({
      subject: 'physics',
      itemTypes: ['NUMERIC'],
      difficultyBands: ['advanced'],
      conceptIdentityIds: [ENTRY.primaryConceptIdentityId],
      cursor: ENTRY.itemId,
      limit: 7,
    });
  });

  it('hands back the entries as views and the cursor when there is one', async () => {
    const handler = new ListPublishedCatalogueHandler({ catalogue: new RecordingReader({ entries: [ENTRY], nextCursor: ENTRY.itemId }) });
    const page = expectValue(await handler.handle({}, as('system')));
    expect(page.entries).toHaveLength(1);
    expect(page.nextCursor).toBe(ENTRY.itemId);
    expect(Object.isFrozen(page)).toBe(true);
    const last = expectValue(await new ListPublishedCatalogueHandler({ catalogue: new RecordingReader() }).handle({}, as('system')));
    expect('nextCursor' in last).toBe(false);
  });

  it('refuses a malformed query before touching the store', async () => {
    const reader = new RecordingReader();
    const handler = new ListPublishedCatalogueHandler({ catalogue: reader });
    for (const query of [
      { limit: 0 },
      { limit: MAX_CATALOGUE_PAGE + 1 },
      { limit: 1.5 },
      { itemTypes: ['ESSAY' as 'NUMERIC'] },
      { difficultyBands: ['impossible' as 'advanced'] },
    ]) {
      const failure = expectError(await handler.handle(query, as('system')));
      expect(failure.code, JSON.stringify(query)).toBe('CATALOGUE_QUERY_INVALID');
    }
    expect(reader.seen).toEqual([]);
  });

  it('passes the store\'s failure through unchanged in kind and code', async () => {
    const failure = expectError(await new ListPublishedCatalogueHandler({ catalogue: new RecordingReader('fails') }).handle({}, as('system')));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
  });
});
