import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { loadProfileFile, parseProfileFile, type ProfileFile, type ProfileLoaderDependencies } from '../profile-loader.js';
import { loadTaxonomyFile } from '../taxonomy-loader.js';
import { derivedIdentifier } from '../taxonomy-loader.spec.js';
import { connectTestDatabase, type TestDatabase } from '../../../apps/api/src/testing/database.js';
import { DrizzleConceptIdentityRepository } from '../../../apps/api/src/contexts/curriculum/infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../../apps/api/src/contexts/curriculum/infrastructure/taxonomy-version.repository.js';
import { DrizzleExamRepository } from '../../../apps/api/src/contexts/curriculum/infrastructure/exam.repository.js';
import { DrizzleExamProfileVersionRepository } from '../../../apps/api/src/contexts/curriculum/infrastructure/exam-profile-version.repository.js';
import goldenHashes from '../../../apps/api/src/testing/golden/marking-rule-set-hashes.json' with { type: 'json' };

const DATA = dirname(fileURLToPath(import.meta.url));
const profileContents = readFileSync(join(DATA, 'jee-main-2026.profile.yaml'), 'utf8');
const taxonomyContents = readFileSync(join(DATA, 'jee-main-2026.taxonomy.yaml'), 'utf8');

const owner: PrincipalRef = {
  kind: 'human',
  id: '019fd4bc-0000-7000-8000-00000000000b',
  roleContext: ['exam_owner'],
};

let database: TestDatabase;
let deps: ProfileLoaderDependencies;
let versions: DrizzleTaxonomyVersionRepository;
let profiles: DrizzleExamProfileVersionRepository;

function parsed(): ProfileFile {
  const outcome = parseProfileFile(profileContents);
  if (!outcome.ok) throw new Error(`profile does not parse: ${JSON.stringify(outcome.issues)}`);
  return outcome.file;
}

/** Loads the JEE taxonomy and publishes it, which the profile requires. */
async function publishTaxonomy(): Promise<void> {
  const loaded = await loadTaxonomyFile(taxonomyContents, {
    versions,
    identities: new DrizzleConceptIdentityRepository(database.db),
    identifierFor: derivedIdentifier,
  });
  if (!loaded.ok) throw new Error(`taxonomy load failed: ${JSON.stringify(loaded.issues.slice(0, 2))}`);

  const stored = await versions.findById(loaded.report.taxonomyVersionId);
  if (!stored.ok) throw new Error('taxonomy not found after load');

  const published = stored.value.aggregate.publish(owner, new Date('2026-08-05T10:00:00.000Z'));
  if (!published.ok) throw new Error(`taxonomy publication failed: ${published.error.message}`);
  await versions.update(published.value, stored.value.aggregateVersion);
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
  deps = {
    exams: new DrizzleExamRepository(database.db),
    profiles,
    versions,
    identifierFor: derivedIdentifier,
    publishedBy: owner,
    publishedAt: new Date('2026-08-05T11:00:00.000Z'),
  };
});

afterAll(async () => {
  await database.close();
});

describe('JEE Main 2026 profile shape', () => {
  it('validates against the profile schema', () => {
    expect(parseProfileFile(profileContents).ok).toBe(true);
  });

  it('declares three sections of 25 items, 20 MCQ and 5 numeric', () => {
    const file = parsed();

    expect(file.sections.map((section) => section.subject)).toEqual(['physics', 'chemistry', 'mathematics']);
    for (const section of file.sections) {
      expect(section.itemCount, section.name).toBe(25);
      expect(section.itemTypeMix['SINGLE_CORRECT_MCQ'], section.name).toBe(20);
      expect(section.itemTypeMix['NUMERIC'], section.name).toBe(5);
    }
  });

  it('adds up: 75 items, 300 marks, 100 per section', () => {
    const file = parsed();

    expect(file.sections.reduce((total, section) => total + section.itemCount, 0)).toBe(75);
    expect(file.sections.reduce((total, section) => total + section.maxMarks, 0)).toBe(file.totalMarks);
    expect(file.totalMarks).toBe(300);
    for (const section of file.sections) expect(section.maxMarks).toBe(100);
  });

  it('runs a single 180-minute timer with free navigation', () => {
    const file = parsed();

    expect(file.timingPolicy.totalDurationMinutes).toBe(180);
    expect(file.timingPolicy.sectionLocking).toBe(false);
    expect(file.navigationPolicy.crossSectionNavigation).toBe(true);
    expect(file.sections.every((section) => section.sectionTimingMinutes === undefined)).toBe(true);
  });

  it('uses the JEE Main marking set, ALWAYS-terminated', () => {
    const rules = parsed().markingRuleSet.rules;

    expect(rules).toHaveLength(4);
    expect(rules.map((rule) => rule.condition.kind)).toEqual([
      'UNATTEMPTED',
      'EXACT_MATCH',
      'NO_MATCH',
      'ALWAYS',
    ]);
    expect(rules.map((rule) => (rule.award.kind === 'FULL_MARKS' ? null : rule.award.marks))).toEqual([0, 4, -1, 0]);
  });

  it('never penalises an unanticipated response state', () => {
    const terminal = parsed().markingRuleSet.rules.at(-1);

    expect(terminal?.condition.kind).toBe('ALWAYS');
    expect(terminal?.award).toEqual({ kind: 'FIXED', marks: 0 });
  });

  it('provides tolerance defaults for numeric items', () => {
    const tolerance = parsed().toleranceDefault;

    expect(tolerance?.comparisonMode).toBe('ABSOLUTE_TOLERANCE');
    expect(tolerance?.toleranceValue).toBe('0.01');
    expect(tolerance?.acceptedForms).toEqual(['DECIMAL', 'SCIENTIFIC']);
  });
});

describe('loading and publishing', () => {
  it('publishes with every precondition satisfied', async () => {
    await publishTaxonomy();

    const outcome = await loadProfileFile(profileContents, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const stored = await profiles.findById(outcome.report.profileVersionId);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.aggregate.state).toBe('published');
    expect(stored.value.aggregate.sections).toHaveLength(3);
    expect(stored.value.aggregate.totalMarks).toBe(300);
    expect(stored.value.aggregate.publishedBy?.id).toBe(owner.id);
  }, 60_000);

  it('refuses to publish before the taxonomy is published', async () => {
    const outcome = await loadProfileFile(profileContents, deps);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.issues[0]?.message).toContain('no published taxonomy version');
  });

  it('matches the committed golden marking-rule-set hash', async () => {
    await publishTaxonomy();

    const outcome = await loadProfileFile(profileContents, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.markingRuleSetHash).toBe(goldenHashes.jeeMain2026Profile);
  }, 60_000);

  it('is idempotent', async () => {
    await publishTaxonomy();
    await loadProfileFile(profileContents, deps);

    const second = await loadProfileFile(profileContents, deps);

    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.report.unchanged).toBe(true);

    const rows = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM curriculum.exam_profile_version`,
    );
    expect(rows.rows[0]?.count).toBe('1');
  }, 60_000);

  it('activates the version for its academic year', async () => {
    await publishTaxonomy();
    const outcome = await loadProfileFile(profileContents, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const exam = await deps.exams.findById(outcome.report.examId);
    expect(exam.ok).toBe(true);
    if (!exam.ok) return;
    expect(exam.value.aggregate.activeProfileVersionFor('2026')).toBe(outcome.report.profileVersionId);
  }, 60_000);
});
