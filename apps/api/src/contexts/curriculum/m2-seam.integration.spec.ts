import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import * as barrel from './public/index.js';
import { ConceptIdentity } from './domain/concept-identity.js';
import { ConceptNode } from './domain/concept-node.js';
import { TaxonomyVersion } from './domain/taxonomy-version.js';
import { ExamProfileVersion } from './domain/exam-profile-version.js';
import { Exam } from './domain/exam.js';
import { MarkingRuleSet } from './domain/value-objects/marking-rule-set.js';
import { hashMarkingRuleSet } from './domain/value-objects/marking-rule-set-hash.js';
import { NumericAnswerSpec } from './domain/value-objects/numeric-answer-spec.js';
import { DrizzleConceptIdentityRepository } from './infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from './infrastructure/taxonomy-version.repository.js';
import { DrizzleExamRepository } from './infrastructure/exam.repository.js';
import { DrizzleExamProfileVersionRepository } from './infrastructure/exam-profile-version.repository.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { JEE_ADVANCED_RULE_SET } from '../../testing/marking-fixtures.js';
import { jeeMainProfileProps } from '../../testing/profile-fixtures.js';
import { expectError, expectValue } from '../../testing/expect-result.js';

/**
 * What M2 — the scoring rule executor — needs from M1. Each of these is a
 * contract the next milestone builds on, so each is asserted here rather than
 * assumed.
 */
const BARREL_PATH = resolve(dirname(fileURLToPath(import.meta.url)), 'public/index.ts');

let database: TestDatabase;
let versions: DrizzleTaxonomyVersionRepository;
let profiles: DrizzleExamProfileVersionRepository;
let exams: DrizzleExamRepository;
let taxonomyVersionId: string;
let examId: string;

const owner: PrincipalRef = { kind: 'human', id: randomUUID(), roleContext: ['exam_owner'] };
const publishedAt = new Date('2026-08-05T12:00:00.000Z');

async function publishedTaxonomy(): Promise<string> {
  const versionId = randomUUID();
  const identities = new DrizzleConceptIdentityRepository(database.db);

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
  expectValue(await versions.update(expectValue(version.publish(owner, publishedAt)), 2));

  return versionId;
}

async function publishedProfile(
  overrides: Parameters<typeof jeeMainProfileProps>[0] = {},
): Promise<ExamProfileVersion> {
  const draft = expectValue(
    ExamProfileVersion.createDraft(
      jeeMainProfileProps({
        profileVersionId: randomUUID(),
        examId,
        taxonomyVersionId,
        ...overrides,
      }),
    ),
  );
  const published = expectValue(
    draft.publish({ taxonomyVersionIsPublished: true, publishedBy: owner, publishedAt }),
  );
  expectValue(await profiles.insert(published, true));
  return published;
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations();
  await database.applyMigrations();
});

beforeEach(async () => {
  await database.truncateAll();
  versions = new DrizzleTaxonomyVersionRepository(database.db);
  profiles = new DrizzleExamProfileVersionRepository(database.db);
  exams = new DrizzleExamRepository(database.db);

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
  taxonomyVersionId = await publishedTaxonomy();
});

afterAll(async () => {
  await database.close();
});

describe('seam 1 — the marking rule set is reachable as a read-only DTO', () => {
  it('exports the rule set, condition and award shapes as types only', () => {
    const source = readFileSync(BARREL_PATH, 'utf8');

    expect(source).toContain('MarkingRuleSetData');
    expect(source).toContain('MarkingRuleData');
    expect(source).toContain("from '../domain/value-objects/condition.js'");
    expect(source).toContain("from '../domain/value-objects/award.js'");
    // Nothing executable escapes: the whole value surface is one constant.
    expect(Object.keys(barrel)).toEqual(['CURRICULUM_EVENT_TYPES']);
  });

  it('exposes no domain class an executor could mutate', () => {
    expect(Object.keys(barrel)).not.toContain('MarkingRuleSet');
    expect(Object.keys(barrel)).not.toContain('ExamProfileVersion');
  });
});

describe('seam 2 — order, schema version and hash survive persistence', () => {
  it('round-trips the rule set with its order, schema version and hash intact', async () => {
    const profile = await publishedProfile();

    const loaded = expectValue(await profiles.findById(profile.profileVersionId));
    const reloaded = loaded.aggregate.markingRuleSet;

    expect(reloaded.ruleIds).toEqual(profile.markingRuleSet.ruleIds);
    expect(reloaded.schemaVersion).toBe(profile.markingRuleSet.schemaVersion);
    expect(reloaded.toData()).toEqual(profile.markingRuleSet.toData());
    expect(loaded.aggregate.markingRuleSetHash).toBe(profile.markingRuleSetHash);
    expect(hashMarkingRuleSet(reloaded)).toBe(profile.markingRuleSetHash);
  });

  it('keeps a seven-rule set in evaluation order through the database', async () => {
    const markingRuleSet = expectValue(MarkingRuleSet.create(JEE_ADVANCED_RULE_SET));
    const profile = await publishedProfile({
      markingRuleSet,
      itemTypeAllowances: [{ itemType: 'MULTIPLE_CORRECT_MCQ', sectionOrdinals: [1, 2, 3] }],
    });

    const loaded = expectValue(await profiles.findById(profile.profileVersionId));

    expect(loaded.aggregate.markingRuleSet.ruleIds).toEqual([
      'unattempted',
      'any-incorrect',
      'all-correct',
      'three-correct',
      'two-correct',
      'one-correct',
      'default',
    ]);
    expect(loaded.aggregate.markingRuleSetHash).toBe(hashMarkingRuleSet(markingRuleSet));
  });

  it('stores the schema version alongside the JSONB, as F5 requires', async () => {
    const profile = await publishedProfile();

    const row = await database.pool.query<{ marking_rule_set_schema_version: number }>(
      `SELECT marking_rule_set_schema_version FROM curriculum.exam_profile_version WHERE profile_version_id = $1`,
      [profile.profileVersionId],
    );

    expect(row.rows[0]?.marking_rule_set_schema_version).toBe(1);
  });
});

describe('seam 3 — NumericAnswerSpec is complete enough to evaluate against', () => {
  it('carries expected value, mode parameters, unit and normalization flags', async () => {
    const profile = await publishedProfile();

    const tolerance = expectValue(await profiles.findById(profile.profileVersionId)).aggregate
      .toleranceDefault;

    expect(tolerance?.expectedValue).toBe('0');
    expect(tolerance?.comparisonMode).toBe('ABSOLUTE_TOLERANCE');
    expect(tolerance?.toleranceValue).toBe('0.01');
    expect(tolerance?.acceptedForms).toEqual(['DECIMAL', 'SCIENTIFIC']);
    expect(tolerance?.normalization).toEqual({
      trimWhitespace: true,
      stripThousandsSeparator: true,
      unicodeMinusToAscii: true,
      caseInsensitiveUnit: true,
    });
  });

  it('preserves the authored decimal literal, which SIGNIFICANT_FIGURES needs', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({
        expectedValue: '9.800',
        comparisonMode: 'SIGNIFICANT_FIGURES',
        significantFigures: 4,
        acceptedForms: ['DECIMAL'],
      }),
    );

    expect(spec.expectedValue).toBe('9.800');
    expect(spec.significantFigures).toBe(4);
  });

  it('carries a unit with its accepted equivalents and required flag', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({
        expectedValue: '9.81',
        comparisonMode: 'EXACT',
        unit: { canonical: 'm/s^2', acceptedEquivalents: ['ms^-2', 'm s^-2'], required: true },
        acceptedForms: ['DECIMAL'],
      }),
    );

    expect(spec.unit).toEqual({
      canonical: 'm/s^2',
      acceptedEquivalents: ['ms^-2', 'm s^-2'],
      required: true,
    });
  });

  it('carries both bounds for a RANGE spec', () => {
    const spec = expectValue(
      NumericAnswerSpec.create({
        expectedValue: '9.8',
        comparisonMode: 'RANGE',
        rangeMin: '9.7',
        rangeMax: '9.9',
        acceptedForms: ['DECIMAL'],
      }),
    );

    expect([spec.rangeMin, spec.rangeMax]).toEqual(['9.7', '9.9']);
  });
});

describe('seam 4 — goldenSetValidation is present and writable', () => {
  it('defaults to not_run and is writable while the profile is a draft', async () => {
    const draft = expectValue(
      ExamProfileVersion.createDraft(
        jeeMainProfileProps({ profileVersionId: randomUUID(), examId, taxonomyVersionId }),
      ),
    );
    expect(draft.goldenSetValidation).toEqual({ status: 'not_run' });

    const recorded = expectValue(
      draft.recordGoldenSetValidation({ status: 'passed', runAt: publishedAt, caseCount: 250 }),
    );

    expect(recorded.goldenSetValidation).toMatchObject({ status: 'passed', caseCount: 250 });
  });

  it('round-trips the recorded result through the database', async () => {
    const draft = expectValue(
      ExamProfileVersion.createDraft(
        jeeMainProfileProps({ profileVersionId: randomUUID(), examId, taxonomyVersionId }),
      ),
    );
    const recorded = expectValue(draft.recordGoldenSetValidation({ status: 'passed', caseCount: 250 }));
    expectValue(await profiles.insert(recorded));

    const loaded = expectValue(await profiles.findById(recorded.profileVersionId));

    expect(loaded.aggregate.goldenSetValidation).toEqual({ status: 'passed', caseCount: 250 });
  });

  it('refuses to rewrite the result once the profile is published', async () => {
    const profile = await publishedProfile();

    const error = expectError(profile.recordGoldenSetValidation({ status: 'failed', caseCount: 1 }));

    expect(error.code).toBe('PROFILE_NOT_MUTABLE');
  });
});

describe('seam 5 — a published profile is immutable under raw SQL', () => {
  it('rejects a raw UPDATE of the rule set a score record would be pinned to', async () => {
    const profile = await publishedProfile();

    await expect(
      database.pool.query(
        `UPDATE curriculum.exam_profile_version SET marking_rule_set = '{}'::jsonb WHERE profile_version_id = $1`,
        [profile.profileVersionId],
      ),
    ).rejects.toThrow(/published_row_is_immutable/u);
  });

  it('rejects a raw UPDATE of the frozen hash', async () => {
    const profile = await publishedProfile();

    await expect(
      database.pool.query(
        `UPDATE curriculum.exam_profile_version SET marking_rule_set_hash = 'tampered' WHERE profile_version_id = $1`,
        [profile.profileVersionId],
      ),
    ).rejects.toThrow(/published_row_is_immutable/u);
  });

  it('rejects a raw DELETE of a published profile', async () => {
    const profile = await publishedProfile();

    await expect(
      database.pool.query(`DELETE FROM curriculum.exam_profile_version WHERE profile_version_id = $1`, [
        profile.profileVersionId,
      ]),
    ).rejects.toThrow(/published_row_is_immutable/u);
  });

  it('rejects a raw UPDATE of a published taxonomy version and its nodes', async () => {
    await expect(
      database.pool.query(
        `UPDATE curriculum.taxonomy_version SET academic_year = '2099' WHERE taxonomy_version_id = $1`,
        [taxonomyVersionId],
      ),
    ).rejects.toThrow(/published_row_is_immutable/u);

    await expect(
      database.pool.query(`UPDATE curriculum.concept_node SET depth = 9 WHERE taxonomy_version_id = $1`, [
        taxonomyVersionId,
      ]),
    ).rejects.toThrow(/published_parent_is_immutable/u);
  });
});
