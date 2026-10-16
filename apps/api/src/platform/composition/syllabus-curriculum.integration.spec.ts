import { randomUUID } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { GetTaxonomyVersionQuery } from '../../contexts/curriculum/application/queries/curriculum-queries.js';
import { DrizzleTaxonomyVersionRepository } from '../../contexts/curriculum/infrastructure/taxonomy-version.repository.js';
import { syllabusScopeCheck } from '../../contexts/generation/application/prechecks/syllabus-check.js';
import { CurriculumSyllabusReader } from '../../contexts/generation/infrastructure/curriculum-syllabus-reader.js';
import { RecordedProvider } from '../../contexts/generation/infrastructure/provider/recorded-provider.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { expectError, expectValue } from '../../testing/expect-result.js';
import { aTaxonomy } from '../../testing/published-taxonomy.js';
import { contextFor, principalWith } from '../../testing/generation-context.js';
import { aCandidate, aRun, versionId } from '../../testing/generation-fixtures.js';

/**
 * Check 5 against curriculum's own vocabulary, through its barrel: the real
 * `GetTaxonomyVersion` handler over real Postgres, a real published taxonomy,
 * and the real recorded classifier. Nothing here is a tag list generation holds.
 *
 * Lives in the composition tree because it is the one place both contexts may be
 * named together.
 */
const RECORDINGS = resolve(dirname(fileURLToPath(import.meta.url)), '../../contexts/generation/infrastructure/provider/recordings');
const BODY = (JSON.parse(readFileSync(join(RECORDINGS, 'kinematics-ramp.json'), 'utf8')) as { response: { body: Record<string, unknown> } }).response.body;
const TAG = (BODY['taxonomyTags'] as { conceptIdentityId: string; taxonomyVersionId: string }[])[0]!;

const CONFIG = { modelVersionId: versionId('model', 5), promptVersionId: versionId('prompt', 25) };

let database: TestDatabase;
let versions: DrizzleTaxonomyVersionRepository;
let reader: CurriculumSyllabusReader;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  versions = new DrizzleTaxonomyVersionRepository(database.db);
  reader = new CurriculumSyllabusReader(
    new GetTaxonomyVersionQuery({ versions, exams: {} as never, profiles: {} as never, migrations: {} as never }),
  );
  await aTaxonomy(database, { versionId: TAG.taxonomyVersionId, conceptIdentityId: TAG.conceptIdentityId, displayName: 'Kinematics', publish: true });
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const check = () => syllabusScopeCheck({ syllabus: reader, judge: RecordedProvider.fromDirectory(RECORDINGS), config: CONFIG });
const candidate = (body: Record<string, unknown> = BODY) => aCandidate(aRun({ promptVersionId: versionId('prompt', 7) }), { body });
const asCurator = contextFor(principalWith(['content_ops']));
const asPipeline = contextFor(principalWith(['generation_pipeline'], 'system'));

describe('check 5 against curriculum’s real taxonomy', () => {
  it('passes a proposal tagged with a concept in a published version, when curriculum lets the caller read it', async () => {
    const outcome = expectValue(await check().run(candidate(), asCurator));
    expect(outcome.outcome).toBe('pass');
    expect(outcome.detail).toContain('Kinematics');
  });

  it('fails a proposal tagged with a concept that is not in the version', async () => {
    const stranger = randomUUID();
    const outcome = expectValue(await check().run(candidate({ ...BODY, taxonomyTags: [{ ...TAG, conceptIdentityId: stranger }] }), asCurator));
    expect(outcome).toEqual({ outcome: 'fail', detail: `concept ${stranger} is not in taxonomy version ${TAG.taxonomyVersionId}` });
  });

  it('fails a proposal tagged against a version that is only a draft', async () => {
    const draftVersion = randomUUID();
    const draftConcept = randomUUID();
    await aTaxonomy(database, { versionId: draftVersion, conceptIdentityId: draftConcept, displayName: 'Draft', publish: false });
    const outcome = expectValue(await check().run(candidate({ ...BODY, taxonomyTags: [{ conceptIdentityId: draftConcept, taxonomyVersionId: draftVersion }] }), asCurator));
    expect(outcome.outcome).toBe('fail');
    expect(outcome.detail).toBe(`taxonomy version ${draftVersion} is draft, not published`);
  });

  it('fails a proposal tagged against a version curriculum has never heard of', async () => {
    const ghost = randomUUID();
    const outcome = expectValue(await check().run(candidate({ ...BODY, taxonomyTags: [{ conceptIdentityId: TAG.conceptIdentityId, taxonomyVersionId: ghost }] }), asCurator));
    expect(outcome.detail).toBe(`taxonomy version ${ghost} does not exist`);
  });

  // The finding. Curriculum decides who may read, and its read policy admits
  // learners, curators, Content Ops and exam owners — not the generation
  // pipeline. Under the pipeline's own principal the check cannot run, and says
  // so rather than guessing.
  it('could not run under the pipeline’s own principal: curriculum’s read policy does not admit it', async () => {
    const failure = expectError(await check().run(candidate(), asPipeline));
    expect(failure.kind).toBe('Authorization');
    expect(failure.code).toBe('NOT_PERMITTED');
    expect(failure.message).toContain('GetTaxonomyVersion');
  });
});
