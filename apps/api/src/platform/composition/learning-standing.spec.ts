import { describe, expect, it } from 'vitest';
import { err, ok } from '../../contexts/content/domain/result.js';
import { ContentItemStandings } from './learning-standing.js';

/** A bookmark's item is looked up in content as the system, in one call, and content's refusal is Learning's "unavailable" (D86). */
describe('the standings content gives Learning', () => {
  const standing = { itemId: 'i1', state: 'published' as const, itemVersionId: 'v1' };

  it('asks for every item at once, as the system, and returns what content says', async () => {
    const asked: unknown[] = [];
    const source = new ContentItemStandings({
      batchBound: 500,
      itemStanding: { handle: async (query: unknown, context: { principal: unknown }) => { asked.push([query, context.principal]); return ok([standing]); } },
    } as never);
    const answered = await source.standings(['i1', 'i2'], { correlationId: 'c' });
    expect(answered).toEqual({ ok: true, value: [standing] });
    expect(asked).toEqual([[{ itemIds: ['i1', 'i2'] }, expect.objectContaining({ kind: 'system', roleContext: ['system'] })]]);
  });

  it('answers unavailable, naming content\'s reason and nothing else of it, when content refuses', async () => {
    const source = new ContentItemStandings({
      batchBound: 500,
      itemStanding: { handle: async () => err({ kind: 'Validation', code: 'ITEM_STANDING_QUERY_INVALID', message: 'at most 500 items per call' }) },
    } as never);
    const answered = await source.standings(['i1'], { correlationId: 'c' });
    expect(answered).toMatchObject({ ok: false, error: { kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE' } });
    expect(JSON.stringify(answered)).toContain('ITEM_STANDING_QUERY_INVALID');
    expect(JSON.stringify(answered)).not.toContain('500');
  });

  it('asks in pages of the size content states, and returns every page in order (D86)', async () => {
    const asked: (readonly string[])[] = [];
    const source = new ContentItemStandings({
      batchBound: 3,
      itemStanding: { handle: async (query: { itemIds: readonly string[] }) => { asked.push(query.itemIds); return ok(query.itemIds.map((itemId) => ({ ...standing, itemId }))); } },
    } as never);
    const ids = ['a', 'b', 'c', 'd', 'e', 'f', 'g'];
    const answered = await source.standings(ids, { correlationId: 'c' });
    expect(asked.map((page) => page.length)).toEqual([3, 3, 1]);
    expect(answered.ok && answered.value.map((entry) => entry.itemId)).toEqual(ids);
  });

  it('answers unavailable, with none of the list, when a later page is refused', async () => {
    let page = 0;
    const source = new ContentItemStandings({
      batchBound: 2,
      itemStanding: { handle: async (query: { itemIds: readonly string[] }) => (++page === 2 ? err({ kind: 'Validation', code: 'ITEM_STANDING_QUERY_INVALID', message: 'm' }) : ok(query.itemIds.map((itemId) => ({ ...standing, itemId })))) },
    } as never);
    const answered = await source.standings(['a', 'b', 'c', 'd'], { correlationId: 'c' });
    expect(answered).toMatchObject({ ok: false, error: { kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE' } });
  });

  it('asks nothing of content for no items', async () => {
    let calls = 0;
    const source = new ContentItemStandings({ batchBound: 3, itemStanding: { handle: async () => { calls += 1; return ok([]); } } } as never);
    expect(await source.standings([], { correlationId: 'c' })).toEqual({ ok: true, value: [] });
    expect(calls).toBe(0);
  });
});
