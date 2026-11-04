import { describe, expect, it } from 'vitest';
import { diagnosticRunBody, practiceRunBody } from './practice-request.js';

describe('the request that starts a practice run about concepts', () => {
  it('is a filtered selection scoped to the concepts, under the profile, of the size asked, and nothing else', () => {
    expect(practiceRunBody({ examProfileVersionId: 'p', conceptIdentityIds: ['c1', 'c2'], count: 7 })).toEqual({
      examProfileVersionId: 'p',
      selectionStrategy: 'filtered',
      scopeFilter: { conceptIdentityIds: ['c1', 'c2'] },
      count: 7,
    });
  });

  it('copies the concepts, so a later change to the caller\'s list does not reach a request already built', () => {
    const concepts = ['c1'];
    const body = practiceRunBody({ examProfileVersionId: 'p', conceptIdentityIds: concepts, count: 1 });
    concepts.push('c2');
    expect(body.scopeFilter.conceptIdentityIds).toEqual(['c1']);
  });
});

describe('the request that starts the diagnostic', () => {
  it('is the breadth strategy under the profile, of the size asked, naming no concept, and nothing else', () => {
    expect(diagnosticRunBody({ examProfileVersionId: 'p', count: 10 })).toEqual({ examProfileVersionId: 'p', selectionStrategy: 'breadth', count: 10 });
  });
});
