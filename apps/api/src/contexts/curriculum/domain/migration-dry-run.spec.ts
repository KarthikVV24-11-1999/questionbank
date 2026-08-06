import { describe, expect, it } from 'vitest';
import { TaxonomyMapping, type MappingKind } from './taxonomy-mapping.js';
import { TaxonomyMigration } from './taxonomy-migration.js';
import { allExceptionsDispositioned, runMigrationDryRun } from './migration-dry-run.js';
import { expectValue } from '../../../testing/expect-result.js';

const SOURCE = ['ci_a', 'ci_b', 'ci_c', 'ci_d', 'ci_f'];
const TARGET = ['ci_a', 'ci_b1', 'ci_b2', 'ci_c', 'ci_e', 'ci_f'];

function migration(): TaxonomyMigration {
  return expectValue(
    TaxonomyMigration.create({
      migrationId: 'mig_1',
      fromVersionId: 'tv_2026',
      toVersionId: 'tv_2027',
      sourceConcepts: SOURCE,
      targetConcepts: TARGET,
    }),
  );
}

function withMappings(
  entries: ReadonlyArray<{ kind: MappingKind; from: string[]; to: string[] }>,
): TaxonomyMigration {
  return entries.reduce(
    (current, entry) =>
      expectValue(current.addMapping(expectValue(TaxonomyMapping.create(entry)))),
    migration(),
  );
}

/** Every source concept mapped, all of them by an auto-migratable kind. */
function fullyAutomatic(): TaxonomyMigration {
  return withMappings([
    { kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] },
    { kind: 'IDENTITY', from: ['ci_c'], to: ['ci_c'] },
    { kind: 'IDENTITY', from: ['ci_f'], to: ['ci_f'] },
    { kind: 'RENAME', from: ['ci_b'], to: ['ci_b1'] },
    { kind: 'RENAME', from: ['ci_d'], to: ['ci_e'] },
  ]);
}

describe('dry run classification', () => {
  it('yields zero exceptions when every mapping is IDENTITY or RENAME', () => {
    const result = runMigrationDryRun(fullyAutomatic());

    expect(result.exceptions).toEqual([]);
    expect(result.autoMigratableCount).toBe(5);
    expect(result.invalidMappings).toEqual([]);
  });

  it.each(['MOVE', 'SPLIT', 'MERGE', 'REMOVAL'] as const)('raises an exception for %s', (kind) => {
    const mappings: Record<string, { kind: MappingKind; from: string[]; to: string[] }> = {
      MOVE: { kind: 'MOVE', from: ['ci_a'], to: ['ci_a'] },
      SPLIT: { kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2'] },
      MERGE: { kind: 'MERGE', from: ['ci_c', 'ci_d'], to: ['ci_e'] },
      REMOVAL: { kind: 'REMOVAL', from: ['ci_f'], to: [] },
    };

    const result = runMigrationDryRun(withMappings([mappings[kind] as { kind: MappingKind; from: string[]; to: string[] }]));
    const ambiguous = result.exceptions.filter((exception) => exception.kind === 'AMBIGUOUS_MAPPING');

    expect(ambiguous).toHaveLength(1);
    expect(ambiguous[0]?.mappingKind).toBe(kind);
    expect(ambiguous[0]?.disposition).toBe('pending');
    expect(result.autoMigratableCount).toBe(0);
  });

  it('reports a source concept with no mapping as UNMAPPED', () => {
    const result = runMigrationDryRun(
      withMappings([{ kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] }]),
    );

    const unmapped = result.exceptions.filter((exception) => exception.kind === 'UNMAPPED');

    expect(unmapped.map((exception) => exception.concepts[0])).toEqual(['ci_b', 'ci_c', 'ci_d', 'ci_f']);
    expect(result.autoMigratableCount).toBe(1);
  });

  it('does not report target-only concepts as unmapped', () => {
    const result = runMigrationDryRun(fullyAutomatic());

    expect(result.exceptions).toEqual([]);
  });

  it('lists the auto-migratable count, exceptions and the version pair', () => {
    const result = runMigrationDryRun(
      withMappings([
        { kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] },
        { kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2'] },
      ]),
    );

    expect(result).toMatchObject({
      migrationId: 'mig_1',
      fromVersionId: 'tv_2026',
      toVersionId: 'tv_2027',
      autoMigratableCount: 1,
      schemaVersion: 1,
    });
    expect(result.exceptions.map((exception) => exception.kind)).toEqual([
      'AMBIGUOUS_MAPPING',
      'UNMAPPED',
      'UNMAPPED',
      'UNMAPPED',
    ]);
  });

  it('names the affected concepts on every exception', () => {
    const result = runMigrationDryRun(
      withMappings([{ kind: 'MERGE', from: ['ci_c', 'ci_d'], to: ['ci_e'] }]),
    );

    expect(result.exceptions[0]?.concepts).toEqual(['ci_c', 'ci_d', 'ci_e']);
    for (const exception of result.exceptions) {
      expect(exception.concepts.length).toBeGreaterThan(0);
      expect(exception.reason.length).toBeGreaterThan(0);
    }
  });
});

describe('dry run purity', () => {
  it('mutates nothing observable on the migration', () => {
    const subject = withMappings([
      { kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2'] },
      { kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] },
    ]);
    const before = {
      state: subject.state,
      mappings: subject.mappings.map((mapping) => ({ kind: mapping.kind, disposition: mapping.disposition })),
      mapped: [...subject.mappedConcepts].sort(),
    };

    runMigrationDryRun(subject);

    expect({
      state: subject.state,
      mappings: subject.mappings.map((mapping) => ({ kind: mapping.kind, disposition: mapping.disposition })),
      mapped: [...subject.mappedConcepts].sort(),
    }).toEqual(before);
  });

  it('is deterministic across 100 runs', () => {
    const subject = withMappings([
      { kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2'] },
      { kind: 'MERGE', from: ['ci_c', 'ci_d'], to: ['ci_e'] },
      { kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] },
    ]);

    const renderings = new Set(
      Array.from({ length: 100 }, () => JSON.stringify(runMigrationDryRun(subject))),
    );

    expect(renderings.size).toBe(1);
  });

  it('is independent of the order the same mappings were added in', () => {
    const forwards = withMappings([
      { kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] },
      { kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2'] },
    ]);
    const backwards = withMappings([
      { kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2'] },
      { kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] },
    ]);

    const strip = (result: ReturnType<typeof runMigrationDryRun>): unknown => ({
      ...result,
      exceptions: [...result.exceptions].sort((left, right) =>
        left.concepts.join().localeCompare(right.concepts.join()),
      ),
    });

    expect(strip(runMigrationDryRun(forwards))).toEqual(strip(runMigrationDryRun(backwards)));
  });
});

describe('dry run invalid mappings', () => {
  it('reports a mapping that references a concept absent from its version', () => {
    // A mapping can go stale when the draft target version drops a concept
    // after the mapping was defined; the dry run is what detects it.
    const withIdentity = withMappings([{ kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] }]);
    const stale = expectValue(
      withIdentity.replaceMapping(
        0,
        expectValue(TaxonomyMapping.create({ kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_gone'] })),
      ),
    );

    const result = runMigrationDryRun(stale);

    expect(result.invalidMappings).toHaveLength(1);
    expect(result.invalidMappings[0]).toMatchObject({ mappingIndex: 0, mappingKind: 'SPLIT' });
    expect(result.invalidMappings[0]?.concepts).toEqual(['ci_gone']);
    expect(result.autoMigratableCount).toBe(0);
  });

  it('does not count an invalid mapping as an exception', () => {
    const withIdentity = withMappings([{ kind: 'IDENTITY', from: ['ci_a'], to: ['ci_a'] }]);
    const stale = expectValue(
      withIdentity.replaceMapping(
        0,
        expectValue(TaxonomyMapping.create({ kind: 'RENAME', from: ['ci_missing'], to: ['ci_e'] })),
      ),
    );

    const result = runMigrationDryRun(stale);

    expect(result.exceptions.every((exception) => exception.kind === 'UNMAPPED')).toBe(true);
    expect(result.invalidMappings[0]?.concepts).toEqual(['ci_missing']);
  });
});

describe('exception disposition gate', () => {
  it('blocks while any exception is pending and clears once all are dispositioned', () => {
    const pending = runMigrationDryRun(
      withMappings([{ kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2'] }]),
    );

    expect(allExceptionsDispositioned(pending)).toBe(false);
    expect(
      allExceptionsDispositioned({
        ...pending,
        exceptions: pending.exceptions.map((exception) => ({ ...exception, disposition: 'accepted' as const })),
      }),
    ).toBe(true);
  });

  it('treats a migration with no exceptions as fully dispositioned', () => {
    expect(allExceptionsDispositioned(runMigrationDryRun(fullyAutomatic()))).toBe(true);
  });
});
