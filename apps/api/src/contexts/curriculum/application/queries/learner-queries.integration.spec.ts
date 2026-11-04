import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ROLES } from '../../../../platform/auth/roles.js';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { seedPublishedSyllabus, type PublishedSyllabus } from '../../../../testing/published-syllabus.js';
import { curriculumForLearning } from '../../public/composition.js';

let database: TestDatabase;
let syllabus: PublishedSyllabus;
const system = { principal: { kind: 'system' as const, id: randomUUID(), roleContext: [ROLES.system] }, correlationId: 'c' };
const learner = { principal: { kind: 'human' as const, id: randomUUID(), roleContext: [ROLES.learner] }, correlationId: 'c' };
const seam = () => curriculumForLearning({ pool: database.pool, clock: { now: () => new Date('2026-11-04T09:00:00.000Z') }, identifiers: { next: () => randomUUID() }, audit: { record: async () => undefined }, principals: { resolve: () => null } });

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});
afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});
// published rows cannot be deleted, so each test has an exam of its own
const freshCode = (): string => `EXAM_${randomUUID().slice(0, 8).toUpperCase()}`;
beforeEach(async () => {
  syllabus = await seedPublishedSyllabus(database, { examCode: freshCode() });
});

describe('what Learning may ask of Curriculum is the system\'s alone (M8-19)', () => {
  it('refuses a learner every one of the four, so a learner reaches them through Learning and no other way', async () => {
    const { examOptions, resolveExam, scopeNodes, resolveScope } = seam();
    const taxonomyVersionId = syllabus.taxonomyVersionId;
    expect(await examOptions.handle({}, learner)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
    expect(await resolveExam.handle({ examCode: syllabus.examCode, academicYear: '2027' }, learner)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
    expect(await scopeNodes.handle({ taxonomyVersionId }, learner)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
    expect(await resolveScope.handle({ taxonomyVersionId, nodeIds: [] }, learner)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
  });

  it('refuses a learner the naming of concepts as well', async () => {
    expect(await seam().nameConcepts.handle({ taxonomyVersionId: syllabus.taxonomyVersionId, conceptIdentityIds: [syllabus.concepts.physics] }, learner)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
  });
});

describe('the exams a learner may choose', () => {
  it('lists an exam with the years it has a profile active for', async () => {
    const options = await seam().examOptions.handle({}, system);
    expect(options.ok && options.value.find((option) => option.examCode === syllabus.examCode)).toEqual({ examCode: syllabus.examCode, displayName: syllabus.examCode, years: ['2027'] });
  });

  it('leaves out an exam with no profile active for any year, and lists the rest in order of their codes', async () => {
    const bare = `AAA_${randomUUID().slice(0, 6).toUpperCase()}`;
    const { Exam } = await import('../../domain/exam.js');
    const { DrizzleExamRepository } = await import('../../infrastructure/exam.repository.js');
    const made = Exam.create({ examId: randomUUID(), code: bare, displayName: 'No year', jurisdiction: 'IN', conductingBody: 'NTA' });
    if (!made.ok) throw new Error('exam');
    await new DrizzleExamRepository(database.db).insert(made.value);
    const options = await seam().examOptions.handle({}, system);
    const codes = options.ok ? options.value.map((option) => option.examCode) : [];
    expect(codes).not.toContain(bare);
    expect(codes).toEqual([...codes].sort());
  });
});

describe('resolving an exam and a year (INV-04)', () => {
  it('gives the profile version active for the year and the taxonomy version it is built on', async () => {
    expect(await seam().resolveExam.handle({ examCode: syllabus.examCode, academicYear: '2027' }, system)).toEqual({
      ok: true,
      value: { examCode: syllabus.examCode, academicYear: '2027', profileVersionId: syllabus.profileVersionId, taxonomyVersionId: syllabus.taxonomyVersionId },
    });
  });

  it('names an exam that does not exist and a year with no profile, and guesses neither', async () => {
    expect(await seam().resolveExam.handle({ examCode: 'GATE', academicYear: '2027' }, system)).toMatchObject({ ok: false, error: { kind: 'NotFound', code: 'EXAM_NOT_FOUND' } });
    expect(await seam().resolveExam.handle({ examCode: syllabus.examCode, academicYear: '2031' }, system)).toMatchObject({ ok: false, error: { kind: 'NotFound', code: 'NO_PROFILE_FOR_YEAR' } });
  });

  it('will not build a learner on a profile that is only a draft: a draft is never active for a year', async () => {
    const draft = await seedPublishedSyllabus(database, { examCode: freshCode(), publishTaxonomy: false });
    expect(await seam().resolveExam.handle({ examCode: draft.examCode, academicYear: draft.academicYear }, system)).toMatchObject({ ok: false, error: { code: 'NO_PROFILE_FOR_YEAR' } });
  });
});

describe('the chapters a learner picks from', () => {
  it('lists the nodes of a published taxonomy version with their parents and depths, shallowest first, and how many concepts there are', async () => {
    const answered = await seam().scopeNodes.handle({ taxonomyVersionId: syllabus.taxonomyVersionId }, system);
    expect(answered.ok && answered.value).toEqual({
      taxonomyVersionId: syllabus.taxonomyVersionId,
      conceptTotal: 4,
      nodes: [
        { nodeId: syllabus.nodes.physics, parentNodeId: null, displayName: 'Physics', depth: 0 },
        { nodeId: syllabus.nodes.mechanics, parentNodeId: syllabus.nodes.physics, displayName: 'Mechanics', depth: 1 },
        { nodeId: syllabus.nodes.optics, parentNodeId: syllabus.nodes.physics, displayName: 'Optics', depth: 1 },
        { nodeId: syllabus.nodes.kinematics, parentNodeId: syllabus.nodes.mechanics, displayName: 'Kinematics', depth: 2 },
      ],
    });
  });

  it('refuses a taxonomy version that is not published, and one that does not exist', async () => {
    const draft = await seedPublishedSyllabus(database, { examCode: freshCode(), publishTaxonomy: false });
    expect(await seam().scopeNodes.handle({ taxonomyVersionId: draft.taxonomyVersionId }, system)).toMatchObject({ ok: false, error: { code: 'TAXONOMY_NOT_IN_FORCE' } });
    expect(await seam().scopeNodes.handle({ taxonomyVersionId: randomUUID() }, system)).toMatchObject({ ok: false, error: { kind: 'NotFound' } });
  });
});

describe('the concepts a pick stands for', () => {
  const resolve = (nodeIds: string[]) => seam().resolveScope.handle({ taxonomyVersionId: syllabus.taxonomyVersionId, nodeIds }, system);

  it('is the chapter and everything under it, once each', async () => {
    const answered = await resolve([syllabus.nodes.mechanics]);
    expect(answered.ok && [...answered.value.conceptIdentityIds].sort()).toEqual([syllabus.concepts.mechanics, syllabus.concepts.kinematics].sort());
    expect(answered.ok && answered.value.conceptTotal).toBe(4);
  });

  it('counts a concept once when a chapter and a topic under it are both picked, and when a node is picked twice', async () => {
    const answered = await resolve([syllabus.nodes.mechanics, syllabus.nodes.kinematics, syllabus.nodes.mechanics]);
    expect(answered.ok && answered.value.conceptIdentityIds).toHaveLength(2);
  });

  it('is the whole syllabus for the subject node', async () => {
    const answered = await resolve([syllabus.nodes.physics]);
    expect(answered.ok && answered.value.conceptIdentityIds).toHaveLength(4);
  });

  it('is all or nothing: a node the version does not have fails the whole read and is named, and nothing is returned', async () => {
    const stray = randomUUID();
    const answered = await resolve([syllabus.nodes.optics, stray]);
    expect(answered).toMatchObject({ ok: false, error: { kind: 'NotFound', code: 'SCOPE_NODES_UNKNOWN' } });
    expect(!answered.ok && answered.error.message).toContain(stray);
    expect(!answered.ok && answered.error.message).not.toContain(syllabus.nodes.optics);
  });
});

describe('what a concept is called, and where it sits (M8-27)', () => {
  const name = (conceptIdentityIds: string[], taxonomyVersionId = syllabus.taxonomyVersionId) => seam().nameConcepts.handle({ taxonomyVersionId, conceptIdentityIds }, system);

  it('gives each concept its name and the names above it, outermost first, in the order asked', async () => {
    const answered = await name([syllabus.concepts.kinematics, syllabus.concepts.physics, syllabus.concepts.optics]);
    expect(answered.ok && answered.value).toEqual([
      { conceptIdentityId: syllabus.concepts.kinematics, name: 'Kinematics', path: ['Physics', 'Mechanics'] },
      { conceptIdentityId: syllabus.concepts.physics, name: 'Physics', path: [] },
      { conceptIdentityId: syllabus.concepts.optics, name: 'Optics', path: ['Physics'] },
    ]);
  });

  it('names a concept once however many times it is asked for', async () => {
    const answered = await name([syllabus.concepts.optics, syllabus.concepts.optics]);
    expect(answered.ok && answered.value).toHaveLength(1);
  });

  it('answers an empty ask with nothing', async () => {
    expect(await name([])).toEqual({ ok: true, value: [] });
  });

  it('is all or nothing: a concept the version does not have fails the whole read and is named, and nothing is returned', async () => {
    const stray = randomUUID();
    const answered = await name([syllabus.concepts.optics, stray]);
    expect(answered).toMatchObject({ ok: false, error: { kind: 'NotFound', code: 'CONCEPTS_UNKNOWN' } });
    expect(!answered.ok && answered.error.message).toContain(stray);
    expect(!answered.ok && answered.error.message).not.toContain(syllabus.concepts.optics);
  });

  it('refuses a taxonomy version that is not published, and one that does not exist', async () => {
    const draft = await seedPublishedSyllabus(database, { examCode: freshCode(), publishTaxonomy: false });
    expect(await name([draft.concepts.physics], draft.taxonomyVersionId)).toMatchObject({ ok: false, error: { code: 'TAXONOMY_NOT_IN_FORCE' } });
    expect(await name([syllabus.concepts.physics], randomUUID())).toMatchObject({ ok: false, error: { kind: 'NotFound' } });
  });

  it('takes the bound the seam advertises and not one identifier more', async () => {
    const offered = seam();
    const stray = (count: number): string[] => Array.from({ length: count }, () => randomUUID());
    expect(offered.batchBound).toBe(200);
    // within the bound the ask is judged on its contents: these are not in the version, which is a different refusal from being too many
    expect(await offered.nameConcepts.handle({ taxonomyVersionId: syllabus.taxonomyVersionId, conceptIdentityIds: stray(offered.batchBound) }, system)).toMatchObject({ ok: false, error: { code: 'CONCEPTS_UNKNOWN' } });
    expect(await offered.nameConcepts.handle({ taxonomyVersionId: syllabus.taxonomyVersionId, conceptIdentityIds: stray(offered.batchBound + 1) }, system)).toMatchObject({ ok: false, error: { kind: 'Validation', code: 'CONCEPT_BATCH_TOO_LARGE' } });
  });
});
