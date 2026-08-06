import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PrincipalRef } from '@questionbank/domain-types';
import { loadTaxonomyFile, parseTaxonomyFile, type LoaderDependencies, type TaxonomyFile, type TaxonomyFileConcept } from '../taxonomy-loader.js';
import { derivedIdentifier } from '../taxonomy-loader.spec.js';
import { connectTestDatabase, type TestDatabase } from '../../../apps/api/src/testing/database.js';
import { DrizzleConceptIdentityRepository } from '../../../apps/api/src/contexts/curriculum/infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../../apps/api/src/contexts/curriculum/infrastructure/taxonomy-version.repository.js';

const DATA = join(dirname(fileURLToPath(import.meta.url)), 'jee-main-2026.taxonomy.yaml');
const contents = readFileSync(DATA, 'utf8');

const curator: PrincipalRef = {
  kind: 'human',
  id: '019fd4bc-0000-7000-8000-00000000000a',
  roleContext: ['content_ops'],
};

let database: TestDatabase;
let deps: LoaderDependencies;

function parsed(): TaxonomyFile {
  const outcome = parseTaxonomyFile(contents);
  if (!outcome.ok) throw new Error(`dataset does not parse: ${JSON.stringify(outcome.issues.slice(0, 3))}`);
  return outcome.file;
}

function chaptersOf(subjectDomain: string): readonly TaxonomyFileConcept[] {
  const subject = parsed().subjects.find((candidate) => candidate.subjectDomain === subjectDomain);
  return subject?.root.children ?? [];
}

function countConcepts(concept: TaxonomyFileConcept): number {
  return 1 + (concept.children ?? []).reduce((total, child) => total + countConcepts(child), 0);
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
    identities: new DrizzleConceptIdentityRepository(database.db),
    identifierFor: derivedIdentifier,
  };
});

afterAll(async () => {
  await database.close();
});

describe('JEE Main 2026 dataset shape', () => {
  it('passes M1-27 validation', () => {
    expect(parseTaxonomyFile(contents).ok).toBe(true);
  });

  it('covers Physics, Chemistry and Mathematics', () => {
    expect(parsed().subjects.map((subject) => subject.subjectDomain)).toEqual([
      'physics',
      'chemistry',
      'mathematics',
    ]);
  });

  it('holds roughly 600 concepts', () => {
    const total = parsed().subjects.reduce((sum, subject) => sum + countConcepts(subject.root), 0);

    expect(total).toBeGreaterThanOrEqual(550);
    expect(total).toBeLessThanOrEqual(700);
  });

  it('follows the NTA syllabus structure: subject, chapter, topic', () => {
    for (const subject of parsed().subjects) {
      expect(subject.root.children?.length ?? 0).toBeGreaterThanOrEqual(15);
      for (const chapter of subject.root.children ?? []) {
        expect((chapter.children ?? []).length, chapter.key).toBeGreaterThan(0);
        for (const topic of chapter.children ?? []) {
          expect(topic.children, topic.key).toBeUndefined();
        }
      }
    }
  });

  it('names the chapters the syllabus names', () => {
    const physics = chaptersOf('physics').map((chapter) => chapter.displayName);

    expect(physics).toContain('Kinematics');
    expect(physics).toContain('Laws of Motion');
    expect(physics).toContain('Rotational Motion');
    expect(physics).toContain('Electrostatics');
    expect(chaptersOf('chemistry').map((chapter) => chapter.displayName)).toContain('Chemical Bonding and Molecular Structure');
    expect(chaptersOf('mathematics').map((chapter) => chapter.displayName)).toContain('Integral Calculus');
  });
});

describe('exam weights', () => {
  it.each(['physics', 'chemistry', 'mathematics'])('sums chapter weights to 1.0 for %s', (subject) => {
    const total = chaptersOf(subject).reduce((sum, chapter) => sum + (chapter.examWeight ?? 0), 0);

    expect(Number(total.toFixed(6))).toBe(1);
  });

  it('gives every chapter a positive weight', () => {
    for (const subject of ['physics', 'chemistry', 'mathematics']) {
      for (const chapter of chaptersOf(subject)) {
        expect(chapter.examWeight ?? 0, chapter.key).toBeGreaterThan(0);
      }
    }
  });

  it('keeps every weight inside [0, 1]', () => {
    for (const subject of parsed().subjects) {
      const walk = (concept: TaxonomyFileConcept): void => {
        expect(concept.examWeight ?? 0, concept.key).toBeGreaterThanOrEqual(0);
        expect(concept.examWeight ?? 0, concept.key).toBeLessThanOrEqual(1);
        for (const child of concept.children ?? []) walk(child);
      };
      walk(subject.root);
    }
  });
});

describe('prerequisites', () => {
  it('declares genuine cross-chapter dependencies', () => {
    const edges = parsed().prerequisites ?? [];

    expect(edges.length).toBeGreaterThanOrEqual(40);
    expect(edges).toContainEqual({
      from: 'physics.kinematics',
      to: 'physics.laws-of-motion',
      strength: 0.9,
    });
    expect(edges).toContainEqual({
      from: 'mathematics.limit-continuity-and-differentiability',
      to: 'mathematics.integral-calculus',
      strength: 0.9,
    });
  });

  it('references only concepts the file defines', () => {
    const keys = new Set<string>();
    const walk = (concept: TaxonomyFileConcept): void => {
      keys.add(concept.key);
      for (const child of concept.children ?? []) walk(child);
    };
    for (const subject of parsed().subjects) walk(subject.root);

    for (const edge of parsed().prerequisites ?? []) {
      expect(keys.has(edge.from), edge.from).toBe(true);
      expect(keys.has(edge.to), edge.to).toBe(true);
    }
  });
});

describe('loading and publishing the real dataset', () => {
  it('loads and passes the whole invariant suite', async () => {
    const outcome = await loadTaxonomyFile(contents, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.conceptCount).toBeGreaterThanOrEqual(550);
    expect(outcome.report.prerequisiteCount).toBeGreaterThanOrEqual(40);

    const loaded = await deps.versions.findById(outcome.report.taxonomyVersionId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.aggregate.validate()).toEqual([]);
  }, 60_000);

  it('publishes cleanly under M1-04', async () => {
    const outcome = await loadTaxonomyFile(contents, deps);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    const loaded = await deps.versions.findById(outcome.report.taxonomyVersionId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;

    const published = loaded.value.aggregate.publish(curator, new Date('2026-08-05T10:00:00.000Z'));
    expect(published.ok).toBe(true);
    if (!published.ok) return;

    const saved = await deps.versions.update(published.value, loaded.value.aggregateVersion);
    expect(saved.ok).toBe(true);

    const reloaded = await deps.versions.findById(outcome.report.taxonomyVersionId);
    expect(reloaded.ok && reloaded.value.aggregate.state).toBe('published');
  }, 60_000);

  it('has an acyclic prerequisite graph, proven by the aggregate accepting every edge', async () => {
    const outcome = await loadTaxonomyFile(contents, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const loaded = await deps.versions.findById(outcome.report.taxonomyVersionId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.aggregate.prerequisites.length).toBe(outcome.report.prerequisiteCount);
    expect(
      loaded.value.aggregate.validate().filter((violation) => violation.code === 'PREREQUISITE_CYCLE'),
    ).toEqual([]);
  }, 60_000);
});

describe('review status', () => {
  it('records that subject-matter sign-off is still outstanding', () => {
    expect(contents).toContain('awaiting subject-matter review and sign-off');
  });
});
