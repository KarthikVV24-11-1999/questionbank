import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { contentForGeneration } from '../../contexts/content/public/composition.js';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore } from '../../contexts/content/application/ports.js';
import { PostgresItemRepository } from '../../contexts/content/infrastructure/item.repository.js';
import { ContentCommandAuthoring } from '../../contexts/generation/infrastructure/content-command-authoring.js';
import { describeContentAuthoringContract, type ContentAuthoringUnderTest } from '../../testing/content-authoring-contract.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { fixedClock } from '../../testing/generation-context.js';
import { createMediaStore } from '../persistence/filesystem-media-store.js';

/**
 * The production `ContentAuthoring` held to its contract, over **the handlers
 * content's own seam hands generation** — the same ones the composition root passes
 * it, built from the same assembly content registers its module from. There is no
 * second adapter to hold it against: the test-support one existed only because the
 * seam did not, and was deleted with it (M5-37).
 */
let database: TestDatabase;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

const identifiers = { next: () => randomUUID() };

function inspect(pool: Pool, items: PostgresItemRepository): Pick<ContentAuthoringUnderTest, 'itemStateOf' | 'itemCount'> {
  return {
    itemStateOf: async (itemId) => {
      const found = await items.findById(itemId);
      if (!found.ok) return undefined;
      return { lifecycleState: found.value.lifecycleState, authoredById: found.value.versions[0]!.authoredBy.id };
    },
    itemCount: async () => (await pool.query('SELECT count(*)::int AS n FROM content.item')).rows[0].n as number,
  };
}

/** Content's two handlers, from the seam the composition root uses. */
function seamHandlers(pool: Pool) {
  return contentForGeneration({
    pool,
    mediaStore: createMediaStore({ mediaStorageRoot: './var/media-test', nodeEnv: 'test' }),
    idempotency: new InMemoryIdempotencyStore(),
    clock: fixedClock,
    identifiers,
    audit: new InMemoryAuditRecorder(),
    principals: { resolve: () => null },
    reviewPolicy: { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 },
  });
}

describeContentAuthoringContract('the production adapter, over the handlers content’s seam provides', () => {
  const items = new PostgresItemRepository(database.pool);
  const seam = seamHandlers(database.pool);
  return {
    authoring: new ContentCommandAuthoring({ createDraft: seam.createDraft, submitForReview: seam.submitForReview }),
    ...inspect(database.pool, items),
  };
});

describe('the production adapter, on its own terms', () => {
  it('takes everything it uses as an argument: it builds no repository and resolves no handler', async () => {
    const calls: string[] = [];
    const adapter = new ContentCommandAuthoring({
      createDraft: { handle: async () => (calls.push('create'), { ok: true, value: { itemId: 'item-1', aggregate: 'ignored' } as never }) },
      submitForReview: { handle: async () => (calls.push('submit'), { ok: true, value: 'anything' }) },
    });
    const context = { principal: { id: 'p', kind: 'human', roleContext: [] } as never, correlationId: 'c' };
    const created = await adapter.createDraft({} as never, context);
    const submitted = await adapter.submitForReview({ itemId: 'item-1' }, context);

    expect(created).toEqual({ ok: true, value: { itemId: 'item-1' } });
    expect(submitted).toEqual({ ok: true, value: true });
    expect(calls).toEqual(['create', 'submit']);
  });
});
