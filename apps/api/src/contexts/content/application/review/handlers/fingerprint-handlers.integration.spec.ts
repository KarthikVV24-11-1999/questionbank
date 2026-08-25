import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../../testing/database.js';
import { expectError, expectValue } from '../../../../../testing/expect-result.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../../../testing/content-fixtures.js';
import { createItem, transitionItem } from '../../../domain/item.js';
import { createItemVersion } from '../../../domain/item-version.js';
import type { ApplicationContext } from '../../ports.js';
import { PostgresItemRepository } from '../../../infrastructure/item.repository.js';
import { PostgresFingerprintRepository } from '../../../infrastructure/review/fingerprint.repository.js';
import { RefreshFingerprintsHandler, type FingerprintDependencies } from './fingerprint-handlers.js';

/**
 * M4-32. `RefreshFingerprints` over the review queue population — the same
 * `findSubmittedForReview` traversal the ageing sweep (M4-31) already reads.
 */

let database: TestDatabase;
let items: PostgresItemRepository;
let fingerprints: PostgresFingerprintRepository;

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  fingerprints = new PostgresFingerprintRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-b000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['author'] };
const contentOps: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['content_ops'] };
const reviewerOnly: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-fp' });

function deps(): FingerprintDependencies {
  return { items, fingerprints };
}

async function inReviewItem(createdAt: string, subject = `refresh-${freshUuid()}`): Promise<{ itemId: string; itemVersionId: string }> {
  const version = expectValue(
    createItemVersion(
      {
        versionId: freshUuid(),
        versionNo: 1,
        itemType: 'SINGLE_CORRECT_MCQ',
        stem: textBody(`A block slides down a frictionless ramp — ${subject}.`),
        responseSpec: singleCorrectSpec(),
        taxonomyTags: [
          { conceptIdentityId: freshUuid(), taxonomyVersionId: freshUuid(), weight: 1, isPrimary: true },
        ],
        difficultyEstimate: 'moderate',
        provenance: originalProvenance(),
        licensing: { status: 'owned' },
        authoredBy: AUTHOR,
        createdAt,
      },
      { latestPlausibleYear: 2026 },
    ),
  );
  const created = expectValue(
    createItem({ itemId: freshUuid(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: version, authoringSubject: subject }),
  );
  expectValue(await items.save(created));
  const submitted = expectValue(transitionItem(created, { transition: 'submit_for_review', stateEnteredAt: createdAt }));
  expectValue(await items.save(submitted));
  return { itemId: submitted.itemId, itemVersionId: submitted.versions[0]!.versionId };
}

describe('RefreshFingerprintsHandler (M4-32)', () => {
  it('computes a fingerprint for a version created at or after the watermark', async () => {
    const since = '2026-08-20T00:00:00.000Z';
    const { itemVersionId } = await inReviewItem('2026-08-20T12:00:00.000Z');

    const result = expectValue(
      await new RefreshFingerprintsHandler(deps()).handle({ since, now: '2026-08-21T00:00:00.000Z' }, as(contentOps)),
    );
    expect(result.refreshedItemVersionIds).toContain(itemVersionId);
    expect(result.watermark).toBe('2026-08-21T00:00:00.000Z');

    const stored = expectValue(await fingerprints.findByItemVersionId(itemVersionId));
    expect(stored).toBeDefined();
    expect(stored!.exactHash).toMatch(/^[0-9a-f]{64}$/u);
  });

  it('skips a version created before the watermark', async () => {
    const { itemVersionId } = await inReviewItem('2026-08-01T00:00:00.000Z');

    const result = expectValue(
      await new RefreshFingerprintsHandler(deps()).handle(
        { since: '2026-08-20T00:00:00.000Z', now: '2026-08-21T00:00:00.000Z' },
        as(contentOps),
      ),
    );
    expect(result.refreshedItemVersionIds).not.toContain(itemVersionId);
    expect(expectValue(await fingerprints.findByItemVersionId(itemVersionId))).toBeUndefined();
  });

  it('refuses a reviewer — maintenance is Content Ops’ surface', async () => {
    const refused = await new RefreshFingerprintsHandler(deps()).handle(
      { since: '2026-08-20T00:00:00.000Z', now: '2026-08-21T00:00:00.000Z' },
      as(reviewerOnly),
    );
    expect(expectError(refused).kind).toBe('Authorization');
  });
});
