import { ROLES } from '../../../../platform/auth/roles.js';
import { err, ok, type Result } from '../../domain/result.js';
import type { ConceptNode } from '../../domain/concept-node.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext } from '../ports.js';
import type { CurriculumQueryDependencies } from './curriculum-queries.js';

/**
 * What Learning asks of Curriculum to build a learner's profile (M8-19, ADR-0060): the exams a learner may choose, the profile version and taxonomy a choice resolves to (INV-04),
 * the chapters of a taxonomy to pick from, and the concepts a pick stands for. Seam-only reads with no route, the system's alone: a learner reaches them through Learning, which
 * holds the profile, and never through Curriculum's own routes, so what Curriculum offers a learner and what Learning does with the answer are two decisions.
 *
 * Only what is in force is offered. A profile version is active for a year only once it is published (activating one requires it), so "active for the year" is the whole test for a profile; a taxonomy version is checked for being published, since a profile can name one that has since been superseded and a learner is not built against that.
 */
const SYSTEM = [ROLES.system] as const;

const notFound = (code: string, message: string): ApplicationError => ({ kind: 'NotFound', code, message });

export interface ExamOptionView {
  readonly examCode: string;
  readonly displayName: string;
  readonly years: readonly string[];
}

export class ListExamOptionsQuery implements Handler<Record<string, never>, readonly ExamOptionView[]> {
  readonly name = 'ListExamOptions';
  readonly policy = policy('ListExamOptions', SYSTEM);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  /** The exams with a profile version active for at least one year, each with those years, in order. */
  async handle(_query: Record<string, never>, context: ApplicationContext): Promise<Result<readonly ExamOptionView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;
    const exams = await this.deps.exams.list();
    return ok(
      exams
        .map((stored) => ({
          examCode: stored.aggregate.code,
          displayName: stored.aggregate.displayName,
          years: [...stored.aggregate.activeProfileVersions.keys()].sort(),
        }))
        .filter((option) => option.years.length > 0)
        .sort((a, b) => (a.examCode < b.examCode ? -1 : 1)),
    );
  }
}

export interface ResolveExamChoice {
  readonly examCode: string;
  readonly academicYear: string;
}

export interface ExamChoiceView {
  readonly examCode: string;
  readonly academicYear: string;
  readonly profileVersionId: string;
  readonly taxonomyVersionId: string;
}

export class ResolveExamChoiceQuery implements Handler<ResolveExamChoice, ExamChoiceView> {
  readonly name = 'ResolveExamChoice';
  readonly policy = policy('ResolveExamChoice', SYSTEM);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  /** The exam and year to the profile version active for them and the taxonomy version it is built on. Anything that is not so is named, and nothing is guessed. */
  async handle(query: ResolveExamChoice, context: ApplicationContext): Promise<Result<ExamChoiceView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;
    const exams = await this.deps.exams.list();
    const exam = exams.find((stored) => stored.aggregate.code === query.examCode)?.aggregate;
    if (exam === undefined) return err(notFound('EXAM_NOT_FOUND', `there is no exam ${query.examCode}`));
    const profileVersionId = exam.activeProfileVersionFor(query.academicYear);
    if (profileVersionId === undefined) return err(notFound('NO_PROFILE_FOR_YEAR', `${exam.code} has no exam profile active for ${query.academicYear}`));
    const loaded = await this.deps.profiles.findById(profileVersionId);
    if (!loaded.ok) return err({ kind: loaded.error.kind, code: loaded.error.code, message: loaded.error.message });
    return ok(Object.freeze({ examCode: exam.code, academicYear: query.academicYear, profileVersionId, taxonomyVersionId: loaded.value.aggregate.taxonomyVersionId }));
  }
}

export interface ScopeNodeView {
  readonly nodeId: string;
  readonly parentNodeId: string | null;
  readonly displayName: string;
  readonly depth: number;
}

export interface ScopeNodesView {
  readonly taxonomyVersionId: string;
  readonly nodes: readonly ScopeNodeView[];
  /** How many concepts the version has: the whole that a scope is a fraction of. A version has one node per concept (`concept_node_identity_unique_per_version`), so it is the number of nodes. */
  readonly conceptTotal: number;
}

export interface ListScopeNodes {
  readonly taxonomyVersionId: string;
}

async function publishedTaxonomy(deps: CurriculumQueryDependencies, taxonomyVersionId: string) {
  const loaded = await deps.versions.findById(taxonomyVersionId);
  if (!loaded.ok) return err<ApplicationError>({ kind: loaded.error.kind, code: loaded.error.code, message: loaded.error.message });
  if (loaded.value.aggregate.state !== 'published') return err<ApplicationError>(notFound('TAXONOMY_NOT_IN_FORCE', `taxonomy version ${taxonomyVersionId} is not published`));
  return ok(loaded.value.aggregate);
}

export class ListScopeNodesQuery implements Handler<ListScopeNodes, ScopeNodesView> {
  readonly name = 'ListScopeNodes';
  readonly policy = policy('ListScopeNodes', SYSTEM);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(query: ListScopeNodes, context: ApplicationContext): Promise<Result<ScopeNodesView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;
    const version = await publishedTaxonomy(this.deps, query.taxonomyVersionId);
    if (!version.ok) return version;
    const nodes = [...version.value.nodes].sort((a, b) => a.depth - b.depth || (a.displayName < b.displayName ? -1 : a.displayName > b.displayName ? 1 : a.conceptNodeId < b.conceptNodeId ? -1 : 1));
    return ok(
      Object.freeze({
        taxonomyVersionId: version.value.taxonomyVersionId,
        nodes: nodes.map((node) => ({ nodeId: node.conceptNodeId, parentNodeId: node.parentNodeId ?? null, displayName: node.displayName, depth: node.depth })),
        conceptTotal: version.value.nodes.length,
      }),
    );
  }
}

export interface ResolveScopeNodes {
  readonly taxonomyVersionId: string;
  readonly nodeIds: readonly string[];
}

export interface ResolvedScopeView {
  readonly conceptIdentityIds: readonly string[];
  readonly conceptTotal: number;
}

export class ResolveScopeNodesQuery implements Handler<ResolveScopeNodes, ResolvedScopeView> {
  readonly name = 'ResolveScopeNodes';
  readonly policy = policy('ResolveScopeNodes', SYSTEM);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  /**
   * The concepts the picked nodes stand for, each with everything under it, once each. All or nothing: a node the version does not have fails the whole read and is named,
   * because a scope that quietly dropped a chapter would filter practice on something the learner did not choose.
   */
  async handle(query: ResolveScopeNodes, context: ApplicationContext): Promise<Result<ResolvedScopeView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;
    const version = await publishedTaxonomy(this.deps, query.taxonomyVersionId);
    if (!version.ok) return version;
    const taxonomy = version.value;
    const unknown = query.nodeIds.filter((nodeId) => taxonomy.nodeById(nodeId) === undefined);
    if (unknown.length > 0) return err(notFound('SCOPE_NODES_UNKNOWN', `taxonomy version ${query.taxonomyVersionId} has no node ${unknown.join(', ')}`));
    const concepts = new Set<string>();
    const seen = new Set<string>();
    const frontier: ConceptNode[] = query.nodeIds.map((nodeId) => taxonomy.nodeById(nodeId) as ConceptNode);
    while (frontier.length > 0) {
      const node = frontier.shift() as ConceptNode;
      if (seen.has(node.conceptNodeId)) continue;
      seen.add(node.conceptNodeId);
      concepts.add(node.conceptIdentityId);
      frontier.push(...taxonomy.childrenOf(node.conceptNodeId));
    }
    return ok(Object.freeze({ conceptIdentityIds: Object.freeze([...concepts].sort()), conceptTotal: taxonomy.nodes.length }));
  }
}
