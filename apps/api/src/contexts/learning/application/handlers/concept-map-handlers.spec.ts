import { describe, expect, it } from 'vitest';
import { ROLES } from '../../../../platform/auth/roles.js';
import { D002_THRESHOLDS } from '../../../../testing/learning-thresholds.js';
import { conceptMapOf } from '../../domain/concept-map.js';
import type { ConceptEvidence } from '../../domain/concept-state.js';
import type { LearnerProfile } from '../../domain/learner-profile.js';
import { err, ok } from '../../domain/result.js';
import { applicationError } from '../authorization.js';
import type { ApplicationContext, ConceptMapStore, ConceptResponse, CurriculumSource, LearnerProfileStore, MasteryRuleSetRepository, NamedConcept } from '../ports.js';
import {
  DEFAULT_EVIDENCE_PAGE,
  GetConceptEvidenceHandler,
  GetConceptMapHandler,
  GetConceptNamesHandler,
  MAX_EVIDENCE_PAGE,
  MAX_NAMES_PER_REQUEST,
  standingOf,
} from './concept-map-handlers.js';

const LEARNER = '5b0d6a1e-3f4c-4d8b-9a2e-7c1f0e9d8b6a';
const TAXONOMY = '7a1f0e9d-8b6a-4d8b-9a2e-5b0d6a1e3f4c';
const WEAK = '11111111-1111-4111-8111-111111111111';
const STRONG = '22222222-2222-4222-8222-222222222222';
const FEW = '33333333-3333-4333-8333-333333333333';
const OUTSIDE = '44444444-4444-4444-8444-444444444444';
const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 1, 9, 0, 0);
const NOW = new Date(T0 + 2 * DAY);
const at = (days: number, minutes = 0): string => new Date(T0 + days * DAY + minutes * 60_000).toISOString();
const asLearner = (id = LEARNER): ApplicationContext => ({ principal: { kind: 'human', id, roleContext: [ROLES.learner] }, correlationId: 'corr-1' });

let n = 0;
const ev = (item: number, session: number, day: number, outcome: 'correct' | 'incorrect' = 'correct'): ConceptEvidence => {
  n += 1;
  return { evidenceId: `e${String(n).padStart(4, '0')}`, itemVersionRef: `item${item}`, outcome, difficultyEstimate: 'moderate', occurredAt: at(day, n), sessionId: `s${session}` };
};
const strongEvidence = (): ConceptEvidence[] => Array.from({ length: 8 }, (_, i) => ev(i + 1, i < 4 ? 1 : 2, i < 4 ? 0 : 1));
const weakEvidence = (): ConceptEvidence[] => Array.from({ length: 8 }, (_, i) => ev(i + 1, i < 4 ? 1 : 2, i < 4 ? 0 : 1, 'incorrect'));

const NAMES = new Map<string, NamedConcept>([
  [WEAK, { conceptIdentityId: WEAK, name: 'Kinematics', path: ['Physics', 'Mechanics'] }],
  [STRONG, { conceptIdentityId: STRONG, name: 'Ray optics', path: ['Physics', 'Optics'] }],
  [FEW, { conceptIdentityId: FEW, name: 'Gravitation', path: ['Physics', 'Mechanics'] }],
  [OUTSIDE, { conceptIdentityId: OUTSIDE, name: 'Alkanes', path: ['Chemistry', 'Organic'] }],
]);

function profile(overrides: Partial<LearnerProfile> = {}): LearnerProfile {
  return {
    learnerRef: LEARNER,
    exam: { examCode: 'JEE_MAIN', targetYear: '2027', examProfileVersionId: 'p-1', taxonomyVersionId: TAXONOMY },
    currentClass: null,
    priorScore: null,
    scope: null,
    onboardingSkippedAt: null,
    version: 1,
    createdAt: at(0),
    updatedAt: at(0),
    ...overrides,
  };
}

function rig(options: { profile?: LearnerProfile | null; evidence?: Map<string, ConceptEvidence[]>; asOf?: string; now?: Date } = {}) {
  const calls = { ruleSets: 0, names: [] as string[][], scopeOptions: 0, states: 0, responses: [] as Array<{ limit: number; offset: number }> };
  const evidence = options.evidence ?? new Map([[WEAK, weakEvidence()], [STRONG, strongEvidence()], [FEW, [ev(1, 1, 1)]]]);
  const stored = conceptMapOf(LEARNER, TAXONOMY, evidence, D002_THRESHOLDS, options.asOf ?? at(2));
  const responses: ConceptResponse[] = Array.from({ length: 130 }, (_, i) => ({ evidenceId: `r${i}`, attemptRef: `a${i % 3}`, occurredAt: at(1, 130 - i), outcome: i % 2 === 0 ? 'correct' : 'incorrect', difficultyEstimate: 'moderate' }));
  const refuse = { fail: null as ReturnType<typeof applicationError> | null, names: null as ReturnType<typeof applicationError> | null, syllabus: null as ReturnType<typeof applicationError> | null, rules: null as ReturnType<typeof applicationError> | null };
  const profiles: LearnerProfileStore = { find: async () => ok(options.profile === undefined ? profile() : options.profile), save: async () => err(applicationError('Unavailable', 'X', 'x')) };
  const concepts: ConceptMapStore = {
    states: async () => {
      calls.states += 1;
      return refuse.fail ? err(refuse.fail) : ok(stored);
    },
    responses: async (_learner, _taxonomy, _concept, page) => {
      calls.responses.push(page);
      return ok({ total: responses.length, responses: responses.slice(page.offset, page.offset + page.limit) });
    },
  };
  const ruleSets = {
    currentFor: async () => {
      calls.ruleSets += 1;
      return refuse.rules ? err(refuse.rules) : ok({ thresholds: D002_THRESHOLDS });
    },
  } as unknown as MasteryRuleSetRepository;
  const curriculum = {
    conceptNames: async (_taxonomy: string, ids: readonly string[]) => {
      calls.names.push([...ids]);
      return refuse.names ? err(refuse.names) : ok(ids.map((id) => NAMES.get(id) as NamedConcept));
    },
    scopeOptions: async () => {
      calls.scopeOptions += 1;
      return refuse.syllabus ? err(refuse.syllabus) : ok({ taxonomyVersionId: TAXONOMY, nodes: [], conceptTotal: 10 });
    },
  } as unknown as CurriculumSource;
  const deps = { profiles, concepts, ruleSets, curriculum, clock: { now: () => options.now ?? NOW } };
  return { calls, refuse, map: new GetConceptMapHandler(deps), evidence: new GetConceptEvidenceHandler(deps), names: new GetConceptNamesHandler(deps) };
}

describe('how a state is told to a learner', () => {
  it('asserts a state with enough answers behind it, with its confidence', () => {
    const state = conceptMapOf(LEARNER, TAXONOMY, new Map([[STRONG, strongEvidence()]]), D002_THRESHOLDS, at(2)).conceptStates[0]!;
    const standing = standingOf(state);
    expect(standing).toMatchObject({ kind: 'asserted', state: 'strong' });
    expect(standing.kind === 'asserted' && standing.confidence).toBeGreaterThan(0);
  });

  it('does not assert a state with too few answers: it leans, and carries no state at all', () => {
    const state = conceptMapOf(LEARNER, TAXONOMY, new Map([[FEW, [ev(1, 1, 1)]]]), D002_THRESHOLDS, at(2)).conceptStates[0]!;
    expect(state.lowConfidence).toBe(true);
    const standing = standingOf(state);
    expect(standing).toEqual({ kind: 'tentative', leaning: state.state });
    expect('state' in standing).toBe(false);
    expect('confidence' in standing).toBe(false);
  });

  it('says unassessed for a state with nothing behind it', () => {
    const state = { ...conceptMapOf(LEARNER, TAXONOMY, new Map([[FEW, [ev(1, 1, 1)]]]), D002_THRESHOLDS, at(2)).conceptStates[0]!, state: 'unassessed' as const };
    expect(standingOf(state)).toEqual({ kind: 'unassessed' });
  });
});

describe('the concept map (M8-28, FR-STU-04)', () => {
  it('names each topic with the syllabus above it, states how sure it is, and counts the answers behind it', async () => {
    const view = await rig().map.handle({}, asLearner());
    expect(view.ok).toBe(true);
    const concepts = view.ok ? view.value.concepts : [];
    expect(concepts.map((c) => [c.name, c.path])).toEqual([
      ['Gravitation', ['Physics', 'Mechanics']],
      ['Kinematics', ['Physics', 'Mechanics']],
      ['Ray optics', ['Physics', 'Optics']],
    ]);
    const byName = Object.fromEntries(concepts.map((c) => [c.name, c]));
    expect(byName['Kinematics']).toMatchObject({ conceptIdentityId: WEAK, standing: { kind: 'asserted', state: 'weak' }, evidenceCount: 8 });
    expect(byName['Ray optics']).toMatchObject({ standing: { kind: 'asserted', state: 'strong' }, evidenceCount: 8 });
    expect(byName['Gravitation']).toMatchObject({ standing: { kind: 'tentative' }, evidenceCount: 1 });
    expect(JSON.stringify(concepts)).not.toContain('evidenceIds');
  });

  it('reports a low-confidence state as tentative and never asserts it', async () => {
    const view = await rig().map.handle({}, asLearner());
    const few = view.ok ? view.value.concepts.find((c) => c.conceptIdentityId === FEW) : undefined;
    expect(few?.standing.kind).toBe('tentative');
    expect(few && 'state' in few.standing).toBe(false);
  });

  it('applies decay at the instant of the read: the same stored map, read a year later, says strong has slipped', async () => {
    const soon = await rig({ now: NOW }).map.handle({}, asLearner());
    const later = await rig({ now: new Date(T0 + 400 * DAY) }).map.handle({}, asLearner());
    const strongAt = (view: typeof soon) => (view.ok ? view.value.concepts.find((c) => c.conceptIdentityId === STRONG)?.standing : undefined);
    expect(strongAt(soon)).toMatchObject({ kind: 'asserted', state: 'strong' });
    expect(strongAt(later)).toMatchObject({ kind: 'asserted', state: 'developing' });
    expect(later.ok && later.value.asOf).toBe(new Date(T0 + 400 * DAY).toISOString());
  });

  it('is not filtered by the declared scope: it marks what is inside it and leaves the rest in', async () => {
    const evidence = new Map([[WEAK, weakEvidence()], [OUTSIDE, strongEvidence()]]);
    const scoped = profile({ scope: { taxonomyVersionId: TAXONOMY, nodeIds: ['n1'], conceptIdentityIds: [WEAK], conceptTotal: 10 } });
    const view = await rig({ profile: scoped, evidence }).map.handle({}, asLearner());
    const concepts = view.ok ? view.value.concepts : [];
    expect(concepts.map((c) => [c.name, c.inDeclaredScope])).toEqual([['Alkanes', false], ['Kinematics', true]]);
  });

  it('says nothing about the scope when none was declared, or when it was declared against another version', async () => {
    const none = await rig().map.handle({}, asLearner());
    expect(none.ok && none.value.concepts.every((c) => c.inDeclaredScope === null)).toBe(true);
    const other = profile({ scope: { taxonomyVersionId: 'another', nodeIds: ['n1'], conceptIdentityIds: [WEAK], conceptTotal: 10 } });
    const view = await rig({ profile: other }).map.handle({}, asLearner());
    expect(view.ok && view.value.concepts.every((c) => c.inDeclaredScope === null)).toBe(true);
  });

  it('counts what the learner has not answered on, against the size of the syllabus', async () => {
    const view = await rig().map.handle({}, asLearner());
    expect(view.ok && [view.value.assessedCount, view.value.unassessedCount]).toEqual([3, 7]);
  });

  it('is empty for a learner with no answers, and reads neither the rule set nor the names', async () => {
    const { map, calls } = rig({ evidence: new Map() });
    const view = await map.handle({}, asLearner());
    expect(view.ok && view.value).toMatchObject({ concepts: [], assessedCount: 0, unassessedCount: 10 });
    expect(calls.ruleSets).toBe(0);
    expect(calls.names).toEqual([]);
  });

  it('asks for the names in one call, for the version the learner chose', async () => {
    const { map, calls } = rig();
    await map.handle({}, asLearner());
    expect(calls.names).toEqual([[FEW, STRONG, WEAK].sort()]);
  });

  it('has nothing to read before an exam is chosen, and says to choose one', async () => {
    for (const held of [null, profile({ exam: null })]) {
      const { map, calls } = rig({ profile: held });
      expect(await map.handle({}, asLearner())).toMatchObject({ ok: false, error: { kind: 'PreconditionFailed', code: 'NO_EXAM_CHOSEN' } });
      expect(calls.states).toBe(0);
    }
  });

  it('fails whole when a topic cannot be named, when the syllabus cannot be read, and when the store cannot', async () => {
    const unnamed = rig();
    unnamed.refuse.names = applicationError('NotFound', 'CONCEPTS_UNKNOWN', 'no concept');
    expect(await unnamed.map.handle({}, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPTS_UNKNOWN' } });
    const syllabus = rig();
    syllabus.refuse.syllabus = applicationError('Unavailable', 'SOURCE_UNAVAILABLE', 'down');
    expect(await syllabus.map.handle({}, asLearner())).toMatchObject({ ok: false, error: { code: 'SOURCE_UNAVAILABLE' } });
    const store = rig();
    store.refuse.fail = applicationError('Unavailable', 'LEARNING_STORE_UNAVAILABLE', 'down');
    expect(await store.map.handle({}, asLearner())).toMatchObject({ ok: false, error: { code: 'LEARNING_STORE_UNAVAILABLE' } });
    const rules = rig();
    rules.refuse.rules = applicationError('NotFound', 'NO_RULE_SET', 'none');
    expect(await rules.map.handle({}, asLearner())).toMatchObject({ ok: false, error: { code: 'NO_RULE_SET' } });
  });

  it('is the learner\'s alone', async () => {
    const guest: ApplicationContext = { principal: { kind: 'human', id: LEARNER, roleContext: [ROLES.guest] }, correlationId: 'c' };
    expect(await rig().map.handle({}, guest)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
    expect(await rig().evidence.handle({ conceptIdentityId: WEAK }, guest)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
    expect(await rig().names.handle({ taxonomyVersionId: TAXONOMY, conceptIdentityIds: [] }, guest)).toMatchObject({ ok: false, error: { kind: 'Authorization' } });
  });
});

describe('the answers behind one state (M8-28, FR-STU-04 rule 1)', () => {
  it('gives the topic by name, how it stands now, and a first page of its answers, newest first', async () => {
    const { evidence, calls } = rig();
    const view = await evidence.handle({ conceptIdentityId: WEAK }, asLearner());
    expect(view.ok && view.value).toMatchObject({
      concept: { conceptIdentityId: WEAK, name: 'Kinematics', path: ['Physics', 'Mechanics'] },
      standing: { kind: 'asserted', state: 'weak' },
      evidenceCount: 8,
      total: 130,
      limit: DEFAULT_EVIDENCE_PAGE,
      offset: 0,
    });
    expect(view.ok && view.value.responses).toHaveLength(DEFAULT_EVIDENCE_PAGE);
    expect(calls.responses).toEqual([{ limit: DEFAULT_EVIDENCE_PAGE, offset: 0 }]);
  });

  it('pages: a second page starts where the first ended, and a page is never more than the bound', async () => {
    const { evidence } = rig();
    const second = await evidence.handle({ conceptIdentityId: WEAK, limit: 100, offset: 100 }, asLearner());
    expect(second.ok && [second.value.responses.length, second.value.responses[0]?.evidenceId, second.value.offset]).toEqual([30, 'r100', 100]);
    for (const limit of [0, MAX_EVIDENCE_PAGE + 1, 1.5]) {
      expect(await evidence.handle({ conceptIdentityId: WEAK, limit }, asLearner()), String(limit)).toMatchObject({ ok: false, error: { code: 'CONCEPT_EVIDENCE_QUERY_INVALID' } });
    }
    expect(await evidence.handle({ conceptIdentityId: WEAK, offset: -1 }, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPT_EVIDENCE_QUERY_INVALID' } });
    expect(await evidence.handle({ conceptIdentityId: 'not-an-id' }, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPT_EVIDENCE_QUERY_INVALID' } });
  });

  it('reads the standing at the instant of the read, as the map does', async () => {
    const later = await rig({ now: new Date(T0 + 400 * DAY) }).evidence.handle({ conceptIdentityId: STRONG }, asLearner());
    expect(later.ok && later.value.standing).toMatchObject({ kind: 'asserted', state: 'developing' });
  });

  it('reports a low-confidence topic as tentative here too', async () => {
    const view = await rig().evidence.handle({ conceptIdentityId: FEW }, asLearner());
    expect(view.ok && view.value.standing.kind).toBe('tentative');
  });

  it('answers a topic the learner has no answers on as nothing to show, whether or not it exists', async () => {
    expect(await rig().evidence.handle({ conceptIdentityId: OUTSIDE }, asLearner())).toMatchObject({ ok: false, error: { kind: 'NotFound', code: 'CONCEPT_NOT_ASSESSED' } });
  });

  it('has nothing to read before an exam is chosen, and fails whole when the store or the names cannot be read', async () => {
    expect(await rig({ profile: null }).evidence.handle({ conceptIdentityId: WEAK }, asLearner())).toMatchObject({ ok: false, error: { code: 'NO_EXAM_CHOSEN' } });
    const store = rig();
    store.refuse.fail = applicationError('Unavailable', 'LEARNING_STORE_UNAVAILABLE', 'down');
    expect(await store.evidence.handle({ conceptIdentityId: WEAK }, asLearner())).toMatchObject({ ok: false, error: { code: 'LEARNING_STORE_UNAVAILABLE' } });
    const names = rig();
    names.refuse.names = applicationError('NotFound', 'CONCEPTS_UNKNOWN', 'no concept');
    expect(await names.evidence.handle({ conceptIdentityId: WEAK }, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPTS_UNKNOWN' } });
    const rules = rig();
    rules.refuse.rules = applicationError('NotFound', 'NO_RULE_SET', 'none');
    expect(await rules.evidence.handle({ conceptIdentityId: WEAK }, asLearner())).toMatchObject({ ok: false, error: { code: 'NO_RULE_SET' } });
  });
});

describe('what topics are called (M8-29)', () => {
  it('names the topics asked for, with the syllabus above them', async () => {
    const view = await rig().names.handle({ taxonomyVersionId: TAXONOMY, conceptIdentityIds: [STRONG, WEAK] }, asLearner());
    expect(view.ok && view.value.concepts.map((c) => [c.name, c.path])).toEqual([['Ray optics', ['Physics', 'Optics']], ['Kinematics', ['Physics', 'Mechanics']]]);
  });

  it('answers none with none, and does not ask Curriculum', async () => {
    const { names, calls } = rig();
    expect(await names.handle({ taxonomyVersionId: TAXONOMY, conceptIdentityIds: [] }, asLearner())).toEqual({ ok: true, value: { concepts: [] } });
    expect(calls.names).toEqual([]);
  });

  it('refuses a request that is not a syllabus and topics, and one for more than the bound', async () => {
    const { names } = rig();
    const many = Array.from({ length: MAX_NAMES_PER_REQUEST + 1 }, () => WEAK);
    expect(await names.handle({ taxonomyVersionId: TAXONOMY, conceptIdentityIds: many }, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPT_NAMES_QUERY_INVALID' } });
    expect(await names.handle({ taxonomyVersionId: TAXONOMY, conceptIdentityIds: Array.from({ length: MAX_NAMES_PER_REQUEST }, () => WEAK) }, asLearner())).toMatchObject({ ok: true });
    expect(await names.handle({ taxonomyVersionId: 'x', conceptIdentityIds: [WEAK] }, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPT_NAMES_QUERY_INVALID' } });
    expect(await names.handle({ taxonomyVersionId: TAXONOMY, conceptIdentityIds: ['x'] }, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPT_NAMES_QUERY_INVALID' } });
  });

  it('passes on what Curriculum could not name', async () => {
    const { names, refuse } = rig();
    refuse.names = applicationError('NotFound', 'CONCEPTS_UNKNOWN', 'no concept');
    expect(await names.handle({ taxonomyVersionId: TAXONOMY, conceptIdentityIds: [WEAK] }, asLearner())).toMatchObject({ ok: false, error: { code: 'CONCEPTS_UNKNOWN' } });
  });
});
