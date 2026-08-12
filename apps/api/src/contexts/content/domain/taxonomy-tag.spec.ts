import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import {
  createTaxonomyTag,
  createTaxonomyTagSet,
  primaryTagOf,
  taxonomyVersionOf,
  type CreateTaxonomyTagProps,
} from './taxonomy-tag.js';

const TAXONOMY = 'taxonomy-2026';

function tag(overrides: Partial<CreateTaxonomyTagProps> = {}): CreateTaxonomyTagProps {
  return {
    conceptIdentityId: 'concept-kinematics',
    taxonomyVersionId: TAXONOMY,
    weight: 1,
    isPrimary: true,
    ...overrides,
  };
}

describe('a single tag', () => {
  it('constructs with a concept, a taxonomy version and a weight', () => {
    expect(expectValue(createTaxonomyTag(tag()))).toEqual({
      conceptIdentityId: 'concept-kinematics',
      taxonomyVersionId: TAXONOMY,
      weight: 1,
      isPrimary: true,
    });
  });

  it('rejects a blank concept identity', () => {
    expect(expectError(createTaxonomyTag(tag({ conceptIdentityId: '  ' }))).code).toBe(
      'CONCEPT_IDENTITY_REQUIRED',
    );
  });

  // FR-TCH-05 rule 1. A tag naming only a concept is uninterpretable after a
  // syllabus revision, and FR-QM-13's migration has nothing to map from.
  it('rejects a tag with no taxonomy version, which could never be migrated', () => {
    expect(expectError(createTaxonomyTag(tag({ taxonomyVersionId: '' }))).code).toBe(
      'TAXONOMY_VERSION_REQUIRED',
    );
  });

  it.each([
    ['below zero', -0.01],
    ['above one', 1.01],
    ['not a number', Number.NaN],
    ['infinite', Number.POSITIVE_INFINITY],
  ])('rejects a weight %s', (_label, weight) => {
    expect(expectError(createTaxonomyTag(tag({ weight }))).code).toBe('WEIGHT_OUT_OF_RANGE');
  });

  it.each([
    ['exactly zero', 0],
    ['exactly one', 1],
    ['between', 0.4],
  ])('accepts a weight %s', (_label, weight) => {
    expect(expectValue(createTaxonomyTag(tag({ weight }))).weight).toBe(weight);
  });

  it('is frozen', () => {
    expect(Object.isFrozen(expectValue(createTaxonomyTag(tag())))).toBe(true);
  });

  it('names where the problem is', () => {
    expect(expectError(createTaxonomyTag(tag({ weight: 5 }), 'taxonomyTags[3]')).location).toBe(
      'taxonomyTags[3]',
    );
  });
});

describe('a tag set', () => {
  it('constructs from one primary tag', () => {
    expect(expectValue(createTaxonomyTagSet([tag()]))).toHaveLength(1);
  });

  it('constructs from a primary and several secondaries', () => {
    const set = expectValue(
      createTaxonomyTagSet([
        tag(),
        tag({ conceptIdentityId: 'concept-vectors', weight: 0.4, isPrimary: false }),
        tag({ conceptIdentityId: 'concept-graphs', weight: 0.2, isPrimary: false }),
      ]),
    );
    expect(set).toHaveLength(3);
  });

  it('rejects an empty set — every item requires a concept tag', () => {
    expect(expectError(createTaxonomyTagSet([])).code).toBe('TAGS_REQUIRED');
  });

  it('rejects a set with no primary', () => {
    expect(expectError(createTaxonomyTagSet([tag({ isPrimary: false })])).code).toBe('PRIMARY_TAG_REQUIRED');
  });

  it('rejects a set with two primaries', () => {
    const failure = expectError(
      createTaxonomyTagSet([tag(), tag({ conceptIdentityId: 'concept-vectors' })]),
    );
    expect(failure.code).toBe('PRIMARY_TAG_AMBIGUOUS');
  });

  it('rejects the same concept tagged twice, naming the repeat', () => {
    const failure = expectError(
      createTaxonomyTagSet([tag(), tag({ isPrimary: false, weight: 0.3 })]),
    );
    expect(failure.code).toBe('CONCEPT_DUPLICATED');
    expect(failure.location).toBe('taxonomyTags[1]');
  });

  // Half an item migrating is worse than none of it: nothing downstream can
  // say which taxonomy the item is tagged under.
  it('rejects a set spanning two taxonomy versions', () => {
    const failure = expectError(
      createTaxonomyTagSet([
        tag(),
        tag({ conceptIdentityId: 'concept-vectors', taxonomyVersionId: 'taxonomy-2027', isPrimary: false }),
      ]),
    );
    expect(failure.code).toBe('TAXONOMY_VERSION_MIXED');
    expect(failure.message).toContain('taxonomy-2026');
    expect(failure.message).toContain('taxonomy-2027');
  });

  it('propagates a member failure with the member’s index', () => {
    const failure = expectError(
      createTaxonomyTagSet([tag(), tag({ conceptIdentityId: 'concept-vectors', weight: 9, isPrimary: false })]),
    );
    expect(failure.code).toBe('WEIGHT_OUT_OF_RANGE');
    expect(failure.location).toBe('taxonomyTags[1]');
  });

  it('is frozen and does not alias the caller’s array', () => {
    const input: CreateTaxonomyTagProps[] = [tag()];
    const set = expectValue(createTaxonomyTagSet(input));
    input.push(tag({ conceptIdentityId: 'smuggled', isPrimary: false }));
    expect(Object.isFrozen(set)).toBe(true);
    expect(set).toHaveLength(1);
  });
});

describe('reading a validated set', () => {
  it('reports the one taxonomy version it binds to', () => {
    const set = expectValue(
      createTaxonomyTagSet([tag(), tag({ conceptIdentityId: 'concept-vectors', isPrimary: false })]),
    );
    expect(taxonomyVersionOf(set)).toBe(TAXONOMY);
  });

  it('reports nothing for an empty list', () => {
    expect(taxonomyVersionOf([])).toBeUndefined();
  });

  it('finds the primary tag', () => {
    const set = expectValue(
      createTaxonomyTagSet([
        tag({ conceptIdentityId: 'concept-vectors', isPrimary: false }),
        tag({ isPrimary: true }),
      ]),
    );
    expect(primaryTagOf(set)?.conceptIdentityId).toBe('concept-kinematics');
  });

  it('finds no primary in an empty list', () => {
    expect(primaryTagOf([])).toBeUndefined();
  });
});
