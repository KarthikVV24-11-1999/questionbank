import { describe, expect, it } from 'vitest';
import type { GetTaxonomyVersion, TaxonomyVersionDetailView } from '../../curriculum/public/index.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { contextFor, principalWith } from '../../../testing/generation-context.js';
import { err, ok } from '../domain/result.js';
import { applicationError } from '../application/authorization.js';
import { CurriculumSyllabusReader } from './curriculum-syllabus-reader.js';

const VIEW: TaxonomyVersionDetailView = {
  taxonomyVersionId: 'v-1',
  examFamily: 'JEE',
  academicYear: '2026',
  state: 'published',
  publishedAt: '2026-08-05T08:00:00.000Z',
  nodeCount: 2,
  prerequisiteCount: 0,
  aggregateVersion: 2,
  nodes: [
    { conceptNodeId: 'n-1', conceptIdentityId: 'c-1', parentNodeId: null, displayName: 'Physics', examWeight: 1, depth: 0, estimatedTeachingHours: 300 },
    { conceptNodeId: 'n-2', conceptIdentityId: 'c-2', parentNodeId: 'n-1', displayName: 'Kinematics', examWeight: 0.2, depth: 1, estimatedTeachingHours: 20 },
  ],
};
const context = contextFor(principalWith(['content_ops']));

describe('the curriculum syllabus reader', () => {
  it('runs curriculum’s query under the caller’s own context and reduces the view to what the check needs', async () => {
    const calls: { query: GetTaxonomyVersion; context: unknown }[] = [];
    const reader = new CurriculumSyllabusReader({ handle: async (query, ctx) => (calls.push({ query, context: ctx }), ok(VIEW)) });

    const version = expectValue(await reader.read('v-1', context));

    expect(calls).toEqual([{ query: { taxonomyVersionId: 'v-1' }, context }]);
    expect(version.taxonomyVersionId).toBe('v-1');
    expect(version.state).toBe('published');
    expect(version.concepts).toEqual([
      { conceptIdentityId: 'c-1', displayName: 'Physics' },
      { conceptIdentityId: 'c-2', displayName: 'Kinematics' },
    ]);
    expect(Object.keys(version).sort()).toEqual(['concepts', 'state', 'taxonomyVersionId']);
  });

  it('returns curriculum’s refusal unchanged', async () => {
    const refusal = applicationError('Authorization', 'NOT_PERMITTED', 'no');
    const reader = new CurriculumSyllabusReader({ handle: async () => err(refusal) });
    expect(expectError(await reader.read('v-1', context))).toBe(refusal);
  });
});
