import { describe, expect, it } from 'vitest';
import { MAPPING_KINDS, TaxonomyMapping, isAutoMigratable, type MappingKind } from './taxonomy-mapping.js';
import { TaxonomyMigration } from './taxonomy-migration.js';
import { expectError, expectValue } from '../../../testing/expect-result.js';

const SOURCE = ['ci_a', 'ci_b', 'ci_c', 'ci_d'];
const TARGET = ['ci_a', 'ci_b1', 'ci_b2', 'ci_c', 'ci_e'];

const validPerKind: Record<MappingKind, { from: string[]; to: string[] }> = {
  IDENTITY: { from: ['ci_a'], to: ['ci_a'] },
  RENAME: { from: ['ci_c'], to: ['ci_e'] },
  MOVE: { from: ['ci_c'], to: ['ci_c'] },
  SPLIT: { from: ['ci_b'], to: ['ci_b1', 'ci_b2'] },
  MERGE: { from: ['ci_b', 'ci_c'], to: ['ci_e'] },
  REMOVAL: { from: ['ci_d'], to: [] },
};

function mapping(kind: MappingKind, overrides: Partial<{ from: string[]; to: string[] }> = {}): TaxonomyMapping {
  return expectValue(TaxonomyMapping.create({ kind, ...validPerKind[kind], ...overrides }));
}

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

describe('TaxonomyMapping kinds', () => {
  it('supports all six kinds', () => {
    expect([...MAPPING_KINDS]).toEqual(['IDENTITY', 'RENAME', 'MOVE', 'SPLIT', 'MERGE', 'REMOVAL']);
  });

  it.each(MAPPING_KINDS)('constructs a valid %s mapping', (kind) => {
    const created = mapping(kind);

    expect(created.kind).toBe(kind);
    expect(created.from).toEqual(validPerKind[kind].from);
    expect(created.to).toEqual(validPerKind[kind].to);
    expect(created.disposition).toBe('pending');
    expect(Object.isFrozen(created)).toBe(true);
  });

  it('classifies IDENTITY and RENAME as auto-migratable, the rest not', () => {
    expect(MAPPING_KINDS.filter(isAutoMigratable)).toEqual(['IDENTITY', 'RENAME']);
    expect(mapping('SPLIT').isAutoMigratable).toBe(false);
  });

  it('records a disposition without mutating the original', () => {
    const original = mapping('SPLIT');

    const dispositioned = original.withDisposition('accepted');

    expect(dispositioned.disposition).toBe('accepted');
    expect(original.disposition).toBe('pending');
  });
});

describe('TaxonomyMapping cardinality', () => {
  it.each([
    ['IDENTITY with two sources', 'IDENTITY', { from: ['ci_a', 'ci_b'] }],
    ['RENAME with no target', 'RENAME', { to: [] }],
    ['MOVE with two targets', 'MOVE', { to: ['ci_a', 'ci_e'] }],
    ['SPLIT with one target', 'SPLIT', { to: ['ci_b1'] }],
    ['SPLIT with two sources', 'SPLIT', { from: ['ci_a', 'ci_c'] }],
    ['MERGE with one source', 'MERGE', { from: ['ci_b'] }],
    ['MERGE with two targets', 'MERGE', { to: ['ci_b1', 'ci_b2'] }],
    ['REMOVAL with a target', 'REMOVAL', { to: ['ci_e'] }],
    ['REMOVAL with two sources', 'REMOVAL', { from: ['ci_c', 'ci_d'] }],
  ] as const)('rejects %s', (_case, kind, overrides) => {
    const error = expectError(
      TaxonomyMapping.create({ kind, ...validPerKind[kind], ...overrides }),
    );

    expect(error.code).toBe('CARDINALITY_INVALID');
  });

  it('accepts a SPLIT into three concepts', () => {
    const split = expectValue(
      TaxonomyMapping.create({ kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b2', 'ci_e'] }),
    );

    expect(split.to).toHaveLength(3);
  });

  it('rejects an unknown kind', () => {
    expect(
      expectError(
        TaxonomyMapping.create({ kind: 'RESHAPE' as MappingKind, from: ['ci_a'], to: ['ci_a'] }),
      ).code,
    ).toBe('MAPPING_KIND_UNKNOWN');
  });

  it('rejects a blank concept id', () => {
    expect(
      expectError(TaxonomyMapping.create({ kind: 'RENAME', from: [' '], to: ['ci_e'] })).code,
    ).toBe('CONCEPT_ID_REQUIRED');
  });

  it('rejects the same concept named twice within a mapping', () => {
    expect(
      expectError(TaxonomyMapping.create({ kind: 'SPLIT', from: ['ci_b'], to: ['ci_b1', 'ci_b1'] })).code,
    ).toBe('DUPLICATE_CONCEPT_IN_MAPPING');
  });
});

describe('TaxonomyMigration construction', () => {
  it('references two versions and starts empty', () => {
    const created = migration();

    expect(created.fromVersionId).toBe('tv_2026');
    expect(created.toVersionId).toBe('tv_2027');
    expect(created.mappings).toEqual([]);
    expect(created.state).toBe('draft');
  });

  it.each([
    ['a blank migration id', { migrationId: ' ' }, 'MIGRATION_ID_REQUIRED'],
    ['a blank version id', { toVersionId: '' }, 'VERSION_ID_REQUIRED'],
    ['identical versions', { toVersionId: 'tv_2026' }, 'VERSIONS_IDENTICAL'],
  ])('rejects %s', (_case, overrides, code) => {
    expect(
      expectError(
        TaxonomyMigration.create({
          migrationId: 'mig_1',
          fromVersionId: 'tv_2026',
          toVersionId: 'tv_2027',
          sourceConcepts: SOURCE,
          targetConcepts: TARGET,
          ...overrides,
        }),
      ).code,
    ).toBe(code);
  });
});

describe('TaxonomyMigration mapping references', () => {
  it('accepts mappings whose concepts exist in the correct versions', () => {
    const withSplit = expectValue(migration().addMapping(mapping('SPLIT')));
    const withRemoval = expectValue(withSplit.addMapping(mapping('REMOVAL')));

    expect(withRemoval.mappings).toHaveLength(2);
    expect(withRemoval.mappingFor('ci_b1')?.kind).toBe('SPLIT');
  });

  it('rejects a source concept absent from the source version', () => {
    const error = expectError(migration().addMapping(mapping('RENAME', { from: ['ci_absent'] })));

    expect(error.code).toBe('UNKNOWN_SOURCE_CONCEPT');
    expect(error.offendingConcepts).toEqual(['ci_absent']);
  });

  it('rejects a target concept absent from the target version', () => {
    const error = expectError(migration().addMapping(mapping('RENAME', { to: ['ci_absent'] })));

    expect(error.code).toBe('UNKNOWN_TARGET_CONCEPT');
    expect(error.offendingConcepts).toEqual(['ci_absent']);
  });

  it('rejects a concept that already appears in another mapping', () => {
    const withSplit = expectValue(migration().addMapping(mapping('SPLIT')));

    const error = expectError(withSplit.addMapping(mapping('MERGE')));

    expect(error.code).toBe('CONCEPT_ALREADY_MAPPED');
    expect(error.offendingConcepts).toEqual(['ci_b']);
  });

  it('rejects a concept re-used as a target of a second mapping', () => {
    const withRename = expectValue(migration().addMapping(mapping('RENAME')));

    const error = expectError(
      withRename.addMapping(expectValue(TaxonomyMapping.create({ kind: 'MOVE', from: ['ci_a'], to: ['ci_e'] }))),
    );

    expect(error.code).toBe('CONCEPT_ALREADY_MAPPED');
    expect(error.offendingConcepts).toEqual(['ci_e']);
  });

  it('leaves the original migration untouched when a mapping is added', () => {
    const original = migration();

    expectValue(original.addMapping(mapping('IDENTITY')));

    expect(original.mappings).toEqual([]);
  });
});

describe('TaxonomyMigration state', () => {
  it('permits draft → executing → executed only', () => {
    const executing = expectValue(migration().transitionTo('executing'));
    const executed = expectValue(executing.transitionTo('executed'));

    expect(executed.state).toBe('executed');
    expect(expectError(executed.transitionTo('executing')).code).toBe('ILLEGAL_STATE_TRANSITION');
    expect(expectError(migration().transitionTo('executed')).code).toBe('ILLEGAL_STATE_TRANSITION');
  });

  it('refuses to modify a migration that is executing', () => {
    const executing = expectValue(migration().transitionTo('executing'));

    expect(expectError(executing.addMapping(mapping('IDENTITY'))).code).toBe('MIGRATION_NOT_MUTABLE');
    expect(expectError(executing.replaceMapping(0, mapping('IDENTITY'))).code).toBe('MIGRATION_NOT_MUTABLE');
  });

  it('replaces a mapping in place while still a draft', () => {
    const withSplit = expectValue(migration().addMapping(mapping('SPLIT')));

    const dispositioned = expectValue(
      withSplit.replaceMapping(0, mapping('SPLIT').withDisposition('accepted')),
    );

    expect(dispositioned.mappings[0]?.disposition).toBe('accepted');
  });
});
