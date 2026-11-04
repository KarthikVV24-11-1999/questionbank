import { describe, expect, it } from 'vitest';
import type { CurriculumForLearning } from '../../contexts/curriculum/public/composition.js';
import { CurriculumLearnerSource } from './learning-curriculum.js';

type Answer = { ok: true; value: unknown } | { ok: false; error: { kind: string; code: string; message: string } };

/** A seam whose four reads answer what the test says, and remember who asked and what. */
function seam(answers: Partial<Record<'examOptions' | 'resolveExam' | 'scopeNodes' | 'resolveScope', Answer>>) {
  const asked: Array<{ read: string; query: unknown; principal: unknown; correlationId: string }> = [];
  const read = (name: keyof typeof answers) => ({
    handle: async (query: unknown, context: { principal: unknown; correlationId: string }) => {
      asked.push({ read: name, query, principal: context.principal, correlationId: context.correlationId });
      return answers[name] ?? { ok: false, error: { kind: 'NotFound', code: 'X', message: 'none' } };
    },
  });
  return { asked, source: new CurriculumLearnerSource({ examOptions: read('examOptions'), resolveExam: read('resolveExam'), scopeNodes: read('scopeNodes'), resolveScope: read('resolveScope') } as unknown as CurriculumForLearning) };
}
const context = { correlationId: 'corr-1' };

describe('Learning\'s port for Curriculum is filled from the seam, and asks as the system (M8-19)', () => {
  it('gives the exams and their years in Learning\'s words', async () => {
    const { source, asked } = seam({ examOptions: { ok: true, value: [{ examCode: 'JEE_MAIN', displayName: 'JEE Main', years: ['2027'] }] } });
    expect(await source.examOptions(context)).toEqual({ ok: true, value: [{ examCode: 'JEE_MAIN', displayName: 'JEE Main', years: ['2027'] }] });
    expect(asked[0]).toMatchObject({ read: 'examOptions', correlationId: 'corr-1', principal: { kind: 'system', roleContext: ['system'] } });
  });

  it('resolves an exam and a year to the versions, naming them as the profile keeps them', async () => {
    const { source, asked } = seam({ resolveExam: { ok: true, value: { examCode: 'JEE_MAIN', academicYear: '2027', profileVersionId: 'p-1', taxonomyVersionId: 't-1' } } });
    expect(await source.resolveExam('JEE_MAIN', '2027', context)).toEqual({ ok: true, value: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p-1', taxonomyVersionId: 't-1' } });
    expect(asked[0]!.query).toEqual({ examCode: 'JEE_MAIN', academicYear: '2027' });
  });

  it('gives the chapters of a taxonomy version and how many concepts it has', async () => {
    const { source, asked } = seam({ scopeNodes: { ok: true, value: { taxonomyVersionId: 't-1', conceptTotal: 4, nodes: [{ nodeId: 'n1', parentNodeId: null, displayName: 'Physics', depth: 0 }] } } });
    expect(await source.scopeOptions('t-1', context)).toEqual({ ok: true, value: { taxonomyVersionId: 't-1', conceptTotal: 4, nodes: [{ nodeId: 'n1', parentNodeId: null, displayName: 'Physics', depth: 0 }] } });
    expect(asked[0]!.query).toEqual({ taxonomyVersionId: 't-1' });
  });

  it('resolves the chapters picked to the concepts they stand for', async () => {
    const { source, asked } = seam({ resolveScope: { ok: true, value: { conceptIdentityIds: ['c1', 'c2'], conceptTotal: 4 } } });
    expect(await source.resolveScope('t-1', ['n1', 'n2'], context)).toEqual({ ok: true, value: { conceptIdentityIds: ['c1', 'c2'], conceptTotal: 4 } });
    expect(asked[0]!.query).toEqual({ taxonomyVersionId: 't-1', nodeIds: ['n1', 'n2'] });
  });

  it('passes on what Curriculum could not find, naming it, for every one of the four reads', async () => {
    const missing: Answer = { ok: false, error: { kind: 'NotFound', code: 'SCOPE_NODES_UNKNOWN', message: 'no node n9' } };
    const { source } = seam({ examOptions: missing, resolveExam: missing, scopeNodes: missing, resolveScope: missing });
    const expected = { ok: false, error: { kind: 'NotFound', code: 'SCOPE_NODES_UNKNOWN', message: 'no node n9' } };
    expect(await source.examOptions(context)).toEqual(expected);
    expect(await source.resolveExam('X', '2027', context)).toEqual(expected);
    expect(await source.scopeOptions('t', context)).toEqual(expected);
    expect(await source.resolveScope('t', ['n9'], context)).toEqual(expected);
  });

  it('says only that curriculum could not be read for anything else, and leaks nothing of Curriculum\'s own words', async () => {
    const broken: Answer = { ok: false, error: { kind: 'Authorization', code: 'NOT_PERMITTED', message: 'principal 123 may not run ListExamOptions' } };
    const { source } = seam({ examOptions: broken, resolveExam: broken, scopeNodes: broken, resolveScope: broken });
    for (const result of [await source.examOptions(context), await source.resolveExam('X', '2027', context), await source.scopeOptions('t', context), await source.resolveScope('t', [], context)]) {
      expect(result).toEqual({ ok: false, error: { kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE', message: 'curriculum could not be read: NOT_PERMITTED' } });
    }
  });
});

describe('naming concepts pages at the bound the seam advertises, and is all or nothing across the pages (M8-27, DEC-M7-28)', () => {
  type Page = { readonly taxonomyVersionId: string; readonly conceptIdentityIds: readonly string[] };
  /** A seam that names every concept it is asked for after the id, takes `bound` at a time, and can fail on the nth page. */
  function naming(bound: number, failOnPage?: number) {
    const pages: Page[] = [];
    const nameConcepts = {
      handle: async (query: Page) => {
        pages.push(query);
        if (failOnPage === pages.length) return { ok: false as const, error: { kind: 'NotFound', code: 'CONCEPTS_UNKNOWN', message: 'no concept c7' } };
        return { ok: true as const, value: query.conceptIdentityIds.map((id) => ({ conceptIdentityId: id, name: `name of ${id}`, path: ['Physics'] })) };
      },
    };
    return { pages, source: new CurriculumLearnerSource({ nameConcepts, batchBound: bound } as unknown as CurriculumForLearning) };
  }

  it('asks in pages of at most the bound, and gives the names in the order asked', async () => {
    const { source, pages } = naming(3);
    const answered = await source.conceptNames('t-1', ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7'], context);
    expect(pages.map((page) => page.conceptIdentityIds)).toEqual([['c1', 'c2', 'c3'], ['c4', 'c5', 'c6'], ['c7']]);
    expect(answered.ok && answered.value.map((concept) => concept.conceptIdentityId)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
    expect(answered.ok && answered.value[0]).toEqual({ conceptIdentityId: 'c1', name: 'name of c1', path: ['Physics'] });
  });

  it('asks for a concept once, and not at all when there is none', async () => {
    const { source, pages } = naming(3);
    const answered = await source.conceptNames('t-1', ['c1', 'c1', 'c2'], context);
    expect(pages.map((page) => page.conceptIdentityIds)).toEqual([['c1', 'c2']]);
    expect(answered.ok && answered.value).toHaveLength(2);
    expect(await source.conceptNames('t-1', [], context)).toEqual({ ok: true, value: [] });
    expect(pages).toHaveLength(1);
  });

  it('fails the whole read when a later page fails, and returns none of the earlier names', async () => {
    const { source } = naming(2, 2);
    expect(await source.conceptNames('t-1', ['c1', 'c2', 'c3'], context)).toEqual({ ok: false, error: { kind: 'NotFound', code: 'CONCEPTS_UNKNOWN', message: 'no concept c7' } });
  });

  it('asks as the system, for the version it was given', async () => {
    const asked: unknown[] = [];
    const nameConcepts = { handle: async (query: unknown, ctx: { principal: unknown }) => (asked.push({ query, principal: ctx.principal }), { ok: true as const, value: [] }) };
    await new CurriculumLearnerSource({ nameConcepts, batchBound: 5 } as unknown as CurriculumForLearning).conceptNames('t-9', ['c1'], context);
    expect(asked[0]).toMatchObject({ query: { taxonomyVersionId: 't-9' }, principal: { kind: 'system', roleContext: ['system'] } });
  });
});
