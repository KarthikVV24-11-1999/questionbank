import { describe, expect, it } from 'vitest';
import { MALFORMATIONS, mutate, pathsOf, sweep } from './mutation-sweep.js';

const DOCUMENT = { a: 1, list: [{ b: 'x' }, 2], nested: { deep: { c: true } } };

describe('the mutation sweep', () => {
  it('names every position in a document, the root first', () => {
    expect(pathsOf(DOCUMENT).map((path) => path.join('.'))).toEqual(['', 'a', 'list', 'list.0', 'list.0.b', 'list.1', 'nested', 'nested.deep', 'nested.deep.c']);
  });

  it('breaks one position at a time, in each of six ways, leaving the original alone', () => {
    expect(mutate(DOCUMENT, ['nested', 'deep', 'c'], 'removed')).toEqual({ a: 1, list: [{ b: 'x' }, 2], nested: { deep: {} } });
    expect(mutate(DOCUMENT, ['a'], 'null')).toEqual({ ...DOCUMENT, a: null });
    expect(mutate(DOCUMENT, ['a'], 'number')).toEqual({ ...DOCUMENT, a: 7 });
    expect(mutate(DOCUMENT, ['a'], 'string')).toEqual({ ...DOCUMENT, a: 'x' });
    expect(mutate(DOCUMENT, ['list', 0], 'empty array')).toEqual({ ...DOCUMENT, list: [[], 2] });
    expect(mutate(DOCUMENT, ['list', 1], 'empty object')).toEqual({ ...DOCUMENT, list: [{ b: 'x' }, {}] });
    expect(mutate(DOCUMENT, ['list', 0], 'removed')).toEqual({ ...DOCUMENT, list: [2] });
    expect(DOCUMENT).toEqual({ a: 1, list: [{ b: 'x' }, 2], nested: { deep: { c: true } } });
  });

  it('can replace or remove the root', () => {
    expect(mutate(DOCUMENT, [], 'removed')).toBeUndefined();
    expect(mutate(DOCUMENT, [], 'string')).toBe('x');
  });

  it('tries every position in every way, deterministically', () => {
    const first = sweep(DOCUMENT, () => undefined);
    expect(first.tried).toBe(pathsOf(DOCUMENT).length * MALFORMATIONS.length);
    expect(first.tried).toBe(54);
    expect(sweep(DOCUMENT, () => undefined)).toEqual(first);
  });

  // The instrument, shown able to fire: a function that dereferences carelessly
  // is caught, with the position and the way it was broken.
  it('reports a function that raises, naming where and how the input was broken', () => {
    const careless = (value: unknown): void => {
      void (value as { nested: { deep: { c: boolean } } }).nested.deep.c.toString();
    };
    const result = sweep(DOCUMENT, careless);
    expect(result.raised.length).toBeGreaterThan(5);
    expect(result.raised).toContainEqual({ path: 'nested.deep.c', how: 'removed', message: expect.stringContaining('toString') as unknown as string });
    expect(result.raised).toContainEqual({ path: '(root)', how: 'removed', message: expect.any(String) as unknown as string });
    expect(sweep(DOCUMENT, () => undefined).raised).toEqual([]);
  });

  it('also records a thrown value that is not an Error', () => {
    expect(sweep({ a: 1 }, () => { throw 'a bare string'; }).raised[0]?.message).toBe('a bare string');
  });
});
