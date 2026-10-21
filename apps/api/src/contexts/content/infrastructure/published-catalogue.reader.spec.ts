import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { PostgresPublishedCatalogue } from './published-catalogue.reader.js';

/**
 * The reader's own mapping, against a pool that returns canned rows — the
 * query itself is proven against real Postgres in `queries.integration.spec.ts`.
 * This reaches the branches a real item hardly can: a stimulus attached, a
 * full page, and every filter present or absent.
 */
const row = (n: number, stimulus: string | null) => ({
  item_id: `00000000-0000-4000-8000-00000000000${n}`,
  item_version_id: `00000000-0000-4000-8000-00000000010${n}`,
  version_no: 1,
  item_type: 'NUMERIC',
  difficulty_estimate: 'advanced',
  authoring_subject: 'physics',
  stimulus_version_id: stimulus,
  taxonomy_version_id: '00000000-0000-4000-8000-0000000000aa',
  primary_concept: '00000000-0000-4000-8000-0000000000bb',
  concepts: ['00000000-0000-4000-8000-0000000000bb'],
});

function poolReturning(rows: unknown[], seen: unknown[][] = []): Pool {
  return {
    query: async (_sql: string, params: unknown[]) => {
      seen.push(params);
      return { rows };
    },
  } as unknown as Pool;
}

describe('the catalogue reader', () => {
  it('maps a row to an entry, carrying the stimulus only when there is one', async () => {
    const reader = new PostgresPublishedCatalogue(poolReturning([row(1, '00000000-0000-4000-8000-0000000000cc'), row(2, null)]));
    const page = expectValue(await reader.list({ limit: 10 }));
    expect(page.entries[0]!.stimulusVersionId).toBe('00000000-0000-4000-8000-0000000000cc');
    expect('stimulusVersionId' in page.entries[1]!).toBe(false);
    expect(page.entries[0]!.itemType).toBe('NUMERIC');
    expect(Object.isFrozen(page.entries[0])).toBe(true);
    expect(Object.isFrozen(page.entries[0]!.conceptIdentityIds)).toBe(true);
  });

  it('hands back a cursor exactly when the page is full', async () => {
    const full = expectValue(await new PostgresPublishedCatalogue(poolReturning([row(1, null), row(2, null)])).list({ limit: 2 }));
    expect(full.nextCursor).toBe('00000000-0000-4000-8000-000000000002');
    const short = expectValue(await new PostgresPublishedCatalogue(poolReturning([row(1, null)])).list({ limit: 2 }));
    expect('nextCursor' in short).toBe(false);
  });

  it('passes each filter through, and null for each that is absent', async () => {
    const seen: unknown[][] = [];
    const reader = new PostgresPublishedCatalogue(poolReturning([], seen));
    await reader.list({ limit: 5 });
    await reader.list({
      subject: 'physics',
      itemTypes: ['NUMERIC'],
      difficultyBands: ['advanced'],
      conceptIdentityIds: ['c1'],
      cursor: 'x',
      limit: 5,
    });
    expect(seen[0]).toEqual([null, null, null, null, null, 5]);
    expect(seen[1]).toEqual(['physics', ['NUMERIC'], ['advanced'], ['c1'], 'x', 5]);
  });

  it('reports a failing store as a value that says nothing of the driver', async () => {
    const pool = { query: async () => Promise.reject(new Error('relation "secret" does not exist')) } as unknown as Pool;
    const failure = expectError(await new PostgresPublishedCatalogue(pool).list({ limit: 1 }));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).not.toContain('secret');
  });
});
