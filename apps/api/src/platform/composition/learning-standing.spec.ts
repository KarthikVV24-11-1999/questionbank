import { describe, expect, it } from 'vitest';
import { err, ok } from '../../contexts/content/domain/result.js';
import { ContentItemStandings } from './learning-standing.js';

/** A bookmark's item is looked up in content as the system, in one call, and content's refusal is Learning's "unavailable" (D86). */
describe('the standings content gives Learning', () => {
  const standing = { itemId: 'i1', state: 'published' as const, itemVersionId: 'v1' };

  it('asks for every item at once, as the system, and returns what content says', async () => {
    const asked: unknown[] = [];
    const source = new ContentItemStandings({
      itemStanding: { handle: async (query: unknown, context: { principal: unknown }) => { asked.push([query, context.principal]); return ok([standing]); } },
    } as never);
    const answered = await source.standings(['i1', 'i2'], { correlationId: 'c' });
    expect(answered).toEqual({ ok: true, value: [standing] });
    expect(asked).toEqual([[{ itemIds: ['i1', 'i2'] }, expect.objectContaining({ kind: 'system', roleContext: ['system'] })]]);
  });

  it('answers unavailable, naming content\'s reason and nothing else of it, when content refuses', async () => {
    const source = new ContentItemStandings({
      itemStanding: { handle: async () => err({ kind: 'Validation', code: 'ITEM_STANDING_QUERY_INVALID', message: 'at most 500 items per call' }) },
    } as never);
    const answered = await source.standings(['i1'], { correlationId: 'c' });
    expect(answered).toMatchObject({ ok: false, error: { kind: 'Unavailable', code: 'SOURCE_UNAVAILABLE' } });
    expect(JSON.stringify(answered)).toContain('ITEM_STANDING_QUERY_INVALID');
    expect(JSON.stringify(answered)).not.toContain('500');
  });
});
