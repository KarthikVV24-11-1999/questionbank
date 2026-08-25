import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../../testing/database.js';
import { expectError, expectValue } from '../../../../../testing/expect-result.js';
import type { ApplicationContext, Clock } from '../../ports.js';
import { PostgresFingerprintRepository } from '../../../infrastructure/review/fingerprint.repository.js';
import type { ItemFingerprintRecord } from '../../../domain/repository-ports.js';
import { GetDuplicateCandidatesHandler, type DuplicateQueryDependencies } from './duplicate-queries.js';

/**
 * M4-32. The three labelled groups, each proven against a fixture that
 * belongs in exactly one of them, plus staleness and the not-evaluated
 * honesty check.
 */

let database: TestDatabase;
let fingerprints: PostgresFingerprintRepository;

const NOW = new Date('2026-08-25T12:00:00.000Z');
const clock: Clock = { now: () => NOW };

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  fingerprints = new PostgresFingerprintRepository(database.pool);
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

const SUBJECT = 'physics';
const reviewerPrincipal: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
const otherReviewer: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-dup' });

function deps(): DuplicateQueryDependencies {
  return { fingerprints, clock };
}

async function seedItemVersion(subject = SUBJECT): Promise<{ itemId: string; itemVersionId: string }> {
  const itemId = freshUuid();
  const itemVersionId = freshUuid();
  await database.pool.query(`INSERT INTO content.item (item_id, item_type, authoring_subject) VALUES ($1, 'SINGLE_CORRECT_MCQ', $2)`, [
    itemId,
    subject,
  ]);
  await database.pool.query(
    `INSERT INTO content.item_version
       (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id)
     VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3)`,
    [itemVersionId, itemId, freshUuid()],
  );
  return { itemId, itemVersionId };
}

function fp(overrides: Partial<ItemFingerprintRecord> & { itemId: string; itemVersionId: string }): ItemFingerprintRecord {
  return {
    subject: SUBJECT,
    exactHash: `exact-${freshUuid()}`,
    skeletonHash: `skeleton-${freshUuid()}`,
    normalizedText: 'a block slides down a frictionless ramp',
    computedAt: '2026-08-25T11:00:00.000Z',
    ...overrides,
  };
}

describe('GetDuplicateCandidatesHandler (M4-32, DEC-M4-2)', () => {
  it('is not_evaluated, honestly, when nothing has computed this item’s fingerprint yet', async () => {
    const { itemVersionId } = await seedItemVersion();
    const result = expectValue(
      await new GetDuplicateCandidatesHandler(deps()).handle({ itemVersionId }, as(reviewerPrincipal)),
    );
    expect(result.state).toBe('not_evaluated');
    expect(result.exactMatches).toEqual([]);
    expect(result.skeletonMatches).toEqual([]);
    expect(result.trigramMatches).toEqual([]);
    expect(result.computedAt).toBeUndefined();
    expect(result.asOf).toBe(NOW.toISOString());
  });

  it('puts an exact retype in the exact group, never the others', async () => {
    const subject = `exact-${freshUuid()}`;
    const target = await seedItemVersion(subject);
    const retype = await seedItemVersion(subject);
    const sharedExact = `exact-shared-${freshUuid()}`;
    await fingerprints.save(fp({ ...target, subject, exactHash: sharedExact }));
    await fingerprints.save(fp({ ...retype, subject, exactHash: sharedExact }));

    const result = expectValue(
      await new GetDuplicateCandidatesHandler(deps()).handle(
        { itemVersionId: target.itemVersionId },
        as(reviewerPrincipal),
      ),
    );
    expect(result.state).toBe('evaluated');
    expect(result.exactMatches.map((c) => c.itemVersionId)).toEqual([retype.itemVersionId]);
    expect(result.skeletonMatches).toEqual([]);
    expect(result.computedAt).toBe('2026-08-25T11:00:00.000Z');
  });

  it('puts a constants-swapped pair in the skeleton group, never the others', async () => {
    const subject = `skeleton-${freshUuid()}`;
    const target = await seedItemVersion(subject);
    const swapped = await seedItemVersion(subject);
    const sharedSkeleton = `skeleton-shared-${freshUuid()}`;
    await fingerprints.save(fp({ ...target, subject, skeletonHash: sharedSkeleton }));
    await fingerprints.save(fp({ ...swapped, subject, skeletonHash: sharedSkeleton }));

    const result = expectValue(
      await new GetDuplicateCandidatesHandler(deps()).handle(
        { itemVersionId: target.itemVersionId },
        as(reviewerPrincipal),
      ),
    );
    expect(result.exactMatches).toEqual([]);
    expect(result.skeletonMatches.map((c) => c.itemVersionId)).toEqual([swapped.itemVersionId]);
  });

  it('puts a merely similar item only in the trigram group', async () => {
    const subject = `trigram-${freshUuid()}`;
    const target = await seedItemVersion(subject);
    const similar = await seedItemVersion(subject);
    await fingerprints.save(
      fp({ ...target, subject, normalizedText: 'a block slides down a frictionless ramp of length ten metres' }),
    );
    await fingerprints.save(
      fp({ ...similar, subject, normalizedText: 'a block slides down a frictionless ramp of length twelve metres' }),
    );

    const result = expectValue(
      await new GetDuplicateCandidatesHandler(deps()).handle(
        { itemVersionId: target.itemVersionId },
        as(reviewerPrincipal),
      ),
    );
    expect(result.exactMatches).toEqual([]);
    expect(result.skeletonMatches).toEqual([]);
    expect(result.trigramMatches.map((c) => c.itemVersionId)).toContain(similar.itemVersionId);
    const own = result.trigramMatches.find((c) => c.itemVersionId === similar.itemVersionId)!;
    expect(own.similarity).toBeGreaterThan(0);
  });

  it('reports staleness — computedAt travels with the result, distinct from asOf', async () => {
    const { itemId, itemVersionId } = await seedItemVersion();
    await fingerprints.save(fp({ itemId, itemVersionId, computedAt: '2026-08-25T11:20:00.000Z' }));

    const result = expectValue(
      await new GetDuplicateCandidatesHandler(deps()).handle({ itemVersionId }, as(reviewerPrincipal)),
    );
    expect(result.computedAt).toBe('2026-08-25T11:20:00.000Z');
    expect(result.asOf).toBe(NOW.toISOString());
    expect(result.computedAt).not.toBe(result.asOf);
  });

  it('lets content_ops read it too, and refuses an author', async () => {
    const { itemId, itemVersionId } = await seedItemVersion();
    await fingerprints.save(fp({ itemId, itemVersionId }));
    const contentOps: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['content_ops'] };
    const asContentOps = expectValue(
      await new GetDuplicateCandidatesHandler(deps()).handle({ itemVersionId }, as(contentOps)),
    );
    expect(asContentOps.state).toBe('evaluated');

    const author: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['author'] };
    const refused = await new GetDuplicateCandidatesHandler(deps()).handle({ itemVersionId }, as(author));
    expect(expectError(refused).kind).toBe('Authorization');
  });

  it('never lists the item itself among its own candidates', async () => {
    const subject = `self-${freshUuid()}`;
    const target = await seedItemVersion(subject);
    await fingerprints.save(fp({ ...target, subject }));

    const result = expectValue(
      await new GetDuplicateCandidatesHandler(deps()).handle(
        { itemVersionId: target.itemVersionId },
        as(otherReviewer),
      ),
    );
    expect(result.exactMatches.map((c) => c.itemVersionId)).not.toContain(target.itemVersionId);
    expect(result.skeletonMatches.map((c) => c.itemVersionId)).not.toContain(target.itemVersionId);
    expect(result.trigramMatches.map((c) => c.itemVersionId)).not.toContain(target.itemVersionId);
  });
});
