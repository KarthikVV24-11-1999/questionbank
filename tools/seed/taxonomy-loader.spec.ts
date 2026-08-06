import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { loadTaxonomyFile, parseTaxonomyFile, type LoaderDependencies } from './taxonomy-loader.js';
import { connectTestDatabase, type TestDatabase } from '../../apps/api/src/testing/database.js';
import { DrizzleConceptIdentityRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/concept-identity.repository.js';
import { DrizzleTaxonomyVersionRepository } from '../../apps/api/src/contexts/curriculum/infrastructure/taxonomy-version.repository.js';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');

function fixture(name: string): string {
  return readFileSync(join(FIXTURES, name), 'utf8');
}

/** Deterministic UUIDv5-shaped ids, so a re-run of a file reuses them. */
export function derivedIdentifier(kind: string, key: string): string {
  const digest = createHash('sha256').update(`${kind}:${key}`).digest('hex');
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `7${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join('-');
}

let database: TestDatabase;
let deps: LoaderDependencies;

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

describe('schema validation', () => {
  it('accepts a well-formed file', () => {
    const parsed = parseTaxonomyFile(fixture('valid-taxonomy.yaml'));

    expect(parsed.ok).toBe(true);
  });

  it('reports a malformed document with a line number', () => {
    const parsed = parseTaxonomyFile(fixture('malformed-yaml.yaml'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.line).toBeGreaterThan(0);
    expect(parsed.issues[0]?.message).toBeTruthy();
  });

  it('rejects an unknown field and names it', () => {
    const parsed = parseTaxonomyFile(fixture('unknown-field.yaml'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues.some((issue) => issue.message.includes('weighting'))).toBe(true);
  });

  it('reports a per-record location, not just “invalid”', () => {
    const parsed = parseTaxonomyFile(fixture('bad-weight.yaml'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    const issue = parsed.issues[0];
    expect(issue?.path).toBe('/subjects/0/root/examWeight');
    expect(issue?.line).toBe(9);
    expect(issue?.message).toContain('<= 1');
  });

  it('rejects a duplicate concept key', () => {
    const parsed = parseTaxonomyFile(fixture('duplicate-key.yaml'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.message).toContain('physics.mechanics');
  });

  it('rejects a prerequisite pointing at an unknown concept', () => {
    const parsed = parseTaxonomyFile(fixture('unknown-prerequisite.yaml'));

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.issues[0]?.message).toContain('physics.absent');
  });

  it('rejects a file declaring an unsupported schema version', () => {
    const parsed = parseTaxonomyFile(fixture('valid-taxonomy.yaml').replace('schemaVersion: 1', 'schemaVersion: 2'));

    expect(parsed.ok).toBe(false);
  });
});

describe('loading', () => {
  it('produces a draft version with every concept and edge', async () => {
    const outcome = await loadTaxonomyFile(fixture('valid-taxonomy.yaml'), deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.conceptCount).toBe(6);
    expect(outcome.report.prerequisiteCount).toBe(2);

    const loaded = await deps.versions.findById(outcome.report.taxonomyVersionId);
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.value.aggregate.state).toBe('draft');
    expect(loaded.value.aggregate.validate()).toEqual([]);
    expect(loaded.value.aggregate.nodeById(derivedIdentifier('node', 'physics.mechanics.kinematics'))?.depth).toBe(2);
  });

  it('never produces a published version', async () => {
    const outcome = await loadTaxonomyFile(fixture('valid-taxonomy.yaml'), deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const stored = await database.pool.query<{ state: string }>(
      `SELECT state FROM curriculum.taxonomy_version WHERE taxonomy_version_id = $1`,
      [outcome.report.taxonomyVersionId],
    );
    expect(stored.rows[0]?.state).toBe('draft');
  });

  it('is idempotent: re-running the same file changes nothing', async () => {
    const first = await loadTaxonomyFile(fixture('valid-taxonomy.yaml'), deps);
    const countBefore = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM curriculum.concept_node`,
    );

    const second = await loadTaxonomyFile(fixture('valid-taxonomy.yaml'), deps);
    const countAfter = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM curriculum.concept_node`,
    );

    expect(first.ok && second.ok).toBe(true);
    if (!second.ok) return;
    expect(second.report.unchanged).toBe(true);
    expect(countAfter.rows[0]?.count).toBe(countBefore.rows[0]?.count);
  });

  it('writes nothing when the file is invalid — all or nothing', async () => {
    const outcome = await loadTaxonomyFile(fixture('duplicate-key.yaml'), deps);

    expect(outcome.ok).toBe(false);
    const versions = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM curriculum.taxonomy_version`,
    );
    const nodes = await database.pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM curriculum.concept_node`,
    );
    expect(versions.rows[0]?.count).toBe('0');
    expect(nodes.rows[0]?.count).toBe('0');
  });

  it('loads a 600-node taxonomy', async () => {
    const children = Array.from({ length: 599 }, (_unused, index) =>
      [
        `        - key: physics.c${index}`,
        `          displayName: Concept ${index}`,
        `          examWeight: 0.001`,
        `          estimatedTeachingHours: 1`,
      ].join('\n'),
    ).join('\n');

    const large = [
      'schemaVersion: 1',
      'examFamily: JEE',
      "academicYear: '2026'",
      'subjects:',
      '  - subjectDomain: physics',
      '    root:',
      '      key: physics',
      '      displayName: Physics',
      '      examWeight: 1',
      '      estimatedTeachingHours: 300',
      '      children:',
      children,
    ].join('\n');

    const outcome = await loadTaxonomyFile(large, deps);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.report.conceptCount).toBe(600);
  }, 60_000);
});
