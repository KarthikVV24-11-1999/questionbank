import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@questionbank/contracts/client';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createLearningApi, createProfileApi } from './learning-api.js';
import { conceptPaceSchema, examChoicesSchema, examChoiceSchema, learnerProfileSchema, onboardingStateSchema, profileScopeSchema, scopeOptionsSchema, diagnosticReportSchema, escalationFindingSchema, paceAnalyticsSchema, remediationSchema, reportedFindingSchema, reviewPlanSchema, scheduledConceptSchema, slotPaceSchema } from './learning-schemas.js';
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
    ['ExamChoice', examChoiceSchema],
    ['ProfileScope', profileScopeSchema],
    ['OnboardingState', onboardingStateSchema],
    ['LearnerProfile', learnerProfileSchema],
    ['ExamChoices', examChoicesSchema],
    ['ScopeOptions', scopeOptionsSchema],
  ];

  it.each(held)('%s: every field the server requires is one the client reads, and the client reads no other', (name, schema) => {
    expect([...(doc.components.schemas[name]!.required ?? [])].sort()).toEqual(keysOf(schema));
  });
});

describe('the learner app\'s onboarding calls (M8-22)', () => {
  const profile = { exam: null, currentClass: null, priorScore: null, scope: null, version: 1, onboarding: { steps: [{ step: 'exam', state: 'pending' }], next: 'exam', skipped: false } };

  function sent(respond: unknown) {
    const calls: Array<{ url: string; method: string; body: unknown }> = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body === undefined ? undefined : JSON.parse(String(init.body)) });
      return new Response(JSON.stringify(respond), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof fetch;
    return { api: createProfileApi(createClient({ baseUrl: 'http://api.test', getToken: () => 'tok', fetchImpl, correlationId: () => 'corr' })), calls };
  }

  it('reads the profile, changes it with a PATCH of exactly what changed, skips with a POST, and reads the two lists', async () => {
    const { api, calls } = sent(profile);
    await api.getProfile();
    await api.updateProfile({ currentClass: 'class_12', priorScore: null });
    await api.skipOnboarding();
    expect(calls).toEqual([
      { url: 'http://api.test/v1/learning/profile', method: 'GET', body: undefined },
      { url: 'http://api.test/v1/learning/profile', method: 'PATCH', body: { currentClass: 'class_12', priorScore: null } },
      { url: 'http://api.test/v1/learning/profile/skip', method: 'POST', body: undefined },
    ]);
    expect(await sent({ exams: [{ examCode: 'A', displayName: 'A', years: ['2027'] }] }).api.examChoices()).toEqual({ exams: [{ examCode: 'A', displayName: 'A', years: ['2027'] }] });
    const options = { taxonomyVersionId: 't', nodes: [], conceptTotal: 1, selected: [] };
    const scoped = sent(options);
    expect(await scoped.api.scopeOptions()).toEqual(options);
    expect(scoped.calls[0]!.url).toBe('http://api.test/v1/learning/profile/scope-options');
  });

  it('refuses a profile that is not the shape it reads', async () => {
    await expect(sent({ ...profile, onboarding: { next: 'payment', skipped: false, steps: [] } }).api.getProfile()).rejects.toThrow('schema validation');
  });
});
