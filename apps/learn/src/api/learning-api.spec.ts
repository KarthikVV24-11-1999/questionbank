import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@questionbank/contracts/client';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { createLearningApi, createProfileApi, NAMES_PER_REQUEST } from './learning-api.js';
import { conceptEvidenceSchema, conceptMapSchema, conceptNamesSchema, mappedConceptSchema, namedConceptSchema, conceptPaceSchema, examChoicesSchema, examChoiceSchema, learnerProfileSchema, onboardingStateSchema, profileScopeSchema, scopeOptionsSchema, diagnosticReportSchema, escalationFindingSchema, paceAnalyticsSchema, remediationSchema, reportedFindingSchema, reviewPlanSchema, scheduledConceptSchema, slotPaceSchema } from './learning-schemas.js';
import { concept, conceptMap, evidence, mapped, pace, plan, report, TAXONOMY, TOPICS } from '../testing/learning-fixtures.js';

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

describe('the learner app\'s reads of the concept map and the names (M8-29)', () => {
  it('reads the map from its route, and the learner is named in none', async () => {
    const map = conceptMap([mapped(1, { kind: 'asserted', state: 'weak', confidence: 0.6 }), mapped(2, { kind: 'tentative', leaning: 'weak' })]);
    const { api, urls } = rig(() => map);
    expect(await api.getConceptMap()).toEqual(map);
    expect(urls).toEqual(['http://api.test/v1/learning/concept-map']);
  });

  it('reads the answers behind a topic from the topic\'s own route, a page at a time', async () => {
    const { api, urls } = rig(() => evidence(1, 3));
    expect(await api.getConceptEvidence(concept(1), { limit: 20, offset: 40 })).toEqual(evidence(1, 3));
    expect(urls).toEqual([`http://api.test/v1/learning/concept-map/${encodeURIComponent(concept(1))}/evidence?limit=20&offset=40`]);
  });

  it('asks for the names of topics in one syllabus version as a comma-separated list, and hands on the names in order', async () => {
    const { api, urls } = rig(() => ({ concepts: TOPICS }));
    expect(await api.conceptNames(TAXONOMY, [concept(1), concept(2)])).toEqual(TOPICS);
    expect(urls).toEqual([`http://api.test/v1/learning/concept-names?taxonomyVersionId=${TAXONOMY}&conceptIdentityIds=${encodeURIComponent(`${concept(1)},${concept(2)}`)}`]);
    expect(NAMES_PER_REQUEST).toBe(100);
  });

  it('refuses a standing that is not one of the three, and a tentative one that carries a state, rather than draw a guess as a fact', async () => {
    const wrongKind = rig(() => conceptMap([mapped(1, { kind: 'known' } as never)]));
    await expect(wrongKind.api.getConceptMap()).rejects.toThrow('schema validation');
    const noConfidence = rig(() => conceptMap([mapped(1, { kind: 'asserted', state: 'weak' } as never)]));
    await expect(noConfidence.api.getConceptMap()).rejects.toThrow('schema validation');
    const noLean = rig(() => conceptMap([mapped(1, { kind: 'tentative', state: 'weak' } as never)]));
    await expect(noLean.api.getConceptMap()).rejects.toThrow('schema validation');
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
    ['NamedConcept', namedConceptSchema],
    ['MappedConcept', mappedConceptSchema],
    ['ConceptMap', conceptMapSchema],
    ['ConceptEvidence', conceptEvidenceSchema],
    ['ConceptNames', conceptNamesSchema],
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
