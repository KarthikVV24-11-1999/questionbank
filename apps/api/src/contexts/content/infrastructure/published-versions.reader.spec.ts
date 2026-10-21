import type { Pool } from 'pg';
import { describe, expect, it } from 'vitest';
import { expectError, expectValue } from '../../../testing/expect-result.js';
import { PostgresPublishedVersions } from './published-versions.reader.js';

/** The reader against a canned pool: what it asks for, and what it says when the store fails. The real queries are proven in `queries.integration.spec.ts`. */
const pool = (rows: unknown[], seen: string[] = []): Pool =>
  ({ query: async (sql: string) => { seen.push(sql); return { rows }; } }) as unknown as Pool;

describe('the published-version reader', () => {
  it('asks the item table for items and the stimulus table for stimuli, and only for versions that have been published', async () => {
    const seen: string[] = [];
    const reader = new PostgresPublishedVersions(pool([{ item_id: 'i1', stimulus_id: 's1' }], seen));
    expect(expectValue(await reader.itemOfPublishedVersion('v'))).toBe('i1');
    expect(expectValue(await reader.stimulusOfPublishedVersion('v'))).toBe('s1');
    expect(seen[0]).toContain('FROM content.item_version');
    expect(seen[1]).toContain('FROM content.stimulus_version');
    for (const sql of seen) expect(sql).toContain('published_at IS NOT NULL');
  });

  it('says NotFound for a version with no published row, naming what it looked for', async () => {
    const reader = new PostgresPublishedVersions(pool([]));
    expect(expectError(await reader.itemOfPublishedVersion('v')).kind).toBe('NotFound');
    expect(expectError(await reader.stimulusOfPublishedVersion('v')).message).toContain('stimulus version');
  });

  it('reports a failing store as a value that says nothing of the driver', async () => {
    const broken = new PostgresPublishedVersions({ query: async () => Promise.reject(new Error('relation "secret" missing')) } as unknown as Pool);
    const failure = expectError(await broken.itemOfPublishedVersion('v'));
    expect(failure.code).toBe('PERSISTENCE_REJECTED');
    expect(failure.message).not.toContain('secret');
  });
});
