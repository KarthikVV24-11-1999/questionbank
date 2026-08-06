import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { Exam } from '../domain/exam.js';
import { ExamProfileVersion } from '../domain/exam-profile-version.js';
import { TaxonomyVersion } from '../domain/taxonomy-version.js';
import { hashMarkingRuleSet } from '../domain/value-objects/marking-rule-set-hash.js';
import { DrizzleExamRepository } from './exam.repository.js';
import {
  DrizzleExamProfileVersionRepository,
  serializeProfile,
  validateProfileJsonb,
} from './exam-profile-version.repository.js';
import { DrizzleTaxonomyVersionRepository } from './taxonomy-version.repository.js';
import { connectTestDatabase, type TestDatabase } from '../../../testing/database.js';
import { jeeMainProfileProps } from '../../../testing/profile-fixtures.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

let database: TestDatabase;
let exams: DrizzleExamRepository;
let profiles: DrizzleExamProfileVersionRepository;
let versions: DrizzleTaxonomyVersionRepository;
let examId: string;
let taxonomyVersionId: string;

const publisher: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: [] };
const publishedAt = new Date('2026-08-05T12:00:00.000Z');

function anExam(code = 'JEE_MAIN'): Exam {
  return expectValue(
    Exam.create({
      examId: randomUUID(),
      code,
      displayName: 'JEE Main',
      jurisdiction: 'IN',
      conductingBody: 'National Testing Agency',
    }),
  );
}

function draftProfile(overrides = {}): ExamProfileVersion {
  return expectValue(
    ExamProfileVersion.createDraft(
      jeeMainProfileProps({
        profileVersionId: randomUUID(),
        examId,
        taxonomyVersionId,
        ...overrides,
      }),
    ),
  );
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
  exams = new DrizzleExamRepository(database.db);
  profiles = new DrizzleExamProfileVersionRepository(database.db);
  versions = new DrizzleTaxonomyVersionRepository(database.db);
});

beforeEach(async () => {
  await database.truncateAll();
  const exam = anExam();
  expectValue(await exams.insert(exam));
  examId = exam.examId;

  taxonomyVersionId = randomUUID();
  expectValue(
    await versions.insert(
      expectValue(
        TaxonomyVersion.createDraft({ taxonomyVersionId, examFamily: 'JEE', academicYear: '2026' }),
      ),
    ),
  );
});

afterAll(async () => {
  await database.close();
});

describe('Exam repository', () => {
  it('round-trips an exam to a domain-equal object', async () => {
    const loaded = expectValue(await exams.findById(examId));

    expect(loaded.aggregate.code).toBe('JEE_MAIN');
    expect(loaded.aggregate.conductingBody).toBe('National Testing Agency');
    expect(loaded.aggregate.activeProfileVersions.size).toBe(0);
    expect(loaded.aggregateVersion).toBe(1);
  });

  it('projects active profile versions back onto the aggregate', async () => {
    const profile = expectValue(
      draftProfile().publish({ taxonomyVersionIsPublished: true, publishedBy: publisher, publishedAt }),
    );
    expectValue(await profiles.insert(profile, true));

    const loaded = expectValue(await exams.findById(examId));

    expect(loaded.aggregate.activeProfileVersionFor('2026')).toBe(profile.profileVersionId);
  });

  it('raises Conflict on a stale exam write', async () => {
    const loaded = expectValue(await exams.findById(examId));

    expectValue(await exams.update(loaded.aggregate, 1));
    expect(expectError(await exams.update(loaded.aggregate, 1)).code).toBe('CONFLICT');
  });

  it('reports NotFound for an unknown exam', async () => {
    expect(expectError(await exams.findById(randomUUID())).code).toBe('NOT_FOUND');
  });
});

describe('ExamProfileVersion repository round-trip', () => {
  it('preserves rule set semantics and the hash exactly', async () => {
    const profile = expectValue(
      draftProfile().publish({ taxonomyVersionIsPublished: true, publishedBy: publisher, publishedAt }),
    );
    expectValue(await profiles.insert(profile));

    const loaded = expectValue(await profiles.findById(profile.profileVersionId));

    expect(loaded.aggregate.markingRuleSetHash).toBe(profile.markingRuleSetHash);
    expect(hashMarkingRuleSet(loaded.aggregate.markingRuleSet)).toBe(profile.markingRuleSetHash);
    expect(loaded.aggregate.markingRuleSet.toData()).toEqual(profile.markingRuleSet.toData());
    expect(loaded.aggregate.markingRuleSet.ruleIds).toEqual(profile.markingRuleSet.ruleIds);
  });

  it('restores policies, tolerance defaults, allowances and publication stamp', async () => {
    const profile = expectValue(
      draftProfile().publish({ taxonomyVersionIsPublished: true, publishedBy: publisher, publishedAt }),
    );
    expectValue(await profiles.insert(profile));

    const loaded = expectValue(await profiles.findById(profile.profileVersionId));

    expect(loaded.aggregate.timingPolicy.totalDurationMinutes).toBe(180);
    expect(loaded.aggregate.timingPolicy.warningThresholdsMinutes).toEqual([30, 10, 5]);
    expect(loaded.aggregate.navigationPolicy.crossSectionNavigation).toBe(true);
    expect(loaded.aggregate.toleranceDefault?.toleranceValue).toBe('0.01');
    expect(loaded.aggregate.itemTypeAllowances.map((allowance) => allowance.itemType)).toEqual([
      'SINGLE_CORRECT_MCQ',
      'NUMERIC',
    ]);
    expect(loaded.aggregate.state).toBe('published');
    expect(loaded.aggregate.publishedAt?.toISOString()).toBe('2026-08-05T12:00:00.000Z');
    expect(loaded.aggregate.publishedBy?.id).toBe(publisher.id);
    expect(loaded.aggregate.goldenSetValidation).toEqual({ status: 'not_run' });
  });

  it('loads section specs in ordinal order however they were written', async () => {
    const profile = draftProfile();
    const reversed = expectValue(profile.replaceSections([...profile.sections].reverse()));
    expectValue(await profiles.insert(reversed));

    const loaded = expectValue(await profiles.findById(profile.profileVersionId));

    expect(loaded.aggregate.sections.map((section) => section.ordinal)).toEqual([1, 2, 3]);
    expect(loaded.aggregate.sections.map((section) => section.subject)).toEqual([
      'physics',
      'chemistry',
      'mathematics',
    ]);
    expect(loaded.aggregate.sections[0]?.itemTypeMix).toEqual({ SINGLE_CORRECT_MCQ: 20, NUMERIC: 5 });
  });

  it('reports NotFound for an unknown profile', async () => {
    expect(expectError(await profiles.findById(randomUUID())).code).toBe('NOT_FOUND');
  });
});

describe('ExamProfileVersion repository concurrency', () => {
  it('raises Conflict when two writers update the same draft', async () => {
    const profile = draftProfile();
    expectValue(await profiles.insert(profile));

    const first = expectValue(profile.recordGoldenSetValidation({ status: 'passed', caseCount: 12 }));
    const second = expectValue(profile.recordGoldenSetValidation({ status: 'failed', caseCount: 12 }));

    expectValue(await profiles.update(first, 1));
    const conflictError = expectError(await profiles.update(second, 1));

    expect(conflictError.code).toBe('CONFLICT');
    expect(expectValue(await profiles.findById(profile.profileVersionId)).aggregate.goldenSetValidation).toEqual({
      status: 'passed',
      caseCount: 12,
    });
  });

  it('replaces section rows when a draft is updated', async () => {
    const profile = draftProfile();
    expectValue(await profiles.insert(profile));

    const narrowed = expectValue(
      profile.replaceItemTypeAllowances(
        profile.itemTypeAllowances.map((allowance) => ({ ...allowance, sectionOrdinals: [1, 2] })),
      ),
    );
    const trimmed = expectValue(
      narrowed.replaceSections(narrowed.sections.filter((section) => section.ordinal !== 3)),
    );
    expectValue(await profiles.update(trimmed, 1));

    const loaded = expectValue(await profiles.findById(profile.profileVersionId));
    expect(loaded.aggregate.sections).toHaveLength(2);
  });
});

describe('JSONB validation before the write', () => {
  const validPayload = (): ReturnType<typeof serializeProfile> =>
    serializeProfile(
      expectValue(
        ExamProfileVersion.createDraft(
          jeeMainProfileProps({ profileVersionId: randomUUID(), examId, taxonomyVersionId }),
        ),
      ),
    );

  it('accepts the payload a real profile serializes to', () => {
    expect(expectValue(validateProfileJsonb(validPayload()))).toBe(true);
  });

  it.each([
    ['marking_rule_set', { markingRuleSet: { schemaVersion: 1, rules: [] } }],
    ['marking_rule_set', { markingRuleSet: { schemaVersion: 0, rules: [] } }],
    ['timing_policy', { timingPolicy: { totalDurationMinutes: 0, sectionLocking: false, warningThresholdsMinutes: [], autoSubmitOnExpiry: true } }],
    ['tolerance_defaults', { toleranceDefaults: { expectedValue: 'not a number', comparisonMode: 'EXACT', acceptedForms: ['DECIMAL'] } }],
    ['item_type_allowances', { itemTypeAllowances: [{ itemType: 42 }] }],
    ['golden_set_validation', { goldenSetValidation: { status: 'maybe' } }],
  ])('rejects invalid %s before it reaches the database', (column, override) => {
    const error = expectError(validateProfileJsonb({ ...validPayload(), ...override }));

    expect(error.code).toBe('CORRUPT_ROW');
    expect(error.message).toContain(column);
  });

  it('writes nothing when a rule set without a terminal ALWAYS is offered', async () => {
    const profile = draftProfile();
    const payload = serializeProfile(profile);
    const broken = {
      ...payload,
      markingRuleSet: {
        schemaVersion: 1,
        rules: (payload.markingRuleSet as { rules: unknown[] }).rules.slice(0, 1),
      },
    };

    expect(expectError(validateProfileJsonb(broken)).message).toContain('ALWAYS');
    expect(expectError(await profiles.findById(profile.profileVersionId)).code).toBe('NOT_FOUND');
  });
});
