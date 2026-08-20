import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../testing/database.js';
import { insertCandidatesShown, findCandidatesShown } from './review-candidate-shown.repository.js';

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

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-c000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

/** A decision row is the only thing `review_candidate_shown` has a real FK to. */
async function seedDecision(): Promise<string> {
  const decisionId = freshUuid();
  await database.pool.query(
    `INSERT INTO content.review_decision
       (review_decision_id, owner_type, owner_version_id, reviewer_kind, reviewer_id, outcome, decided_at)
     VALUES ($1, 'item_version', $2, 'human', $3, 'approve', now())`,
    [decisionId, freshUuid(), freshUuid()],
  );
  return decisionId;
}

describe('insertCandidatesShown / findCandidatesShown (M4-19)', () => {
  it('round trips a non-empty set, sorted', async () => {
    const decisionId = await seedDecision();
    const a = freshUuid();
    const b = freshUuid();
    const client = await database.pool.connect();
    try {
      await insertCandidatesShown(client, decisionId, [b, a]);
      const shown = await findCandidatesShown(client, decisionId);
      expect(shown).toEqual([a, b].sort());
    } finally {
      client.release();
    }
  });

  it('writes nothing for an empty set', async () => {
    const decisionId = await seedDecision();
    const client = await database.pool.connect();
    try {
      await insertCandidatesShown(client, decisionId, []);
      const shown = await findCandidatesShown(client, decisionId);
      expect(shown).toEqual([]);
    } finally {
      client.release();
    }
  });

  it('finds nothing for a decision nothing was ever recorded against', async () => {
    const client = await database.pool.connect();
    try {
      const shown = await findCandidatesShown(client, freshUuid());
      expect(shown).toEqual([]);
    } finally {
      client.release();
    }
  });
});
