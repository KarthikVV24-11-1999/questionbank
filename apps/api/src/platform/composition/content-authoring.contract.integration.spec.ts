import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { CreateItemDraftHandler } from '../../contexts/content/application/handlers/authoring-handlers.js';
import { SubmitItemForReviewHandler } from '../../contexts/content/application/handlers/lifecycle-handlers.js';
import { InMemoryAuditRecorder, InMemoryIdempotencyStore, InMemoryMediaStore } from '../../contexts/content/application/ports.js';
import { PostgresItemRepository } from '../../contexts/content/infrastructure/item.repository.js';
import { PostgresMediaAssetRepository } from '../../contexts/content/infrastructure/media-asset.repository.js';
import { PostgresReviewAssignmentRepository } from '../../contexts/content/infrastructure/review/review-assignment.repository.js';
import { PostgresReviewDecisionRepository } from '../../contexts/content/infrastructure/review-decision.repository.js';
import { PostgresSolutionRepository } from '../../contexts/content/infrastructure/solution.repository.js';
import { PostgresStimulusRepository } from '../../contexts/content/infrastructure/stimulus.repository.js';
import { PostgresTransactionRunner } from '../../contexts/content/infrastructure/transaction-runner.js';
import { ContentCommandAuthoring } from '../../contexts/generation/infrastructure/content-command-authoring.js';
import { contentAuthoringOver } from '../../testing/content-authoring-adapter.js';
import { describeContentAuthoringContract, type ContentAuthoringUnderTest } from '../../testing/content-authoring-contract.js';
import { connectTestDatabase, type TestDatabase } from '../../testing/database.js';
import { fixedClock } from '../../testing/generation-context.js';

/**
 * The production `ContentAuthoring` and the test-support one, held to one
 * contract. They are written independently — one injected with content's
 * handlers, one wiring them itself — so this is where drift between them would
 * show.
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
const renderer = {
  async validate(version: { versionId: string }) {
    return { itemVersionId: version.versionId, surfacesChecked: ['web'], failures: [] };
  },
};

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

/** Content's two handlers, built the way the composition root will build them. */
function contentHandlers(pool: Pool, items: PostgresItemRepository) {
  const audit = new InMemoryAuditRecorder();
  return {
    createDraft: new CreateItemDraftHandler({ items, clock: fixedClock, identifiers, audit, idempotency: new InMemoryIdempotencyStore() }),
    submitForReview: new SubmitItemForReviewHandler({
      items,
      assets: new PostgresMediaAssetRepository(pool),
      store: new InMemoryMediaStore(),
      stimuli: new PostgresStimulusRepository(pool),
      solutions: new PostgresSolutionRepository(pool),
      reviews: new PostgresReviewDecisionRepository(pool),
      renderer,
      assignments: new PostgresReviewAssignmentRepository(pool),
      transactions: new PostgresTransactionRunner(pool),
      clock: fixedClock,
      identifiers,
      audit,
    }),
  };
}

describeContentAuthoringContract('the production adapter, over injected handlers', () => {
  const items = new PostgresItemRepository(database.pool);
  return {
    authoring: new ContentCommandAuthoring(contentHandlers(database.pool, items)),
    ...inspect(database.pool, items),
  };
});

describeContentAuthoringContract('the test-support adapter', () => {
  const support = contentAuthoringOver(database.pool, { clock: fixedClock, identifiers, renderer });
  return { authoring: support, ...inspect(database.pool, support.items) };
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
