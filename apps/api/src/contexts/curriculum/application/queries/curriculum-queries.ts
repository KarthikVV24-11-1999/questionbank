import { err, ok, type Result } from '../../domain/result.js';
import type { ConceptNode } from '../../domain/concept-node.js';
import type { TaxonomyVersion } from '../../domain/taxonomy-version.js';
import type { TaxonomyVersionRepository, RepositoryError } from '../../domain/repository-ports.js';
import type { DrizzleExamRepository } from '../../infrastructure/exam.repository.js';
import type { DrizzleExamProfileVersionRepository } from '../../infrastructure/exam-profile-version.repository.js';
import type { DrizzleTaxonomyMigrationRepository } from '../../infrastructure/taxonomy-migration.repository.js';
import type { MigrationDryRunResult } from '../../domain/migration-dry-run.js';
import { authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type { ApplicationContext } from '../ports.js';

/**
 * Read models are DTOs — plain, camelCase, safe to serialize. A domain
 * aggregate never leaves the context (ENGINEERING-HANDBOOK §9 rule 1).
 */
export interface ConceptNodeView {
  readonly conceptNodeId: string;
  readonly conceptIdentityId: string;
  readonly parentNodeId: string | null;
  readonly displayName: string;
  readonly examWeight: number;
  readonly depth: number;
  readonly estimatedTeachingHours: number;
}

export interface TaxonomyVersionView {
  readonly taxonomyVersionId: string;
  readonly examFamily: string;
  readonly academicYear: string;
  readonly state: string;
  readonly publishedAt: string | null;
  readonly nodeCount: number;
  readonly prerequisiteCount: number;
  readonly aggregateVersion: number;
}

export interface TaxonomyVersionDetailView extends TaxonomyVersionView {
  readonly nodes: readonly ConceptNodeView[];
}

export interface ConceptSubtreeView {
  readonly rootNodeId: string;
  readonly depthLimit: number | null;
  readonly nodes: readonly ConceptNodeView[];
}

export interface ConceptPrerequisiteView {
  readonly conceptIdentityId: string;
  readonly requires: ReadonlyArray<{ readonly conceptIdentityId: string; readonly strength: number }>;
  readonly requiredBy: ReadonlyArray<{ readonly conceptIdentityId: string; readonly strength: number }>;
}

export interface SectionSpecView {
  readonly ordinal: number;
  readonly name: string;
  readonly subject: string;
  readonly itemCount: number;
  readonly itemTypeMix: Readonly<Record<string, number>>;
  readonly maxMarks: number;
  readonly sectionTimingMinutes: number | null;
}

export interface ExamProfileVersionView {
  readonly profileVersionId: string;
  readonly examId: string;
  readonly academicYear: string;
  readonly state: string;
  readonly taxonomyVersionId: string;
  readonly totalMarks: number;
  readonly markingRuleSetHash: string | null;
  readonly markingRuleSet: unknown;
  readonly sections: readonly SectionSpecView[];
  readonly itemTypeAllowances: readonly { readonly itemType: string; readonly sectionOrdinals: readonly number[] }[];
  readonly aggregateVersion: number;
}

export interface ExamView {
  readonly examId: string;
  readonly code: string;
  readonly displayName: string;
  readonly jurisdiction: string;
  readonly conductingBody: string;
  readonly activeProfileVersions: ReadonlyArray<{ readonly academicYear: string; readonly profileVersionId: string }>;
}

export interface GetTaxonomyVersion {
  readonly taxonomyVersionId: string;
}

export interface ListTaxonomyVersions {
  readonly examFamily: string;
}

export interface GetConceptSubtree {
  readonly taxonomyVersionId: string;
  readonly rootNodeId: string;
  readonly depthLimit?: number;
}

export interface GetConceptPrerequisites {
  readonly taxonomyVersionId: string;
  readonly conceptIdentityId: string;
}

export interface GetExamProfileVersion {
  readonly profileVersionId: string;
}

export interface ListExams {
  readonly limit?: number;
}

export interface GetMigrationDryRun {
  readonly migrationId: string;
}

export interface CurriculumQueryDependencies {
  readonly versions: TaxonomyVersionRepository;
  readonly exams: Pick<DrizzleExamRepository, 'findById' | 'list'>;
  readonly profiles: Pick<DrizzleExamProfileVersionRepository, 'findById'>;
  readonly migrations: Pick<DrizzleTaxonomyMigrationRepository, 'findById'>;
}

const READER = ['learner', 'curriculum_curator', 'content_ops', 'exam_owner'] as const;
const CURRICULUM_STAFF = ['curriculum_curator', 'content_ops', 'exam_owner'] as const;

function toApplicationError(error: RepositoryError): ApplicationError {
  return { kind: error.kind, code: error.code, message: error.message };
}

function toNodeView(node: ConceptNode): ConceptNodeView {
  return {
    conceptNodeId: node.conceptNodeId,
    conceptIdentityId: node.conceptIdentityId,
    parentNodeId: node.parentNodeId ?? null,
    displayName: node.displayName,
    examWeight: node.examWeight,
    depth: node.depth,
    estimatedTeachingHours: node.estimatedTeachingHours,
  };
}

function toVersionView(version: TaxonomyVersion, aggregateVersion: number): TaxonomyVersionView {
  return {
    taxonomyVersionId: version.taxonomyVersionId,
    examFamily: version.examFamily,
    academicYear: version.academicYear,
    state: version.state,
    publishedAt: version.publishedAt?.toISOString() ?? null,
    nodeCount: version.nodes.length,
    prerequisiteCount: version.prerequisites.length,
    aggregateVersion,
  };
}

export class GetTaxonomyVersionQuery implements Handler<GetTaxonomyVersion, TaxonomyVersionDetailView> {
  readonly name = 'GetTaxonomyVersion';
  readonly policy = policy('GetTaxonomyVersion', READER);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(
    query: GetTaxonomyVersion,
    context: ApplicationContext,
  ): Promise<Result<TaxonomyVersionDetailView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.versions.findById(query.taxonomyVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    return ok({
      ...toVersionView(loaded.value.aggregate, loaded.value.aggregateVersion),
      nodes: loaded.value.aggregate.nodes.map(toNodeView),
    });
  }
}

export class ListTaxonomyVersionsQuery implements Handler<ListTaxonomyVersions, readonly TaxonomyVersionView[]> {
  readonly name = 'ListTaxonomyVersions';
  readonly policy = policy('ListTaxonomyVersions', READER);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(
    query: ListTaxonomyVersions,
    context: ApplicationContext,
  ): Promise<Result<readonly TaxonomyVersionView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const found = await this.deps.versions.listByExamFamily(query.examFamily);
    return ok(found.map((stored) => toVersionView(stored.aggregate, stored.aggregateVersion)));
  }
}

export class GetConceptSubtreeQuery implements Handler<GetConceptSubtree, ConceptSubtreeView> {
  readonly name = 'GetConceptSubtree';
  readonly policy = policy('GetConceptSubtree', READER);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(
    query: GetConceptSubtree,
    context: ApplicationContext,
  ): Promise<Result<ConceptSubtreeView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.versions.findById(query.taxonomyVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const version = loaded.value.aggregate;
    const root = version.nodeById(query.rootNodeId);
    if (root === undefined) {
      return err({
        kind: 'NotFound',
        code: 'CONCEPT_NODE_NOT_FOUND',
        message: `node ${query.rootNodeId} is not in version ${query.taxonomyVersionId}`,
      });
    }

    const collected: ConceptNode[] = [root];
    const frontier: ConceptNode[] = [root];
    while (frontier.length > 0) {
      const node = frontier.shift() as ConceptNode;
      if (query.depthLimit !== undefined && node.depth - root.depth >= query.depthLimit) continue;

      for (const child of version.childrenOf(node.conceptNodeId)) {
        collected.push(child);
        frontier.push(child);
      }
    }

    return ok({
      rootNodeId: root.conceptNodeId,
      depthLimit: query.depthLimit ?? null,
      nodes: collected.map(toNodeView),
    });
  }
}

export class GetConceptPrerequisitesQuery
  implements Handler<GetConceptPrerequisites, ConceptPrerequisiteView>
{
  readonly name = 'GetConceptPrerequisites';
  readonly policy = policy('GetConceptPrerequisites', READER);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(
    query: GetConceptPrerequisites,
    context: ApplicationContext,
  ): Promise<Result<ConceptPrerequisiteView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.versions.findById(query.taxonomyVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const edges = loaded.value.aggregate.prerequisites;
    return ok({
      conceptIdentityId: query.conceptIdentityId,
      requires: edges
        .filter((edge) => edge.toConceptIdentityId === query.conceptIdentityId)
        .map((edge) => ({ conceptIdentityId: edge.fromConceptIdentityId, strength: edge.strength })),
      requiredBy: edges
        .filter((edge) => edge.fromConceptIdentityId === query.conceptIdentityId)
        .map((edge) => ({ conceptIdentityId: edge.toConceptIdentityId, strength: edge.strength })),
    });
  }
}

export class GetExamProfileVersionQuery
  implements Handler<GetExamProfileVersion, ExamProfileVersionView>
{
  readonly name = 'GetExamProfileVersion';
  readonly policy = policy('GetExamProfileVersion', READER);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(
    query: GetExamProfileVersion,
    context: ApplicationContext,
  ): Promise<Result<ExamProfileVersionView, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.profiles.findById(query.profileVersionId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    const profile = loaded.value.aggregate;
    return ok({
      profileVersionId: profile.profileVersionId,
      examId: profile.examId,
      academicYear: profile.academicYear,
      state: profile.state,
      taxonomyVersionId: profile.taxonomyVersionId,
      totalMarks: profile.totalMarks,
      markingRuleSetHash: profile.markingRuleSetHash ?? null,
      markingRuleSet: profile.markingRuleSet.toData(),
      sections: profile.sections.map((section) => ({
        ordinal: section.ordinal,
        name: section.name,
        subject: section.subject,
        itemCount: section.itemCount,
        itemTypeMix: section.itemTypeMix,
        maxMarks: section.maxMarks,
        sectionTimingMinutes: section.sectionTiming?.durationMinutes ?? null,
      })),
      itemTypeAllowances: profile.itemTypeAllowances.map((allowance) => ({
        itemType: allowance.itemType,
        sectionOrdinals: [...allowance.sectionOrdinals],
      })),
      aggregateVersion: loaded.value.aggregateVersion,
    });
  }
}

export class ListExamsQuery implements Handler<ListExams, readonly ExamView[]> {
  readonly name = 'ListExams';
  readonly policy = policy('ListExams', READER);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(
    query: ListExams,
    context: ApplicationContext,
  ): Promise<Result<readonly ExamView[], ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const found = await this.deps.exams.list();
    const views = found.map((stored) => ({
      examId: stored.aggregate.examId,
      code: stored.aggregate.code,
      displayName: stored.aggregate.displayName,
      jurisdiction: stored.aggregate.jurisdiction,
      conductingBody: stored.aggregate.conductingBody,
      activeProfileVersions: [...stored.aggregate.activeProfileVersions.entries()].map(
        ([academicYear, profileVersionId]) => ({ academicYear, profileVersionId }),
      ),
    }));

    return ok(query.limit === undefined ? views : views.slice(0, query.limit));
  }
}

export class GetMigrationDryRunQuery implements Handler<GetMigrationDryRun, MigrationDryRunResult | null> {
  readonly name = 'GetMigrationDryRun';
  readonly policy = policy('GetMigrationDryRun', CURRICULUM_STAFF);

  constructor(private readonly deps: CurriculumQueryDependencies) {}

  async handle(
    query: GetMigrationDryRun,
    context: ApplicationContext,
  ): Promise<Result<MigrationDryRunResult | null, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return permitted;

    const loaded = await this.deps.migrations.findById(query.migrationId);
    if (!loaded.ok) return err(toApplicationError(loaded.error));

    return ok(loaded.value.dryRunResult);
  }
}

export function curriculumQueries(
  deps: CurriculumQueryDependencies,
): readonly Handler<never, unknown>[] {
  return [
    new GetTaxonomyVersionQuery(deps),
    new ListTaxonomyVersionsQuery(deps),
    new GetConceptSubtreeQuery(deps),
    new GetConceptPrerequisitesQuery(deps),
    new GetExamProfileVersionQuery(deps),
    new ListExamsQuery(deps),
    new GetMigrationDryRunQuery(deps),
  ] as unknown as readonly Handler<never, unknown>[];
}
