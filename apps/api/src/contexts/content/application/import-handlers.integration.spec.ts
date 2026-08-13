import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { itemOption, singleCorrectSpec, textBody } from '../../../testing/content-fixtures.js';
import type { Result } from '../domain/result.js';
import type { ApplicationError } from './authorization.js';
import { PostgresItemRepository } from '../infrastructure/item.repository.js';
import {
  describeImportDuplicateCheck,
  parseImportBatch,
  type ImportBatchHeader,
  type ImportItemRecord,
} from './import/import-batch.js';
import { ImportItemBatchHandler, type ImportDependencies } from './handlers/import-handlers.js';
import { InMemoryAuditRecorder, type ApplicationContext, type Clock, type IdentifierFactory } from './ports.js';

/**
 * FR-TCH-11 and FR-QM-10 against a real database. The criteria that carry the
 * task are that one bad record never fails a batch, that every imported record
 * lands in `draft`, and that the report names what failed precisely enough to
 * fix it.
 */

let database: TestDatabase;
let items: PostgresItemRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-b200-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const OPS_ID = freshUuid();
const CONCEPT_ID = freshUuid();
const TAXONOMY_ID = freshUuid();

const contentOps: PrincipalRef = { kind: 'human', id: OPS_ID, roleContext: ['content_ops'] };
const physicsAuthor: PrincipalRef = {
  kind: 'human',
  id: freshUuid(),
  roleContext: ['author', 'subject:physics'],
};
const chemistryAuthor: PrincipalRef = {
  kind: 'human',
  id: freshUuid(),
  roleContext: ['author', 'subject:chemistry'],
};

const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'c' });
type Refusal = Result<unknown, ApplicationError>;

const NOW = new Date('2026-08-11T09:00:00.000Z');
const clock: Clock = { now: () => NOW };
const identifiers: IdentifierFactory = { next: () => freshUuid() };

function bench(): ImportDependencies & { readonly audit: InMemoryAuditRecorder } {
  return { items, clock, identifiers, audit: new InMemoryAuditRecorder() };
}

function header(overrides: Partial<ImportBatchHeader> = {}): ImportBatchHeader {
  return {
    kind: 'batch_header',
    batchId: freshUuid(),
    source: 'JEE Main 2019 Paper 1',
    subject: 'physics',
    licensing: { status: 'owned' },
    ...overrides,
  };
}

function itemRecord(overrides: Partial<ImportItemRecord> = {}): ImportItemRecord {
  return {
    kind: 'item',
    recordId: `src-${uuidSeed}`,
    itemType: 'SINGLE_CORRECT_MCQ',
    stem: textBody('A block slides down a frictionless ramp. What is its acceleration?'),
    responseSpec: singleCorrectSpec(),
    taxonomyTags: [
      { conceptIdentityId: CONCEPT_ID, taxonomyVersionId: TAXONOMY_ID, weight: 1, isPrimary: true },
    ],
    difficultyEstimate: 'moderate',
    sourceYear: 2019,
    ...overrides,
  };
}

function batch(lines: readonly unknown[], batchHeader: ImportBatchHeader = header()): string {
  return [batchHeader, ...lines].map((line) => JSON.stringify(line)).join('\n');
}

describe('the batch header', () => {
  it('refuses a batch that declares no licensing (FR-QM-10 rule 2)', async () => {
    const { licensing: _dropped, ...withoutLicensing } = header();
    const refused = await new ImportItemBatchHandler(bench()).handle(
      { contents: batch([itemRecord()], withoutLicensing as ImportBatchHeader) },
      as(contentOps),
    );
    const error = expectError(refused);
    expect(error.code).toBe('LICENSING_UNDECLARED');
    expect(error.location).toBe('batch.header.licensing');
  });

  it('refuses a batch whose first line is not a header', async () => {
    const contents = [itemRecord(), itemRecord()].map((line) => JSON.stringify(line)).join('\n');
    expect(expectError(parseImportBatch(contents)).code).toBe('HEADER_MISSING');
  });

  it('refuses a batch whose first line is not JSON at all', () => {
    expect(expectError(parseImportBatch('not json\n{}')).code).toBe('HEADER_NOT_JSON');
  });

  it('refuses an empty batch', () => {
    expect(expectError(parseImportBatch('   \n\n')).code).toBe('BATCH_EMPTY');
  });

  it.each([
    ['batchId', 'BATCH_ID_MISSING'],
    ['source', 'SOURCE_MISSING'],
    ['subject', 'SUBJECT_MISSING'],
  ] as const)('refuses a header with no %s', (field, code) => {
    const incomplete = { ...header(), [field]: '   ' };
    expect(expectError(parseImportBatch(JSON.stringify(incomplete))).code).toBe(code);
  });

  it('refuses a header whose licensing is not an object', () => {
    expect(
      expectError(parseImportBatch(JSON.stringify({ ...header(), licensing: 'owned' }))).code,
    ).toBe('LICENSING_UNDECLARED');
  });

  // FR-QM-10's actors include Author, so the scope check is the one that has
  // to hold: a Chemistry author holds the role and still may not import a
  // Physics corpus (FR-TCH-01 rule 1).
  it('refuses a batch outside the principal’s subject scope', async () => {
    const refused = await new ImportItemBatchHandler(bench()).handle(
      { contents: batch([itemRecord()], header({ subject: 'physics' })) },
      as(chemistryAuthor),
    );
    expect(expectError(refused).code).toBe('OUT_OF_SUBJECT_SCOPE');
  });

  it('permits an author importing inside their own subject', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord()], header({ subject: 'physics' })) },
        as(physicsAuthor),
      ),
    );
    expect(report.imported).toHaveLength(1);
  });
});

describe('a mixed batch imports the valid and reports the invalid', () => {
  it('does not let one bad record fail the batch', async () => {
    const good = itemRecord({ recordId: 'good-1' });
    const alsoGood = itemRecord({ recordId: 'good-2' });
    const noTags = itemRecord({ recordId: 'bad-tags', taxonomyTags: [] });

    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([good, noTags, alsoGood]) },
        as(contentOps),
      ),
    );

    expect(report.totalRecords).toBe(3);
    expect(report.imported.map((entry) => entry.recordId)).toEqual(['good-1', 'good-2']);
    expect(report.rejected.map((entry) => entry.recordId)).toEqual(['bad-tags']);

    // The records before *and after* the failure are both there — the batch is
    // transactional per record, not per file.
    for (const entry of report.imported) {
      const stored = expectValue(await items.findById(entry.itemId));
      expect(stored.lifecycleState).toBe('draft');
    }
  });

  it('names the line, the record, the code and the location of each rejection', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord({ recordId: 'bad', taxonomyTags: [] })]) },
        as(contentOps),
      ),
    );

    expect(report.rejected[0]).toMatchObject({
      lineNumber: 2,
      recordId: 'bad',
      code: 'TAGS_REQUIRED',
    });
    expect(report.rejected[0]!.location).toContain('taxonomyTags');
  });

  it('reports a line that is not JSON without reading the rest of the file differently', async () => {
    const contents = [
      JSON.stringify(header()),
      '{ this is not json',
      JSON.stringify(itemRecord({ recordId: 'after-the-garbage' })),
    ].join('\n');

    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle({ contents }, as(contentOps)),
    );
    expect(report.rejected[0]).toMatchObject({ lineNumber: 2, code: 'RECORD_NOT_JSON' });
    expect(report.imported.map((entry) => entry.recordId)).toEqual(['after-the-garbage']);
  });

  it('reports a record of an unknown kind, a record with no id, and a record missing fields', async () => {
    const contents = [
      JSON.stringify(header()),
      JSON.stringify({ kind: 'stimulus', recordId: 'wrong-kind' }),
      JSON.stringify({ kind: 'stimulus' }),
      JSON.stringify({ kind: 'item' }),
      JSON.stringify({ kind: 'item', recordId: 'sparse' }),
    ].join('\n');

    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle({ contents }, as(contentOps)),
    );
    expect(report.rejected.map((entry) => entry.code)).toEqual([
      'RECORD_KIND_UNKNOWN',
      'RECORD_KIND_UNKNOWN',
      'RECORD_ID_MISSING',
      'RECORD_FIELD_MISSING',
    ]);
    // A record of an unknown kind may not even name itself.
    expect(report.rejected[1]!.recordId).toBe('');
    expect(report.rejected[3]!.message).toContain('itemType');
    // A line that never parsed has no location inside it to point at.
    expect(report.rejected[0]!.location).toBeUndefined();
  });

  it.each([
    ['a duplicate option id', { responseSpec: singleCorrectSpec({ options: [itemOption('a', 1), itemOption('a', 2)] }) }, 'OPTION_ID_DUPLICATE'],
    ['an unknown item type', { itemType: 'ESSAY' as never }, 'ITEM_TYPE_MISMATCH'],
    ['a correct option nobody defined', { responseSpec: singleCorrectSpec({ correctOptionId: 'z' }) }, 'CORRECT_OPTION_UNKNOWN'],
    ['a difficulty band outside the vocabulary', { difficultyEstimate: 'impossible' as never }, 'DIFFICULTY_BAND_UNKNOWN'],
  ])('rejects %s with the domain’s own code', async (_name, overrides, code) => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord({ recordId: 'bad', ...overrides })]) },
        as(contentOps),
      ),
    );
    expect(report.rejected[0]!.code).toBe(code);
    expect(report.imported).toHaveLength(0);
  });

  it('rejects a record whose own licensing is incomplete rather than inheriting past it', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        {
          contents: batch([
            itemRecord({ recordId: 'bad-licence', licensing: { status: 'licensed' } }),
          ]),
        },
        as(contentOps),
      ),
    );
    expect(report.rejected[0]!.code).toBe('LICENSE_REF_REQUIRED');
  });
});

describe('governance is not bypassed (FR-TCH-11 rule 1)', () => {
  it('lands every imported record in draft', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord(), itemRecord(), itemRecord()]) },
        as(contentOps),
      ),
    );

    expect(report.imported).toHaveLength(3);
    for (const entry of report.imported) {
      const stored = expectValue(await items.findById(entry.itemId));
      expect(stored.lifecycleState).toBe('draft');
      expect(stored.currentPublishedVersionId).toBeUndefined();
      expect(stored.versions).toHaveLength(1);
    }
  });

  // The state is not checked; it is unreachable. `createItem` starts at draft
  // and this handler calls no transition at all.
  it('has no transition to call — asserted over the handler’s own source', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('./handlers/import-handlers.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toMatch(/\btransitionItem\b|\bpublishVersion\b/u);
  });

  it('carries provenance naming the batch and the source (rule 3)', async () => {
    const batchHeader = header({ source: 'NEET 2021 Paper' });
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord({ sourceYear: 2021 })], batchHeader) },
        as(contentOps),
      ),
    );

    const stored = expectValue(await items.findById(report.imported[0]!.itemId));
    expect(stored.versions[0]!.provenance).toMatchObject({
      sourceType: 'previous_year',
      sourceExam: 'NEET 2021 Paper',
      sourceYear: 2021,
      importBatchId: batchHeader.batchId,
    });
  });

  it('inherits the batch licensing where a record states none', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        {
          contents: batch(
            [itemRecord()],
            header({ licensing: { status: 'licensed', licenseRef: 'NTA-2019', attribution: 'NTA' } }),
          ),
        },
        as(contentOps),
      ),
    );

    const stored = expectValue(await items.findById(report.imported[0]!.itemId));
    expect(stored.versions[0]!.licensing).toMatchObject({
      status: 'licensed',
      licenseRef: 'NTA-2019',
      attribution: 'NTA',
    });
  });

  it('lets a record override the batch declaration', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord({ licensing: { status: 'public_domain' } })]) },
        as(contentOps),
      ),
    );
    const stored = expectValue(await items.findById(report.imported[0]!.itemId));
    expect(stored.versions[0]!.licensing.status).toBe('public_domain');
  });
});

describe('the duplicate check the report does not claim to have run (DEC-7)', () => {
  it('reports deferred, and says so in words', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord()]) },
        as(contentOps),
      ),
    );
    expect(report.duplicateCheckState).toBe('deferred');
    expect(describeImportDuplicateCheck()).toContain('has not run');
    // The wording matters as much as the flag: a report saying "no duplicates
    // found" when the check never ran is a claim a reviewer acts on.
    expect(describeImportDuplicateCheck()).not.toMatch(/none|no duplicates/iu);
  });
});

describe('the import is audited and gated', () => {
  it('writes one audit record naming the batch and the outcome', async () => {
    const deps = bench();
    const batchHeader = header();
    const report = expectValue(
      await new ImportItemBatchHandler(deps).handle(
        { contents: batch([itemRecord(), itemRecord({ recordId: 'bad', taxonomyTags: [] })], batchHeader) },
        as(contentOps),
      ),
    );

    expect(deps.audit.entriesFor(batchHeader.batchId)).toHaveLength(1);
    expect(deps.audit.entries[0]!.justification).toBe(
      `${report.imported.length} imported, ${report.rejected.length} rejected from ${batchHeader.source}`,
    );
  });

  it('refuses a principal holding no authoring role', async () => {
    const refusals: readonly Refusal[] = [
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord()]) },
        as({ kind: 'human', id: freshUuid(), roleContext: ['learner'] }),
      ),
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord()]) },
        as({ kind: 'human', id: freshUuid(), roleContext: ['reviewer'] }),
      ),
    ];
    for (const refused of refusals) {
      expect(expectError(refused).code).toBe('NOT_PERMITTED');
    }
  });
});

describe('a record the database refuses is reported, not lost silently', () => {
  it('rejects a record whose tag identifiers are not storable', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        {
          contents: batch([
            itemRecord({
              recordId: 'unstorable',
              taxonomyTags: [
                { conceptIdentityId: 'not-a-uuid', taxonomyVersionId: 'also-not', weight: 1, isPrimary: true },
              ],
            }),
            itemRecord({ recordId: 'fine' }),
          ]),
        },
        as(contentOps),
      ),
    );

    expect(report.rejected[0]).toMatchObject({ recordId: 'unstorable', code: 'PERSISTENCE_REJECTED' });
    // And the record after it still landed.
    expect(report.imported.map((entry) => entry.recordId)).toEqual(['fine']);
  });
});

describe('the shapes a record may or may not carry', () => {
  // The path exists to migrate previous-year corpora, so a record that does
  // not name its year is rejected rather than imported with the year missing —
  // an item nobody can attribute to a paper is one nobody can defend.
  it('rejects a record that does not name its source year', async () => {
    const { sourceYear: _dropped, ...bare } = itemRecord({ recordId: 'bare' });
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle({ contents: batch([bare]) }, as(contentOps)),
    );
    expect(report.imported).toHaveLength(0);
    expect(report.rejected[0]).toMatchObject({ recordId: 'bare', code: 'SOURCE_YEAR_REQUIRED' });
  });

  it('imports a record with a year and no session', async () => {
    const { sourceSession: _none, ...withoutSession } = itemRecord({ recordId: 'no-session' });
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([withoutSession]) },
        as(contentOps),
      ),
    );
    const stored = expectValue(await items.findById(report.imported[0]!.itemId));
    expect(stored.versions[0]!.provenance).not.toHaveProperty('sourceSession');
  });

  it('carries a session and an exam the record states for itself', async () => {
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        {
          contents: batch([
            itemRecord({ recordId: 'sessioned', sourceExam: 'JEE Advanced', sourceSession: 'Shift 2' }),
          ]),
        },
        as(contentOps),
      ),
    );
    const stored = expectValue(await items.findById(report.imported[0]!.itemId));
    expect(stored.versions[0]!.provenance).toMatchObject({
      sourceExam: 'JEE Advanced',
      sourceSession: 'Shift 2',
    });
  });

  it('pins a stimulus version a record names', async () => {
    const stimulusVersionId = freshUuid();
    await database.pool.query(
      `INSERT INTO content.stimulus (stimulus_id, stimulus_type) VALUES ($1, 'passage')`,
      [stimulusVersionId],
    );
    await database.pool.query(
      `INSERT INTO content.stimulus_version
         (stimulus_version_id, stimulus_id, version_no, body, body_plain_text,
          authored_by_kind, authored_by_id)
       VALUES ($1, $1, 1, '{"schemaVersion":1,"blocks":[]}'::jsonb, 'a passage', 'human', $2)`,
      [stimulusVersionId, OPS_ID],
    );

    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle(
        { contents: batch([itemRecord({ recordId: 'linked', stimulusVersionRef: stimulusVersionId })]) },
        as(contentOps),
      ),
    );
    const stored = expectValue(await items.findById(report.imported[0]!.itemId));
    expect(stored.versions[0]!.stimulusVersionRef).toBe(stimulusVersionId);
  });

  it('reports a line that parses as JSON but is not an object', async () => {
    const contents = [JSON.stringify(header()), '[1, 2, 3]'].join('\n');
    const report = expectValue(
      await new ImportItemBatchHandler(bench()).handle({ contents }, as(contentOps)),
    );
    expect(report.rejected[0]).toMatchObject({ code: 'RECORD_NOT_JSON' });
  });
});
