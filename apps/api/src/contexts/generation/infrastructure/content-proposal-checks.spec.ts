import { describe, expect, it } from 'vitest';
import type { DuplicateCandidatesResult, ValidationReport } from '../../content/public/index.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { contextFor, principalWith } from '../../../testing/generation-context.js';
import { err, ok } from '../domain/result.js';
import { applicationError } from '../application/authorization.js';
import { ContentProposalChecker } from './content-proposal-checks.js';

const REPORT: ValidationReport = { findings: [], blocking: [], warnings: [], maySubmit: true, duplicateCheckState: 'not_evaluated' };
const DUPLICATES: DuplicateCandidatesResult = { state: 'evaluated', exactMatches: [], skeletonMatches: [], trigramMatches: [], asOf: '2026-10-16T09:30:00.000Z' };
const context = contextFor(principalWith(['generation_pipeline'], 'system'));

describe('the production ContentProposalChecks', () => {
  it('hands content’s validator what it was asked, and returns its report as it is', () => {
    const seen: unknown[] = [];
    const checker = new ContentProposalChecker({ validate: (content, facts) => (seen.push([content, facts]), REPORT), duplicates: { handle: async () => ok(DUPLICATES) } });
    const content = { marker: 'content' } as never;
    expect(checker.validate(content, { asOf: '2026-10-16T09:30:00.000Z' })).toBe(REPORT);
    expect(seen).toEqual([[content, { asOf: '2026-10-16T09:30:00.000Z' }]]);
  });

  it('runs content’s duplicate query under the caller’s own context and returns its result', async () => {
    const seen: unknown[] = [];
    const checker = new ContentProposalChecker({ validate: () => REPORT, duplicates: { handle: async (query, ctx) => (seen.push([query, ctx]), ok(DUPLICATES)) } });
    const query = { subject: 'physics', content: {} as never };
    expect(expectValue(await checker.duplicates(query, context))).toBe(DUPLICATES);
    expect(seen).toEqual([[query, context]]);
  });

  it('returns content’s refusal unchanged', async () => {
    const refusal = applicationError('Authorization', 'NOT_PERMITTED', 'no');
    const checker = new ContentProposalChecker({ validate: () => REPORT, duplicates: { handle: async () => err(refusal) } });
    expect(expectError(await checker.duplicates({ subject: 'physics', content: {} as never }, context))).toBe(refusal);
  });
});
