import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@questionbank/contracts/client';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createLearningApi } from './learning-api.js';
import { conceptPaceSchema, diagnosticReportSchema, escalationFindingSchema, paceAnalyticsSchema, remediationSchema, reportedFindingSchema, reviewPlanSchema, scheduledConceptSchema, slotPaceSchema } from './learning-schemas.js';
import { concept, pace, plan, report, TAXONOMY } from '../testing/learning-fixtures.js';

function rig(respond: (url: string) => unknown) {
  const urls: string[] = [];
  const fetchImpl = (async (url: string) => {
    urls.push(url);
    return new Response(JSON.stringify(respond(url)), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as unknown as typeof fetch;
  return { api: createLearningApi(createClient({ baseUrl: 'http://api.test', getToken: () => 'tok', fetchImpl, correlationId: () => 'corr' })), urls };
}

describe('the learner app\'s reads of Learning', () => {
  it('reads the review plan, the report and the pace from the routes that give them, and the learner is named in none', async () => {
    const { api, urls } = rig((url) => (url.endsWith('/review-plan') ? plan() : url.endsWith('/report') ? report() : pace()));
    expect(await api.getReviewPlan()).toEqual(plan());
    expect(await api.getReport('a/b')).toEqual(report());
    expect(await api.getPace('a/b')).toEqual(pace());
    expect(urls).toEqual(['http://api.test/v1/learning/review-plan', 'http://api.test/v1/learning/attempts/a%2Fb/report', 'http://api.test/v1/learning/attempts/a%2Fb/pace']);
  });

  it('asks for the weakest concepts of a taxonomy and hands on the ids in the order given', async () => {
    const { api, urls } = rig(() => ({ conceptIdentityIds: [concept(2), concept(1)] }));
    expect(await api.suggestRemediation(TAXONOMY)).toEqual([concept(2), concept(1)]);
    expect(urls).toEqual([`http://api.test/v1/learning/remediation-concepts?taxonomyVersionId=${TAXONOMY}`]);
  });

  it('refuses a reply that is not the shape it reads, rather than show a guess', async () => {
    const { api } = rig(() => ({ asOf: 'x' }));
    await expect(api.getReviewPlan()).rejects.toThrow('schema validation');
  });
});

describe('the mirrored schemas are held to the document', () => {
  const doc = parse(readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '../../../../packages/contracts/openapi/learning.yaml'), 'utf8')) as {
    components: { schemas: Record<string, { required?: string[]; properties: Record<string, unknown> }> };
  };
  const keysOf = (schema: { shape: Record<string, unknown> }) => Object.keys(schema.shape).sort();
  const held: [string, { shape: Record<string, unknown> }][] = [
    ['Remediation', remediationSchema],
    ['ReportedFinding', reportedFindingSchema],
    ['DiagnosticReport', diagnosticReportSchema],
    ['SlotPace', slotPaceSchema],
    ['ConceptPace', conceptPaceSchema],
    ['PaceAnalytics', paceAnalyticsSchema],
    ['ScheduledConcept', scheduledConceptSchema],
    ['EscalationFinding', escalationFindingSchema],
    ['ReviewPlan', reviewPlanSchema],
  ];

  it.each(held)('%s: every field the server requires is one the client reads, and the client reads no other', (name, schema) => {
    expect([...(doc.components.schemas[name]!.required ?? [])].sort()).toEqual(keysOf(schema));
  });
});
