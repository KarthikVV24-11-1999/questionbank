import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { ConceptIdentity } from '../../domain/concept-identity.js';
import { ConceptNode } from '../../domain/concept-node.js';
import { PrerequisiteEdge } from '../../domain/prerequisite-edge.js';
import { TaxonomyVersion } from '../../domain/taxonomy-version.js';
import { Exam } from '../../domain/exam.js';
import { ExamProfileVersion } from '../../domain/exam-profile-version.js';
import { TaxonomyMigration } from '../../domain/taxonomy-migration.js';
import { TaxonomyMapping } from '../../domain/taxonomy-mapping.js';
import { runMigrationDryRun } from '../../domain/migration-dry-run.js';
import { DrizzleConceptIdentityRepository } from '../../infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../infrastructure/taxonomy-version.repository.js';
import { DrizzleExamRepository } from '../../infrastructure/exam.repository.js';
import { DrizzleExamProfileVersionRepository } from '../../infrastructure/exam-profile-version.repository.js';
import { DrizzleTaxonomyMigrationRepository } from '../../infrastructure/taxonomy-migration.repository.js';
import { HandlerRegistry } from '../handler-registry.js';
import type { ApplicationContext } from '../ports.js';
import {
  GetConceptPrerequisitesQuery,
  GetConceptSubtreeQuery,
  GetExamProfileVersionQuery,
  GetMigrationDryRunQuery,
  GetTaxonomyVersionQuery,
  ListExamsQuery,
  ListTaxonomyVersionsQuery,
  curriculumQueries,
  type CurriculumQueryDependencies,
} from './curriculum-queries.js';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { jeeMainProfileProps } from '../../../../testing/profile-fixtures.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

let database: TestDatabase;
let deps: CurriculumQueryDependencies;
let versionId: string;
let nodeIds: Record<string, string>;
let conceptIds: Record<string, string>;
let examId: string;
let profileVersionId: string;

const staff: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['curriculum_curator'] };
const learner: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['learner'] };
const stranger: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['support_agent'] };

function contextFor(principal: PrincipalRef): ApplicationContext {
  return { principal, stepUpSatisfied: false, correlationId: 'corr_query' };
}

/** Physics → Mechanics → Kinematics, plus one prerequisite edge. */
async function seedTaxonomy(): Promise<void> {
  const identities = new DrizzleConceptIdentityRepository(database.db);
  const versions = new DrizzleTaxonomyVersionRepository(database.db);
  versionId = randomUUID();

  let version = expectValue(
    TaxonomyVersion.createDraft({ taxonomyVersionId: versionId, examFamily: 'JEE', academicYear: '2026' }),
  );
  expectValue(await versions.insert(version));

  conceptIds = {};
  nodeIds = {};
  let parent: ConceptNode | undefined;
  for (const name of ['Physics', 'Mechanics', 'Kinematics']) {
    const identity = expectValue(
      ConceptIdentity.create({
        conceptIdentityId: randomUUID(),
        canonicalName: name,
        subjectDomain: 'physics',
        createdInVersion: versionId,
      }),
    );
    expectValue(await identities.insert(identity));
    conceptIds[name] = identity.conceptIdentityId;

    const props = {
      conceptNodeId: randomUUID(),
      conceptIdentityId: identity.conceptIdentityId,
      displayName: name,
      examWeight: 0.5,
      estimatedTeachingHours: 10,
    };
    const node =
      parent === undefined
        ? expectValue(ConceptNode.createRoot({ ...props, examWeight: 1 }))
        : expectValue(ConceptNode.createUnder(parent, props));
    parent = node;
    nodeIds[name] = node.conceptNodeId;
    version = expectValue(version.addConceptNode(node, identity));
  }

  version = expectValue(
    version.addPrerequisiteEdge(
      expectValue(
        PrerequisiteEdge.create({
          fromConceptIdentityId: conceptIds['Mechanics'] as string,
          toConceptIdentityId: conceptIds['Kinematics'] as string,
          strength: 0.9,
        }),
      ),
    ),
  );
  expectValue(await versions.update(version, 1));

  const published = expectValue(version.publish(staff, new Date('2026-08-05T08:00:00.000Z')));
  expectValue(await versions.update(published, 2));
}

async function seedProfile(): Promise<void> {
  const exams = new DrizzleExamRepository(database.db);
  const profiles = new DrizzleExamProfileVersionRepository(database.db);

  const exam = expectValue(
    Exam.create({
      examId: randomUUID(),
      code: 'JEE_MAIN',
      displayName: 'JEE Main',
      jurisdiction: 'IN',
      conductingBody: 'NTA',
    }),
  );
  expectValue(await exams.insert(exam));
  examId = exam.examId;

  profileVersionId = randomUUID();
  const profile = expectValue(
    ExamProfileVersion.createDraft(
      jeeMainProfileProps({ profileVersionId, examId, taxonomyVersionId: versionId }),
    ),
  );
  const published = expectValue(
    profile.publish({
      taxonomyVersionIsPublished: true,
      publishedBy: staff,
      publishedAt: new Date('2026-08-05T09:00:00.000Z'),
    }),
  );
  expectValue(await profiles.insert(published, true));
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

beforeEach(async () => {
  await database.truncateAll();
  deps = {
    versions: new DrizzleTaxonomyVersionRepository(database.db),
    exams: new DrizzleExamRepository(database.db),
    profiles: new DrizzleExamProfileVersionRepository(database.db),
    migrations: new DrizzleTaxonomyMigrationRepository(database.db),
  };
  await seedTaxonomy();
  await seedProfile();
});

afterAll(async () => {
  await database.close();
});

describe('query registry', () => {
  it('registers all seven queries, each with a policy', () => {
    const registry = HandlerRegistry.of(curriculumQueries(deps));

    expect(registry.names).toEqual([
      'GetTaxonomyVersion',
      'ListTaxonomyVersions',
      'GetConceptSubtree',
      'GetConceptPrerequisites',
      'GetExamProfileVersion',
      'ListExams',
      'GetMigrationDryRun',
    ]);
    for (const name of registry.names) {
      expect(registry.get(name)?.policy.allowedRoles.length).toBeGreaterThan(0);
    }
  });
});

describe('authorization negative paths', () => {
  it('denies every query to a principal with no curriculum role', async () => {
    const context = contextFor(stranger);

    expect(expectError(await new GetTaxonomyVersionQuery(deps).handle({ taxonomyVersionId: versionId }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new ListTaxonomyVersionsQuery(deps).handle({ examFamily: 'JEE' }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new GetConceptSubtreeQuery(deps).handle({ taxonomyVersionId: versionId, rootNodeId: nodeIds['Physics'] as string }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new GetConceptPrerequisitesQuery(deps).handle({ taxonomyVersionId: versionId, conceptIdentityId: conceptIds['Kinematics'] as string }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new GetExamProfileVersionQuery(deps).handle({ profileVersionId }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new ListExamsQuery(deps).handle({}, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new GetMigrationDryRunQuery(deps).handle({ migrationId: randomUUID() }, context)).code).toBe('NOT_PERMITTED');
  });

  it('denies the migration dry run to a learner but allows the taxonomy read', async () => {
    const context = contextFor(learner);

    expect(expectError(await new GetMigrationDryRunQuery(deps).handle({ migrationId: randomUUID() }, context)).code).toBe('NOT_PERMITTED');
    expect(expectValue(await new GetTaxonomyVersionQuery(deps).handle({ taxonomyVersionId: versionId }, context)).nodeCount).toBe(3);
  });
});

describe('taxonomy queries', () => {
  it('projects a version as a DTO, not an aggregate', async () => {
    const view = expectValue(
      await new GetTaxonomyVersionQuery(deps).handle({ taxonomyVersionId: versionId }, contextFor(staff)),
    );

    expect(view).toMatchObject({
      taxonomyVersionId: versionId,
      examFamily: 'JEE',
      academicYear: '2026',
      state: 'published',
      nodeCount: 3,
      prerequisiteCount: 1,
      aggregateVersion: 3,
    });
    expect(view.publishedAt).toBe('2026-08-05T08:00:00.000Z');
    expect(view.nodes[0]).toEqual({
      conceptNodeId: nodeIds['Physics'],
      conceptIdentityId: conceptIds['Physics'],
      parentNodeId: null,
      displayName: 'Physics',
      examWeight: 1,
      depth: 0,
      estimatedTeachingHours: 10,
    });
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it('lists versions of an exam family', async () => {
    const views = expectValue(
      await new ListTaxonomyVersionsQuery(deps).handle({ examFamily: 'JEE' }, contextFor(staff)),
    );

    expect(views).toHaveLength(1);
    expect(views[0]?.state).toBe('published');
    expect(
      expectValue(await new ListTaxonomyVersionsQuery(deps).handle({ examFamily: 'NEET' }, contextFor(staff))),
    ).toEqual([]);
  });

  it('reports an unknown version', async () => {
    expect(
      expectError(
        await new GetTaxonomyVersionQuery(deps).handle({ taxonomyVersionId: randomUUID() }, contextFor(staff)),
      ).kind,
    ).toBe('NotFound');
  });
});

describe('subtree query', () => {
  it('returns the whole subtree by default', async () => {
    const view = expectValue(
      await new GetConceptSubtreeQuery(deps).handle(
        { taxonomyVersionId: versionId, rootNodeId: nodeIds['Physics'] as string },
        contextFor(staff),
      ),
    );

    expect(view.nodes.map((node) => node.displayName)).toEqual(['Physics', 'Mechanics', 'Kinematics']);
    expect(view.depthLimit).toBeNull();
  });

  it('limits depth when asked', async () => {
    const view = expectValue(
      await new GetConceptSubtreeQuery(deps).handle(
        { taxonomyVersionId: versionId, rootNodeId: nodeIds['Physics'] as string, depthLimit: 1 },
        contextFor(staff),
      ),
    );

    expect(view.nodes.map((node) => node.displayName)).toEqual(['Physics', 'Mechanics']);
  });

  it('returns only the root at depth limit 0', async () => {
    const view = expectValue(
      await new GetConceptSubtreeQuery(deps).handle(
        { taxonomyVersionId: versionId, rootNodeId: nodeIds['Physics'] as string, depthLimit: 0 },
        contextFor(staff),
      ),
    );

    expect(view.nodes).toHaveLength(1);
  });

  it('can start from a node that is not the root', async () => {
    const view = expectValue(
      await new GetConceptSubtreeQuery(deps).handle(
        { taxonomyVersionId: versionId, rootNodeId: nodeIds['Mechanics'] as string },
        contextFor(staff),
      ),
    );

    expect(view.nodes.map((node) => node.displayName)).toEqual(['Mechanics', 'Kinematics']);
  });

  it('reports an unknown root node', async () => {
    expect(
      expectError(
        await new GetConceptSubtreeQuery(deps).handle(
          { taxonomyVersionId: versionId, rootNodeId: randomUUID() },
          contextFor(staff),
        ),
      ).code,
    ).toBe('CONCEPT_NODE_NOT_FOUND');
  });
});

describe('prerequisite query', () => {
  it('separates what a concept requires from what requires it', async () => {
    const kinematics = expectValue(
      await new GetConceptPrerequisitesQuery(deps).handle(
        { taxonomyVersionId: versionId, conceptIdentityId: conceptIds['Kinematics'] as string },
        contextFor(staff),
      ),
    );
    const mechanics = expectValue(
      await new GetConceptPrerequisitesQuery(deps).handle(
        { taxonomyVersionId: versionId, conceptIdentityId: conceptIds['Mechanics'] as string },
        contextFor(staff),
      ),
    );

    expect(kinematics.requires).toEqual([{ conceptIdentityId: conceptIds['Mechanics'], strength: 0.9 }]);
    expect(kinematics.requiredBy).toEqual([]);
    expect(mechanics.requiredBy).toEqual([{ conceptIdentityId: conceptIds['Kinematics'], strength: 0.9 }]);
  });
});

describe('exam profile queries', () => {
  it('projects a profile with its sections in ordinal order', async () => {
    const view = expectValue(
      await new GetExamProfileVersionQuery(deps).handle({ profileVersionId }, contextFor(staff)),
    );

    expect(view.sections.map((section) => section.ordinal)).toEqual([1, 2, 3]);
    expect(view.totalMarks).toBe(300);
    expect(view.markingRuleSetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(view.state).toBe('published');
    expect(JSON.parse(JSON.stringify(view))).toEqual(view);
  });

  it('lists exams with their active profile versions', async () => {
    const views = expectValue(await new ListExamsQuery(deps).handle({}, contextFor(staff)));

    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ code: 'JEE_MAIN', examId });
    expect(views[0]?.activeProfileVersions).toEqual([{ academicYear: '2026', profileVersionId }]);
  });

  it('applies a limit to the exam list', async () => {
    expect(expectValue(await new ListExamsQuery(deps).handle({ limit: 0 }, contextFor(staff)))).toEqual([]);
  });
});

describe('migration dry-run query', () => {
  it('returns the stored dry run', async () => {
    const migrations = new DrizzleTaxonomyMigrationRepository(database.db);
    const otherVersion = randomUUID();
    expectValue(
      await deps.versions.insert(
        expectValue(
          TaxonomyVersion.createDraft({
            taxonomyVersionId: otherVersion,
            examFamily: 'JEE',
            academicYear: '2027',
          }),
        ),
      ),
    );

    const migration = expectValue(
      TaxonomyMigration.create({
        migrationId: randomUUID(),
        fromVersionId: versionId,
        toVersionId: otherVersion,
        sourceConcepts: Object.values(conceptIds),
        targetConcepts: [],
      }),
    );
    const withMapping = expectValue(
      migration.addMapping(
        expectValue(
          TaxonomyMapping.create({ kind: 'REMOVAL', from: [conceptIds['Kinematics'] as string], to: [] }),
        ),
      ),
    );
    expectValue(await migrations.insert(withMapping));
    expectValue(await migrations.update(withMapping, 1, runMigrationDryRun(withMapping)));

    const view = expectValue(
      await new GetMigrationDryRunQuery(deps).handle(
        { migrationId: migration.migrationId },
        contextFor(staff),
      ),
    );

    expect(view?.exceptions.map((exception) => exception.kind)).toEqual([
      'AMBIGUOUS_MAPPING',
      'UNMAPPED',
      'UNMAPPED',
    ]);
  });

  it('reports an unknown migration', async () => {
    expect(
      expectError(
        await new GetMigrationDryRunQuery(deps).handle({ migrationId: randomUUID() }, contextFor(staff)),
      ).kind,
    ).toBe('NotFound');
  });
});
