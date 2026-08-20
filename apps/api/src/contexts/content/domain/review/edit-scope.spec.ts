import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../../testing/expect-result.js';
import { PROVENANCE_CONTEXT, itemVersionProps } from '../../../../testing/content-fixtures.js';
import { createItemVersion } from '../item-version.js';
import {
  EDITABLE_UNDER_REVIEW,
  FORBIDDEN_UNDER_REVIEW,
  ITEM_VERSION_FIELDS_OUTSIDE_EDIT_SCOPE,
  diffWithinScope,
} from './edit-scope.js';

describe('diffWithinScope', () => {
  it.each(EDITABLE_UNDER_REVIEW)('permits "%s" individually', (field) => {
    expect(expectValue(diffWithinScope([field]))).toEqual([field]);
  });

  it('permits every editable field changed together', () => {
    expect(expectValue(diffWithinScope([...EDITABLE_UNDER_REVIEW]))).toEqual([...EDITABLE_UNDER_REVIEW]);
  });

  it('permits an empty diff, reported back as empty', () => {
    expect(expectValue(diffWithinScope([]))).toEqual([]);
  });

  it.each(FORBIDDEN_UNDER_REVIEW.filter((field) => field !== 'responseSpec'))(
    'refuses "%s" individually, naming the field',
    (field) => {
      const error = expectError(diffWithinScope([field]));
      expect(error.code).toBe('EDIT_EXCEEDS_REVIEW_SCOPE');
      expect(error.message).toContain(field);
      expect(error.location).toContain(field);
    },
  );

  it('refuses a responseSpec change with a distinct code naming request_changes', () => {
    const error = expectError(diffWithinScope(['responseSpec']));
    expect(error.code).toBe('KEY_EDIT_REQUIRES_CHANGES_REQUESTED');
    expect(error.message).toContain('request_changes');
  });

  it('refuses an unrecognized field the same way as a forbidden one', () => {
    const error = expectError(diffWithinScope(['nonExistentField']));
    expect(error.code).toBe('EDIT_EXCEEDS_REVIEW_SCOPE');
  });

  it('stops at the first offending field in a mixed list', () => {
    const error = expectError(diffWithinScope(['stem', 'itemType', 'taxonomyTags']));
    expect(error.code).toBe('EDIT_EXCEEDS_REVIEW_SCOPE');
    expect(error.message).toContain('itemType');
  });
});

describe('the three field lists are disjoint and, together, exhaustive over ItemVersion', () => {
  function realItemVersionKeys(): string[] {
    const version = expectValue(createItemVersion(itemVersionProps(), PROVENANCE_CONTEXT));
    return Object.keys(version);
  }

  it('EDITABLE_UNDER_REVIEW and FORBIDDEN_UNDER_REVIEW share no field', () => {
    const editable = new Set(EDITABLE_UNDER_REVIEW as readonly string[]);
    const overlap = FORBIDDEN_UNDER_REVIEW.filter((field) => editable.has(field));
    expect(overlap).toEqual([]);
  });

  it('none of the three lists overlap with each other', () => {
    const all = [...EDITABLE_UNDER_REVIEW, ...FORBIDDEN_UNDER_REVIEW, ...ITEM_VERSION_FIELDS_OUTSIDE_EDIT_SCOPE];
    expect(new Set(all).size).toBe(all.length);
  });

  it('classifies every real field ItemVersion has', () => {
    const classified = new Set([...FORBIDDEN_UNDER_REVIEW, ...ITEM_VERSION_FIELDS_OUTSIDE_EDIT_SCOPE, 'stem', 'taxonomyTags', 'difficultyEstimate']);
    const unclassified = realItemVersionKeys().filter((key) => !classified.has(key));
    expect(unclassified).toEqual([]);
  });

  it('is red on a planted field belonging to neither the real classification nor a stand-in extra', () => {
    // Simulates a field added to ItemVersion and forgotten here: the same
    // three-list union, checked against a key set that carries one extra.
    const classified = new Set([...FORBIDDEN_UNDER_REVIEW, ...ITEM_VERSION_FIELDS_OUTSIDE_EDIT_SCOPE, 'stem', 'taxonomyTags', 'difficultyEstimate']);
    const plantedKeys = [...realItemVersionKeys(), 'renderProfile'];
    const unclassified = plantedKeys.filter((key) => !classified.has(key));
    expect(unclassified).toEqual(['renderProfile']);
  });
});
