import { ROLES } from '../../../../platform/auth/roles.js';
import { readConceptMap, stateOf } from '../../domain/concept-map.js';
import type { ConceptState } from '../../domain/concept-state.js';
import { conceptsInScope } from '../../domain/learner-profile.js';
import type { LearnerProfile } from '../../domain/learner-profile.js';
import type { DifficultyEstimate, EvidenceOutcome } from '../../domain/mastery-evidence.js';
import { err, ok, type Result } from '../../domain/result.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { ApplicationContext, Clock, ConceptMapStore, CurriculumSource, LearnerProfileStore, MasteryRuleSetRepository, NamedConcept } from '../ports.js';

/**
 * `GetConceptMap` and `GetConceptEvidence` — what the learner knows, concept by concept, and the responses a state is made of (M8-28, FR-STU-04). The learner is the principal and is never a field, so
 * there is no way to ask for another's map. The map is a *read*: Learning's domain already holds the four states, the confidence, the evidence count and decay, and nothing here derives a state.
 *
 * **Decay is applied at the instant of the read** (`readConceptMap`, DEC-M7-8). A state that has gone quiet reads as weaker than it was stored, with nothing scheduled and no row rewritten: the same
 * map read a month later is a different answer, and that is the rule working, not the data changing.
 *
 * **A low-confidence state is not asserted, and the shape says so** (FR-STU-04 rule 2). A `standing` is `asserted` (a state, and a confidence) or `tentative` (only what the few responses lean towards). A
 * tentative standing has no `state` field at all, so a screen that reads `standing.state` without having looked at `standing.kind` has nothing to render, and the type will not let it compile; a boolean beside a
 * state is a state a caller can read and ignore the boolean of.
 *
 * **Explainability is a read, and is paged** (rule 1). The map carries the count of responses behind each state; the responses themselves are the drill-down, for one concept, newest first, a page at a time.
 * Each is the instant, the outcome and the attempt it was given in. A whole map with every response inline would grow with everything the learner has ever done.
 *
 * **The declared scope does not filter the map** (ADR-0062). The map is what the learner knows, and hiding responses they gave would be a false statement about their own history; scope steers what to practise
 * next. Each concept says whether it is inside the declared syllabus (`null` when none was declared), and the screen may use that to present it.
 *
 * **The map is of the taxonomy version the learner's exam resolved to** when they chose it; a learner who has not chosen one has no map to read (`NO_EXAM_CHOSEN`). Free tier sees the map and paid tiers the
 * drill-down (rule 4) is an entitlement, which M9 builds; both are served to every learner until then (D113 in docs/DEBT.md).
 *
 * All or nothing in the names: a concept the version cannot name fails the read, as a half-named map would show a learner a gap where a topic should be.
 */
export const GET_CONCEPT_MAP_POLICY = policy('GetConceptMap', [ROLES.learner]);
export const GET_CONCEPT_EVIDENCE_POLICY = policy('GetConceptEvidence', [ROLES.learner]);
export const GET_CONCEPT_NAMES_POLICY = policy('GetConceptNames', [ROLES.learner]);

export const DEFAULT_EVIDENCE_PAGE = 50;
export const MAX_EVIDENCE_PAGE = 100;
/** The most names one request asks for. A request-size rule of this route; the adapter pages at Curriculum's own bound beneath it. */
export const MAX_NAMES_PER_REQUEST = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export type Standing =
  | { readonly kind: 'asserted'; readonly state: 'weak' | 'developing' | 'strong'; readonly confidence: number }
  | { readonly kind: 'tentative'; readonly leaning: 'weak' | 'developing' | 'strong' }
  | { readonly kind: 'unassessed' };

/** How a stored state is told to a learner. A presentation of a state, not a derivation of one: which state it is was decided where the evidence was read. */
export function standingOf(state: ConceptState): Standing {
  if (state.state === 'unassessed') return Object.freeze({ kind: 'unassessed' as const });
  if (state.lowConfidence) return Object.freeze({ kind: 'tentative' as const, leaning: state.state });
  return Object.freeze({ kind: 'asserted' as const, state: state.state, confidence: Math.round(state.confidence * 10_000) / 10_000 });
}

export interface MappedConcept {
  readonly conceptIdentityId: string;
  readonly name: string;
  /** Subject, chapter, topic: the names above it, outermost first. */
  readonly path: readonly string[];
  readonly standing: Standing;
  readonly evidenceCount: number;
  readonly lastEvidenceAt: string | null;
  /** Inside the syllabus the learner declared they have studied; `null` when they declared none. Presentation only. */
  readonly inDeclaredScope: boolean | null;
}

export interface ConceptMapView {
  /** The instant the map was read at, which decay was computed against. */
  readonly asOf: string;
  readonly concepts: readonly MappedConcept[];
  /** How many concepts of the syllabus the learner has answered something on, and how many they have not: the map lists the first and counts the second. */
  readonly assessedCount: number;
  readonly unassessedCount: number;
}

interface Deps {
  readonly profiles: LearnerProfileStore;
  readonly concepts: ConceptMapStore;
  readonly ruleSets: MasteryRuleSetRepository;
  readonly curriculum: CurriculumSource;
  readonly clock: Clock;
}

const NO_EXAM = applicationError('PreconditionFailed', 'NO_EXAM_CHOSEN', 'choose an exam first: your progress is shown against its syllabus');

async function examOf(deps: Pick<Deps, 'profiles'>, context: ApplicationContext): Promise<Result<{ taxonomyVersionId: string; profile: LearnerProfile }, ApplicationError>> {
  const found = await deps.profiles.find(context.principal.id);
  if (!found.ok) return err(found.error);
  if (found.value === null || found.value.exam === null) return err(NO_EXAM);
  return ok({ taxonomyVersionId: found.value.exam.taxonomyVersionId, profile: found.value });
}

export class GetConceptMapHandler {
  readonly name = 'GetConceptMap';
  readonly policy = GET_CONCEPT_MAP_POLICY;

  constructor(private readonly deps: Deps) {}

  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<ConceptMapView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const exam = await examOf(this.deps, context);
    if (!exam.ok) return err(exam.error);
    const { taxonomyVersionId, profile } = exam.value;

    const stored = await this.deps.concepts.states(context.principal.id, taxonomyVersionId);
    if (!stored.ok) return err(stored.error);
    const asOf = this.deps.clock.now().toISOString();
    const syllabus = await this.deps.curriculum.scopeOptions(taxonomyVersionId, context);
    if (!syllabus.ok) return err(syllabus.error);
    if (stored.value.conceptStates.length === 0) {
      return ok(Object.freeze({ asOf, concepts: Object.freeze([]), assessedCount: 0, unassessedCount: syllabus.value.conceptTotal }));
    }

    const ruleSet = await this.deps.ruleSets.currentFor(taxonomyVersionId);
    if (!ruleSet.ok) return err(ruleSet.error);
    const read = readConceptMap(stored.value, ruleSet.value.thresholds, asOf);
    const named = await this.deps.curriculum.conceptNames(taxonomyVersionId, read.conceptStates.map((s) => s.conceptIdentityId), context);
    if (!named.ok) return err(named.error);
    const names = new Map(named.value.map((n) => [n.conceptIdentityId, n]));
    const scope = conceptsInScope(profile, taxonomyVersionId);

    const concepts = read.conceptStates
      .map((state): MappedConcept => {
        const concept = names.get(state.conceptIdentityId) as NamedConcept;
        return Object.freeze({
          conceptIdentityId: state.conceptIdentityId,
          name: concept.name,
          path: concept.path,
          standing: standingOf(state),
          evidenceCount: state.evidenceCount,
          lastEvidenceAt: state.lastEvidenceAt,
          inDeclaredScope: scope === null ? null : scope.has(state.conceptIdentityId),
        });
      })
      .sort((a, b) => (a.path.join('\u0000') + '\u0000' + a.name < b.path.join('\u0000') + '\u0000' + b.name ? -1 : 1));
    return ok(Object.freeze({ asOf, concepts: Object.freeze(concepts), assessedCount: concepts.length, unassessedCount: Math.max(0, syllabus.value.conceptTotal - concepts.length) }));
  }
}

export interface GetConceptEvidence {
  readonly conceptIdentityId: string;
  readonly limit?: number;
  readonly offset?: number;
}

export interface ConceptEvidenceView {
  readonly concept: { readonly conceptIdentityId: string; readonly name: string; readonly path: readonly string[] };
  readonly standing: Standing;
  readonly evidenceCount: number;
  readonly lastEvidenceAt: string | null;
  readonly asOf: string;
  /** Newest first. */
  readonly responses: readonly {
    readonly evidenceId: string;
    readonly attemptRef: string;
    readonly occurredAt: string;
    readonly outcome: EvidenceOutcome;
    readonly difficultyEstimate: DifficultyEstimate;
  }[];
  readonly total: number;
  readonly limit: number;
  readonly offset: number;
}

export class GetConceptEvidenceHandler {
  readonly name = 'GetConceptEvidence';
  readonly policy = GET_CONCEPT_EVIDENCE_POLICY;

  constructor(private readonly deps: Deps) {}

  async handle(query: GetConceptEvidence, context: ApplicationContext): Promise<Result<ConceptEvidenceView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const limit = query.limit ?? DEFAULT_EVIDENCE_PAGE;
    const offset = query.offset ?? 0;
    if (!UUID.test(query.conceptIdentityId) || !Number.isInteger(limit) || limit < 1 || limit > MAX_EVIDENCE_PAGE || !Number.isInteger(offset) || offset < 0) {
      return err(applicationError('Validation', 'CONCEPT_EVIDENCE_QUERY_INVALID', `a topic, and a page of between 1 and ${MAX_EVIDENCE_PAGE} answers`));
    }
    const exam = await examOf(this.deps, context);
    if (!exam.ok) return err(exam.error);
    const { taxonomyVersionId } = exam.value;

    const stored = await this.deps.concepts.states(context.principal.id, taxonomyVersionId);
    if (!stored.ok) return err(stored.error);
    const found = stateOf(stored.value, query.conceptIdentityId);
    // answered exactly as a topic that does not exist: a refusal would say what the learner has and has not answered on
    if (found === null) return err(applicationError('NotFound', 'CONCEPT_NOT_ASSESSED', 'there is nothing to show for that topic yet'));
    const ruleSet = await this.deps.ruleSets.currentFor(taxonomyVersionId);
    if (!ruleSet.ok) return err(ruleSet.error);
    const asOf = this.deps.clock.now().toISOString();
    const read = stateOf(readConceptMap(stored.value, ruleSet.value.thresholds, asOf), query.conceptIdentityId) as ConceptState;

    const named = await this.deps.curriculum.conceptNames(taxonomyVersionId, [query.conceptIdentityId], context);
    if (!named.ok) return err(named.error);
    const concept = named.value[0] as NamedConcept;
    const page = await this.deps.concepts.responses(context.principal.id, taxonomyVersionId, query.conceptIdentityId, { limit, offset });
    if (!page.ok) return err(page.error);
    return ok(
      Object.freeze({
        concept: Object.freeze({ conceptIdentityId: concept.conceptIdentityId, name: concept.name, path: concept.path }),
        standing: standingOf(read),
        evidenceCount: read.evidenceCount,
        lastEvidenceAt: read.lastEvidenceAt,
        asOf,
        responses: page.value.responses,
        total: page.value.total,
        limit,
        offset,
      }),
    );
  }
}

export interface GetConceptNames {
  readonly taxonomyVersionId: string;
  readonly conceptIdentityIds: readonly string[];
}

export interface ConceptNamesView {
  readonly concepts: readonly NamedConcept[];
}

/**
 * `GetConceptNames` — what the concepts a learner is shown are called (M8-29). The home screen's next action, a report's findings and the review plan all hand the app a concept by identifier, and an
 * identifier is not a thing a learner reads. The syllabus is the same for every learner (the onboarding list of chapters is the same list), so the names are not a read of anyone's data; the learner is the
 * principal all the same, and the route answers nobody who is not signed in.
 */
export class GetConceptNamesHandler {
  readonly name = 'GetConceptNames';
  readonly policy = GET_CONCEPT_NAMES_POLICY;

  constructor(private readonly deps: Pick<Deps, 'curriculum'>) {}

  async handle(query: GetConceptNames, context: ApplicationContext): Promise<Result<ConceptNamesView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    if (!UUID.test(query.taxonomyVersionId) || query.conceptIdentityIds.length > MAX_NAMES_PER_REQUEST || query.conceptIdentityIds.some((id) => !UUID.test(id))) {
      return err(applicationError('Validation', 'CONCEPT_NAMES_QUERY_INVALID', `a syllabus, and at most ${MAX_NAMES_PER_REQUEST} topics`));
    }
    if (query.conceptIdentityIds.length === 0) return ok(Object.freeze({ concepts: Object.freeze([]) }));
    const named = await this.deps.curriculum.conceptNames(query.taxonomyVersionId, query.conceptIdentityIds, context);
    if (!named.ok) return err(named.error);
    return ok(Object.freeze({ concepts: named.value }));
  }
}
