import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { TaxonomyVersion } from '../../domain/taxonomy-version.js';
import { ConceptIdentity } from '../../domain/concept-identity.js';
import { ConceptNode } from '../../domain/concept-node.js';
import { DrizzleExamRepository } from '../../infrastructure/exam.repository.js';
import { DrizzleExamProfileVersionRepository } from '../../infrastructure/exam-profile-version.repository.js';
import { DrizzleConceptIdentityRepository } from '../../infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../infrastructure/taxonomy-version.repository.js';
import { HandlerRegistry } from '../handler-registry.js';
import { InMemoryAuditRecorder, type ApplicationContext } from '../ports.js';
import {
  CreateExamHandler,
  CreateProfileDraftHandler,
  PublishProfileVersionHandler,
  SupersedeProfileVersionHandler,
  UpdateProfileDraftHandler,
  examProfileHandlers,
  type ExamProfileHandlerDependencies,
} from './exam-profile-handlers.js';
import type { CreateProfileDraft } from '../commands/exam-profile-commands.js';
import { FixedClock } from '../../../../testing/in-memory-repositories.js';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { JEE_MAIN_FULL_RULE_SET, MCQ, NUMERIC } from '../../../../testing/profile-fixtures.js';
import { expectError, expectValue } from '../../../../testing/expect-result.js';

let database: TestDatabase;
let deps: ExamProfileHandlerDependencies;
let audit: InMemoryAuditRecorder;
let examId: string;
let taxonomyVersionId: string;

const owner: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['exam_owner'] };
const learner: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['learner'] };

function contextFor(principal: PrincipalRef, stepUpSatisfied = true): ApplicationContext {
  return { principal, stepUpSatisfied, correlationId: 'corr_profile' };
}

function draftCommand(overrides: Partial<CreateProfileDraft> = {}): CreateProfileDraft {
  return {
    examId,
    academicYear: '2026',
    taxonomyVersionId,
    totalMarks: 300,
    sections: [
      { ordinal: 1, name: 'Physics', subject: 'physics', itemCount: 25, itemTypeMix: { [MCQ]: 20, [NUMERIC]: 5 }, maxMarks: 100 },
      { ordinal: 2, name: 'Chemistry', subject: 'chemistry', itemCount: 25, itemTypeMix: { [MCQ]: 20, [NUMERIC]: 5 }, maxMarks: 100 },
      { ordinal: 3, name: 'Mathematics', subject: 'mathematics', itemCount: 25, itemTypeMix: { [MCQ]: 20, [NUMERIC]: 5 }, maxMarks: 100 },
    ],
    timingPolicy: {
      totalDurationMinutes: 180,
      sectionLocking: false,
      warningThresholdsMinutes: [30, 5],
      autoSubmitOnExpiry: true,
    },
    navigationPolicy: {
      crossSectionNavigation: true,
      allowMarkForReview: true,
      allowAnswerChange: true,
      allowClearResponse: true,
    },
    markingRuleSet: JEE_MAIN_FULL_RULE_SET,
    toleranceDefault: {
      expectedValue: '0',
      comparisonMode: 'ABSOLUTE_TOLERANCE',
      toleranceValue: '0.01',
      acceptedForms: ['DECIMAL'],
    },
    itemTypeAllowances: [
      { itemType: MCQ, sectionOrdinals: [1, 2, 3] },
      { itemType: NUMERIC, sectionOrdinals: [1, 2, 3] },
    ],
    ...overrides,
  };
}

/** A published taxonomy version, which publication requires. */
async function publishTaxonomy(): Promise<string> {
  const versionId = randomUUID();
  const identities = new DrizzleConceptIdentityRepository(database.db);
  const versions = new DrizzleTaxonomyVersionRepository(database.db);

  let version = expectValue(
    TaxonomyVersion.createDraft({ taxonomyVersionId: versionId, examFamily: 'JEE', academicYear: '2026' }),
  );
  expectValue(await versions.insert(version));

  const identity = expectValue(
    ConceptIdentity.create({
      conceptIdentityId: randomUUID(),
      canonicalName: 'Physics',
      subjectDomain: 'physics',
      createdInVersion: versionId,
    }),
  );
  expectValue(await identities.insert(identity));

  version = expectValue(
    version.addConceptNode(
      expectValue(
        ConceptNode.createRoot({
          conceptNodeId: randomUUID(),
          conceptIdentityId: identity.conceptIdentityId,
          displayName: 'Physics',
          examWeight: 1,
          estimatedTeachingHours: 300,
        }),
      ),
      identity,
    ),
  );
  expectValue(await versions.update(version, 1));

  const published = expectValue(version.publish(owner, new Date('2026-08-05T08:00:00.000Z')));
  expectValue(await versions.update(published, 2));
  return versionId;
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

beforeEach(async () => {
  await database.truncateAll();
  audit = new InMemoryAuditRecorder();
  deps = {
    exams: new DrizzleExamRepository(database.db),
    profiles: new DrizzleExamProfileVersionRepository(database.db),
    versions: new DrizzleTaxonomyVersionRepository(database.db),
    audit,
    clock: new FixedClock(new Date('2026-08-05T12:00:00.000Z')),
    identifiers: { next: () => randomUUID() },
  };

  const exam = expectValue(
    await new CreateExamHandler(deps).handle(
      { code: 'JEE_MAIN', displayName: 'JEE Main', jurisdiction: 'IN', conductingBody: 'NTA' },
      contextFor(owner),
    ),
  );
  examId = exam.examId;
  taxonomyVersionId = await publishTaxonomy();
});

afterAll(async () => {
  await database.close();
});

describe('exam profile handler registry', () => {
  it('registers all five commands with a policy each', () => {
    const registry = HandlerRegistry.of(examProfileHandlers(deps));

    expect(registry.names).toEqual([
      'CreateExam',
      'CreateProfileDraft',
      'UpdateProfileDraft',
      'PublishProfileVersion',
      'SupersedeProfileVersion',
    ]);
    for (const name of registry.names) {
      expect(registry.get(name)?.policy.allowedRoles.length).toBeGreaterThan(0);
    }
  });

  it('requires step-up on publication and supersession only', () => {
    const registry = HandlerRegistry.of(examProfileHandlers(deps));

    expect(registry.get('PublishProfileVersion')?.policy.requiresStepUp).toBe(true);
    expect(registry.get('SupersedeProfileVersion')?.policy.requiresStepUp).toBe(true);
    expect(registry.get('CreateProfileDraft')?.policy.requiresStepUp).toBe(false);
  });
});

describe('authorization negative paths', () => {
  it('denies every command to a principal without the role', async () => {
    const context = contextFor(learner);

    expect(expectError(await new CreateExamHandler(deps).handle({ code: 'NEET_UG', displayName: 'NEET', jurisdiction: 'IN', conductingBody: 'NTA' }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new CreateProfileDraftHandler(deps).handle(draftCommand(), context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new UpdateProfileDraftHandler(deps).handle({ ...draftCommand(), profileVersionId: 'x', expectedAggregateVersion: 1 }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new PublishProfileVersionHandler(deps).handle({ profileVersionId: 'x', expectedAggregateVersion: 1 }, context)).code).toBe('NOT_PERMITTED');
    expect(expectError(await new SupersedeProfileVersionHandler(deps).handle({ profileVersionId: 'x', expectedAggregateVersion: 1 }, context)).code).toBe('NOT_PERMITTED');
  });

  it('requires step-up to publish', async () => {
    const draft = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));

    const error = expectError(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion },
        contextFor(owner, false),
      ),
    );

    expect(error.code).toBe('STEP_UP_REQUIRED');
    expect(expectValue(await deps.profiles.findById(draft.profileVersionId)).aggregate.state).toBe('draft');
  });

  it('requires step-up to supersede', async () => {
    const draft = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));

    expect(
      expectError(
        await new SupersedeProfileVersionHandler(deps).handle(
          { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion },
          contextFor(owner, false),
        ),
      ).code,
    ).toBe('STEP_UP_REQUIRED');
  });
});

describe('profile lifecycle commands', () => {
  it('creates an exam and audits it', async () => {
    expect(audit.entries[0]).toMatchObject({ action: 'CreateExam', targetType: 'Exam', targetId: examId });
  });

  it('creates, updates and publishes a draft', async () => {
    const draft = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));

    const updated = expectValue(
      await new UpdateProfileDraftHandler(deps).handle(
        {
          ...draftCommand(),
          profileVersionId: draft.profileVersionId,
          expectedAggregateVersion: draft.aggregateVersion,
          timingPolicy: {
            totalDurationMinutes: 200,
            sectionLocking: false,
            warningThresholdsMinutes: [30],
            autoSubmitOnExpiry: true,
          },
        },
        contextFor(owner),
      ),
    );

    const published = expectValue(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: updated.aggregateVersion, activate: true },
        contextFor(owner),
      ),
    );

    const loaded = expectValue(await deps.profiles.findById(draft.profileVersionId));
    expect(loaded.aggregate.state).toBe('published');
    expect(loaded.aggregate.timingPolicy.totalDurationMinutes).toBe(200);
    expect(loaded.aggregate.markingRuleSetHash).toMatch(/^[0-9a-f]{64}$/u);
    expect(loaded.aggregate.publishedBy?.id).toBe(owner.id);
    expect(published.aggregateVersion).toBe(updated.aggregateVersion + 1);
    expect(expectValue(await deps.exams.findById(examId)).aggregate.activeProfileVersionFor('2026')).toBe(
      draft.profileVersionId,
    );
    expect(audit.entries.map((entry) => entry.action)).toEqual([
      'CreateExam',
      'CreateProfileDraft',
      'UpdateProfileDraft',
      'PublishProfileVersion',
    ]);
  });

  it('supersedes a published profile', async () => {
    const draft = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));
    const published = expectValue(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion },
        contextFor(owner),
      ),
    );

    expectValue(
      await new SupersedeProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: published.aggregateVersion },
        contextFor(owner),
      ),
    );

    expect(expectValue(await deps.profiles.findById(draft.profileVersionId)).aggregate.state).toBe(
      'superseded',
    );
  });

  it('rejects an update to a published profile', async () => {
    const draft = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));
    const published = expectValue(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion },
        contextFor(owner),
      ),
    );

    const error = expectError(
      await new UpdateProfileDraftHandler(deps).handle(
        {
          ...draftCommand(),
          profileVersionId: draft.profileVersionId,
          expectedAggregateVersion: published.aggregateVersion,
        },
        contextFor(owner),
      ),
    );

    expect(error.code).toBe('PROFILE_NOT_MUTABLE');
  });
});

describe('publication preconditions leave no partial write', () => {
  it('blocks publication when the blueprint arithmetic is wrong', async () => {
    const draft = expectValue(
      await new CreateProfileDraftHandler(deps).handle(draftCommand({ totalMarks: 299 }), contextFor(owner)),
    );

    const error = expectError(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion },
        contextFor(owner),
      ),
    );

    const loaded = expectValue(await deps.profiles.findById(draft.profileVersionId));
    expect(error.code).toBe('BLUEPRINT_INCONSISTENT');
    expect(loaded.aggregate.state).toBe('draft');
    expect(loaded.aggregate.markingRuleSetHash).toBeUndefined();
    expect(loaded.aggregateVersion).toBe(draft.aggregateVersion);
    expect(audit.entries.some((entry) => entry.action === 'PublishProfileVersion')).toBe(false);
  });

  it('blocks publication when the taxonomy version is still a draft', async () => {
    const unpublished = randomUUID();
    expectValue(
      await deps.versions.insert(
        expectValue(
          TaxonomyVersion.createDraft({
            taxonomyVersionId: unpublished,
            examFamily: 'JEE',
            academicYear: '2026',
          }),
        ),
      ),
    );
    const draft = expectValue(
      await new CreateProfileDraftHandler(deps).handle(
        draftCommand({ taxonomyVersionId: unpublished }),
        contextFor(owner),
      ),
    );

    const error = expectError(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion },
        contextFor(owner),
      ),
    );

    expect(error.code).toBe('TAXONOMY_VERSION_NOT_PUBLISHED');
    expect(expectValue(await deps.profiles.findById(draft.profileVersionId)).aggregate.state).toBe('draft');
  });

  it('blocks publication when an allowed item type has no marking rule', async () => {
    const draft = expectValue(
      await new CreateProfileDraftHandler(deps).handle(
        draftCommand({
          itemTypeAllowances: [
            { itemType: MCQ, sectionOrdinals: [1, 2, 3] },
            { itemType: 'MATCHING', sectionOrdinals: [1] },
          ],
        }),
        contextFor(owner),
      ),
    );

    expect(
      expectError(
        await new PublishProfileVersionHandler(deps).handle(
          { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion },
          contextFor(owner),
        ),
      ).code,
    ).toBe('ITEM_TYPE_WITHOUT_MARKING_RULE');
  });

  it('rejects a second active version for the same academic year', async () => {
    const first = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));
    expectValue(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: first.profileVersionId, expectedAggregateVersion: first.aggregateVersion, activate: true },
        contextFor(owner),
      ),
    );

    const second = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));
    const error = expectError(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: second.profileVersionId, expectedAggregateVersion: second.aggregateVersion, activate: true },
        contextFor(owner),
      ),
    );

    expect(error.code).toBe('ACADEMIC_YEAR_ALREADY_ACTIVE');
    expect(expectValue(await deps.profiles.findById(second.profileVersionId)).aggregate.state).toBe('draft');
  });

  it('rejects a draft whose marking rule set has no terminal ALWAYS', async () => {
    const error = expectError(
      await new CreateProfileDraftHandler(deps).handle(
        draftCommand({
          markingRuleSet: {
            schemaVersion: 1,
            rules: JEE_MAIN_FULL_RULE_SET.rules.slice(0, 2),
          },
        }),
        contextFor(owner),
      ),
    );

    expect(error.code).toBe('MISSING_TERMINAL_ALWAYS');
  });

  it('raises Conflict on a stale expected version', async () => {
    const draft = expectValue(await new CreateProfileDraftHandler(deps).handle(draftCommand(), contextFor(owner)));

    const error = expectError(
      await new PublishProfileVersionHandler(deps).handle(
        { profileVersionId: draft.profileVersionId, expectedAggregateVersion: draft.aggregateVersion + 5 },
        contextFor(owner),
      ),
    );

    expect(error.kind).toBe('Conflict');
    expect(expectValue(await deps.profiles.findById(draft.profileVersionId)).aggregate.state).toBe('draft');
  });
});
