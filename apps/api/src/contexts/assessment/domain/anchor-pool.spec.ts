import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { TAG, id } from '../../../testing/assessment-fixtures.js';
import { activeAnchorVersions, addAnchorPoolMember, isActiveAnchor, retireAnchorPoolMember } from './anchor-pool.js';

const ADDED = '2026-10-01T00:00:00.000Z';
const member = (n = 1, cap = 40) => expectValue(addAnchorPoolMember({ itemVersionId: id(TAG.itemVersion, n), exposureCap: cap, addedAt: ADDED }));

describe('adding a version to the pool', () => {
  it('records the version, its cap and when, as a member who has not left', () => {
    const added = member();
    expect(added).toEqual({ itemVersionId: id(TAG.itemVersion, 1), exposureCap: 40, addedAt: ADDED, retiredAt: null });
    expect(Object.isFrozen(added)).toBe(true);
    expect(isActiveAnchor(added)).toBe(true);
  });

  it.each([
    ['a version id that is not a uuid', { itemVersionId: 'nope', exposureCap: 4, addedAt: ADDED }, 'ANCHOR_ITEM_VERSION_INVALID'],
    ['a zero cap', { itemVersionId: id(TAG.itemVersion), exposureCap: 0, addedAt: ADDED }, 'ANCHOR_CAP_INVALID'],
    ['a fractional cap', { itemVersionId: id(TAG.itemVersion), exposureCap: 2.5, addedAt: ADDED }, 'ANCHOR_CAP_INVALID'],
    ['a malformed time', { itemVersionId: id(TAG.itemVersion), exposureCap: 4, addedAt: 'soon' }, 'ANCHOR_TIME_INVALID'],
  ])('refuses %s', (_name, props, code) => {
    const error = expectError(addAnchorPoolMember(props));
    expect(error.code).toBe(code);
    expect(error.kind).toBe('Validation');
  });
});

describe('leaving the pool', () => {
  it('sets the time, once, and the version is no longer active', () => {
    const retired = expectValue(retireAnchorPoolMember(member(), '2026-11-01T00:00:00.000Z'));
    expect(retired.retiredAt).toBe('2026-11-01T00:00:00.000Z');
    expect(isActiveAnchor(retired)).toBe(false);
  });

  it('is refused a second time, and before the version joined, and with a malformed time', () => {
    const retired = expectValue(retireAnchorPoolMember(member(), '2026-11-01T00:00:00.000Z'));
    expect(expectError(retireAnchorPoolMember(retired, '2026-12-01T00:00:00.000Z')).code).toBe('ANCHOR_ALREADY_RETIRED');
    expect(expectError(retireAnchorPoolMember(member(), '2026-09-01T00:00:00.000Z')).code).toBe('ANCHOR_RETIRED_BEFORE_ADDED');
    expect(expectError(retireAnchorPoolMember(member(), 'later')).code).toBe('ANCHOR_TIME_INVALID');
  });
});

describe('the set a form is checked against', () => {
  it('holds the versions in the pool now, and none that have left', () => {
    const left = expectValue(retireAnchorPoolMember(member(2), '2026-11-01T00:00:00.000Z'));
    expect([...activeAnchorVersions([member(1), left, member(3)])].sort()).toEqual([id(TAG.itemVersion, 1), id(TAG.itemVersion, 3)]);
    expect(activeAnchorVersions([])).toEqual(new Set());
  });
});
