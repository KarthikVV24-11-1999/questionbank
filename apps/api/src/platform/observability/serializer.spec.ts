import { describe, expect, it } from 'vitest';
import { ALLOWED_ATTRIBUTE_KEYS, filterAllowlisted } from './serializer.js';

describe('filterAllowlisted — an allowlisted key survives', () => {
  it('keeps a value whose key is in the allowlist', () => {
    const { filtered, droppedKeys } = filterAllowlisted({ route: '/v1/items' }, ['route']);
    expect(filtered).toEqual({ route: '/v1/items' });
    expect(droppedKeys).toEqual([]);
  });
});

describe('filterAllowlisted — an unknown key is dropped and named', () => {
  it('drops a key not in the allowlist, recording only its name', () => {
    const { filtered, droppedKeys } = filterAllowlisted({ route: '/v1/items', secretToken: 'abc123' }, ['route']);
    expect(filtered).toEqual({ route: '/v1/items' });
    expect(droppedKeys).toEqual(['secretToken']);
    expect(JSON.stringify(filtered)).not.toContain('abc123');
  });

  it('deduplicates a dropped key name recurring across array elements', () => {
    const { droppedKeys } = filterAllowlisted(
      { items: [{ secret: 'x' }, { secret: 'y' }, { secret: 'z' }] },
      ['items'],
    );
    expect(droppedKeys).toEqual(['secret']);
  });
});

describe('filterAllowlisted — this is a fail-closed allowlist, not a denylist', () => {
  it('drops a key nobody has ever seen before, with no rule naming it specifically', () => {
    // A denylist would pass this through unchanged, having no rule against
    // it. An allowlist drops anything not explicitly named — which is the
    // property this whole module exists to guarantee.
    const { filtered, droppedKeys } = filterAllowlisted({ zzTotallyNovelFieldXyz123: 'value' }, ['route']);
    expect(filtered).toEqual({});
    expect(droppedKeys).toEqual(['zzTotallyNovelFieldXyz123']);
  });
});

describe('filterAllowlisted — dropping is recursive', () => {
  it('filters a nested object under an allowlisted key by the same rule', () => {
    const { filtered, droppedKeys } = filterAllowlisted(
      { context: { route: '/v1/items', userEmail: 'a@b.com' } },
      ['context', 'route'],
    );
    expect(filtered).toEqual({ context: { route: '/v1/items' } });
    expect(droppedKeys).toEqual(['userEmail']);
    expect(JSON.stringify(filtered)).not.toContain('a@b.com');
  });

  it('filters an array of objects under an allowlisted key element by element', () => {
    const { filtered, droppedKeys } = filterAllowlisted(
      { items: [{ itemId: '1', secret: 'x' }, { itemId: '2', secret: 'y' }] },
      ['items', 'itemId'],
    );
    expect(filtered).toEqual({ items: [{ itemId: '1' }, { itemId: '2' }] });
    expect(droppedKeys).toEqual(['secret']);
  });

  it('filters two levels deep', () => {
    const { filtered, droppedKeys } = filterAllowlisted(
      { a: { b: { c: 'kept', d: 'dropped' } } },
      ['a', 'b', 'c'],
    );
    expect(filtered).toEqual({ a: { b: { c: 'kept' } } });
    expect(droppedKeys).toEqual(['d']);
  });
});

describe('filterAllowlisted — the planted PII fixture leaks nothing', () => {
  const piiRecord = {
    route: '/v1/authoring/items',
    email: 'jane.doe@example.com',
    phone: '+91-9876543210',
    fullName: 'Jane Doe',
  };

  it('drops email, phone and fullName by name and by value', () => {
    const { filtered, droppedKeys } = filterAllowlisted(piiRecord, [...ALLOWED_ATTRIBUTE_KEYS]);
    expect(filtered).toEqual({ route: '/v1/authoring/items' });
    expect(new Set(droppedKeys)).toEqual(new Set(['email', 'phone', 'fullName']));

    const serialized = JSON.stringify(filtered);
    expect(serialized).not.toContain('jane.doe@example.com');
    expect(serialized).not.toContain('+91-9876543210');
    expect(serialized).not.toContain('Jane Doe');
  });

  it('leaks nothing even when the PII is nested under an allowlisted key', () => {
    const nested = { itemVersionId: 'iv-1', principalId: { fullName: 'Jane Doe', id: 'u-1' } };
    // principalId's value is a plain string in real use; this plants the
    // worse case — a whole entity spread under a permitted key — to prove
    // the recursive rule holds even where the schema does not expect it to.
    const { filtered, droppedKeys } = filterAllowlisted(nested, [...ALLOWED_ATTRIBUTE_KEYS, 'id']);
    expect(filtered).toEqual({ itemVersionId: 'iv-1', principalId: { id: 'u-1' } });
    expect(droppedKeys).toEqual(['fullName']);
    expect(JSON.stringify(filtered)).not.toContain('Jane Doe');
  });
});
