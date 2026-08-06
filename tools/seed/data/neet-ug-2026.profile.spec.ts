import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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
const REPO_ROOT = resolve(DATA, '../../..');
const profileContents = readFileSync(join(DATA, 'neet-ug-2026.profile.yaml'), 'utf8');
const taxonomyContents = readFileSync(join(DATA, 'neet-ug-2026.taxonomy.yaml'), 'utf8');

/**
 * The NEET UG change itself: the commit that added it and the commit it was
 * added on top of. The assertion is about that change, not about everything
 * that has landed since.
 */
const PRE_NEET_COMMIT = '5739889bf54436aded0d067974a43622605f8294';
const NEET_COMMIT = '5c03b707c68baaa316001b82d970e70fe3be4df2';

const owner: PrincipalRef = {
  kind: 'human',
  id: '019fd4bc-0000-7000-8000-00000000000c',
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

function filesChangedByTheNeetCommit(): string[] {
  return execFileSync('git', ['diff', '--name-only', PRE_NEET_COMMIT, NEET_COMMIT], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  })
    .split('\n')
    .filter((line) => line.trim() !== '');
}

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

describe('NEET UG 2026 profile shape', () => {
  it('declares 180 items: Physics 45, Chemistry 45, Biology 90', () => {
    const file = parsed();

    expect(file.sections.map((section) => section.itemCount)).toEqual([45, 45, 90]);
    expect(file.sections.reduce((total, section) => total + section.itemCount, 0)).toBe(180);
    expect(file.sections.map((section) => section.subject)).toEqual(['physics', 'chemistry', 'biology']);
  });

  it('totals 720 marks over 200 minutes', () => {
    const file = parsed();

    expect(file.totalMarks).toBe(720);
    expect(file.sections.reduce((total, section) => total + section.maxMarks, 0)).toBe(720);
    expect(file.timingPolicy.totalDurationMinutes).toBe(200);
  });

  it('permits single-correct MCQ only', () => {
    const file = parsed();

    for (const section of file.sections) {
      expect(Object.keys(section.itemTypeMix), section.name).toEqual(['SINGLE_CORRECT_MCQ']);
    }
    expect(file.itemTypeAllowances.map((allowance) => allowance.itemType)).toEqual(['SINGLE_CORRECT_MCQ']);
  });

  it('carries the same marking set as JEE Main, ALWAYS-terminated', () => {
    const rules = parsed().markingRuleSet.rules;

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

    expect(terminal?.award).toEqual({ kind: 'FIXED', marks: 0 });
  });
});

describe('EXT-01: a new exam is configuration alone', () => {
  it('publishes successfully', async () => {
    await publishTaxonomy();

    const outcome = await loadProfileFile(profileContents, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const stored = await profiles.findById(outcome.report.profileVersionId);
    expect(stored.ok).toBe(true);
    if (!stored.ok) return;
    expect(stored.value.aggregate.state).toBe('published');
    expect(stored.value.aggregate.totalMarks).toBe(720);
    expect(stored.value.aggregate.sections.map((section) => section.itemCount)).toEqual([45, 45, 90]);
  }, 60_000);

  it('hashes to the same rule set as the ASSESSMENT-ENGINE reference set', async () => {
    await publishTaxonomy();

    const outcome = await loadProfileFile(profileContents, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // NEET's marking is the §2.4 set exactly, so it hashes identically.
    expect(outcome.report.markingRuleSetHash).toBe(goldenHashes.jeeMain);
  }, 60_000);

  it('touches only files under tools/seed/data', () => {
    const changed = filesChangedByTheNeetCommit();

    expect(changed.length).toBeGreaterThan(0);
    for (const file of changed) {
      expect(file.startsWith('tools/seed/data/'), file).toBe(true);
    }
  });

  it('requires no schema migration', () => {
    expect(filesChangedByTheNeetCommit().filter((file) => file.startsWith('infra/migrations/'))).toEqual([]);
  });

  it('changes no application, domain or infrastructure code', () => {
    const changed = filesChangedByTheNeetCommit();

    expect(changed.filter((file) => file.startsWith('apps/'))).toEqual([]);
    expect(changed.filter((file) => file.startsWith('packages/'))).toEqual([]);
  });

  it('reuses the exact tables JEE Main uses', async () => {
    await publishTaxonomy();
    const outcome = await loadProfileFile(profileContents, deps);
    expect(outcome.ok).toBe(true);

    const tables = await database.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'curriculum' ORDER BY table_name`,
    );

    // No table is named after an exam, and no new table appeared for NEET.
    expect(tables.rows.map((row) => row.table_name)).toEqual([
      'concept_identity',
      'concept_node',
      'exam',
      'exam_profile_version',
      'exam_section_spec',
      'prerequisite_edge',
      'taxonomy_mapping',
      'taxonomy_migration',
      'taxonomy_version',
    ]);
    expect(tables.rows.some((row) => /neet|jee/iu.test(row.table_name))).toBe(false);
  }, 60_000);
});
