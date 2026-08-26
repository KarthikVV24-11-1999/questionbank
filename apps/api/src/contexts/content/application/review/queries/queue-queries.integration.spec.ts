import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../../testing/database.js';
import { expectError, expectValue } from '../../../../../testing/expect-result.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../../../testing/content-fixtures.js';
import { createItem, transitionItem, type Item } from '../../../domain/item.js';
import { createItemVersion } from '../../../domain/item-version.js';
import { createReviewDecision } from '../../../domain/review-decision.js';
import type { ApplicationContext } from '../../ports.js';
import { PostgresItemRepository } from '../../../infrastructure/item.repository.js';
import { PostgresReviewDecisionRepository } from '../../../infrastructure/review-decision.repository.js';
import { PostgresReviewEscalationRepository } from '../../../infrastructure/review/review-escalation.repository.js';
import { PostgresTransactionRunner } from '../../../infrastructure/transaction-runner.js';
import {
  GetQueueHealthHandler,
  GetReviewerThroughputHandler,
  type QueueHealthDependencies,
  type ThroughputDependencies,
} from './queue-queries.js';

/**
 * M4-33, DEC-M4-13. `GetQueueHealth` derives its overdue list live over a
 * queue whose `content.review_escalation` table is left empty throughout —
 * the case that fails if the query ever reads that table instead of
 * deriving from `ageState`. `GetReviewerThroughput` runs over synthetic,
 * hand-placed `decided_at` timestamps and is checked against the exact
 * arithmetic answer, never against a real reviewer's pace.
 */

let database: TestDatabase;
let items: PostgresItemRepository;
let decisions: PostgresReviewDecisionRepository;
let escalations: PostgresReviewEscalationRepository;
let runner: PostgresTransactionRunner;

const POLICY = { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 };
const NOW = new Date('2026-08-25T09:00:00.000Z');

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  decisions = new PostgresReviewDecisionRepository(database.pool);
  escalations = new PostgresReviewEscalationRepository(database.pool);
  runner = new PostgresTransactionRunner(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-9000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['author'] };
const contentOps: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['content_ops'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-queue' });

function queueHealthDeps(): QueueHealthDependencies {
  return { items, escalations, reviewPolicy: POLICY };
}
function throughputDeps(): ThroughputDependencies {
  return { reviews: decisions };
}

async function inReviewItem(stateEnteredAt: string, subject = `queue-${freshUuid()}`): Promise<Item> {
  const version = expectValue(
    createItemVersion(
      {
        versionId: freshUuid(),
        versionNo: 1,
        itemType: 'SINGLE_CORRECT_MCQ',
        stem: textBody('A block slides down a frictionless ramp.'),
        responseSpec: singleCorrectSpec(),
        taxonomyTags: [
          { conceptIdentityId: freshUuid(), taxonomyVersionId: freshUuid(), weight: 1, isPrimary: true },
        ],
        difficultyEstimate: 'moderate',
        provenance: originalProvenance(),
        licensing: { status: 'owned' },
        authoredBy: AUTHOR,
        createdAt: NOW.toISOString(),
      },
      { latestPlausibleYear: 2026 },
    ),
  );
  const created = expectValue(
    createItem({ itemId: freshUuid(), itemType: 'SINGLE_CORRECT_MCQ', initialVersion: version, authoringSubject: subject }),
  );
  expectValue(await items.save(created));
  const submitted = expectValue(transitionItem(created, { transition: 'submit_for_review', stateEnteredAt }));
  expectValue(await items.save(submitted));
  return submitted;
}

function hoursBefore(hours: number): string {
  return new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('GetQueueHealthHandler (M4-33, DEC-M4-13)', () => {
  it('reports depth by subject and an age histogram in the M4-05 bands, over content.review_escalation left empty', async () => {
    const subjectA = `depth-a-${freshUuid()}`;
    const subjectB = `depth-b-${freshUuid()}`;
    await inReviewItem(hoursBefore(1), subjectA); // fresh
    await inReviewItem(hoursBefore(50), subjectA); // warn
    await inReviewItem(hoursBefore(80), subjectB); // escalated

    const result = expectValue(
      await new GetQueueHealthHandler(queueHealthDeps()).handle({ now: NOW.toISOString() }, as(contentOps)),
    );

    const depthA = result.depthBySubject.find((d) => d.subject === subjectA);
    const depthB = result.depthBySubject.find((d) => d.subject === subjectB);
    expect(depthA?.depth).toBe(2);
    expect(depthB?.depth).toBe(1);

    const bands = new Map(result.ageHistogram.map((b) => [b.band, b.count]));
    expect(bands.get('fresh')).toBeGreaterThanOrEqual(1);
    expect(bands.get('warn')).toBeGreaterThanOrEqual(1);
    expect(bands.get('escalated')).toBeGreaterThanOrEqual(1);
  });

  it('derives the overdue list from ageState, with content.review_escalation empty throughout — the case that fails if it reads the table', async () => {
    const subject = `overdue-${freshUuid()}`;
    const overdueItem = await inReviewItem(hoursBefore(POLICY.escalateAfterHours + 1), subject);
    await inReviewItem(hoursBefore(1), subject); // fresh — must not appear

    const escalationRows = await database.pool.query(`SELECT count(*)::int AS n FROM content.review_escalation`);
    expect((escalationRows.rows[0] as { n: number }).n).toBe(0);

    const result = expectValue(
      await new GetQueueHealthHandler(queueHealthDeps()).handle({ now: NOW.toISOString() }, as(contentOps)),
    );
    const overdueIds = result.overdue.map((o) => o.itemVersionId);
    expect(overdueIds).toContain(overdueItem.versions[0]!.versionId);
    expect(result.overdue.every((o) => o.notifiedAt === undefined)).toBe(true);
  });

  it('reports notifiedAt separately from overdue status when Content Ops has been notified', async () => {
    const subject = `notified-${freshUuid()}`;
    const overdueItem = await inReviewItem(hoursBefore(POLICY.escalateAfterHours + 1), subject);
    const versionId = overdueItem.versions[0]!.versionId;
    await runner.run((tx) =>
      escalations.escalateIfNew(
        { itemId: overdueItem.itemId, itemVersionId: versionId, subject, reason: 'r', escalatedAt: hoursBefore(1) },
        {
          eventId: freshUuid(),
          eventType: 'ItemReviewEscalated',
          schemaVersion: 1,
          occurredAt: NOW,
          principal: contentOps,
          correlationId: 'corr-queue',
          payload: { itemId: overdueItem.itemId, itemVersionId: versionId, subject, targetRoleType: 'content_ops' },
        },
        tx,
      ),
    );

    const result = expectValue(
      await new GetQueueHealthHandler(queueHealthDeps()).handle({ now: NOW.toISOString() }, as(contentOps)),
    );
    const found = result.overdue.find((o) => o.itemVersionId === versionId);
    expect(found?.notifiedAt).toBe(hoursBefore(1));
  });

  it('refuses a reviewer — capacity planning is Content Ops’ surface', async () => {
    const reviewer: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
    const refused = await new GetQueueHealthHandler(queueHealthDeps()).handle({ now: NOW.toISOString() }, as(reviewer));
    expect(expectError(refused).kind).toBe('Authorization');
  });

  it('is deterministic — the same queue yields the same histogram and depth twice', async () => {
    const subject = `determinism-${freshUuid()}`;
    await inReviewItem(hoursBefore(10), subject);
    await inReviewItem(hoursBefore(60), subject);

    const first = expectValue(
      await new GetQueueHealthHandler(queueHealthDeps()).handle({ now: NOW.toISOString() }, as(contentOps)),
    );
    const second = expectValue(
      await new GetQueueHealthHandler(queueHealthDeps()).handle({ now: NOW.toISOString() }, as(contentOps)),
    );
    expect(first.ageHistogram).toEqual(second.ageHistogram);
    expect(first.depthBySubject).toEqual(second.depthBySubject);
  });
});

describe('GetReviewerThroughputHandler (M4-33) — the timing instrument, over synthetic timestamps', () => {
  it('returns the exact arithmetic answer for one reviewer', async () => {
    const reviewer: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
    const from = '2026-08-20T00:00:00.000Z';
    const to = '2026-08-20T10:00:00.000Z'; // 10 hours
    for (const decidedAt of ['2026-08-20T01:00:00.000Z', '2026-08-20T05:00:00.000Z', '2026-08-20T09:00:00.000Z']) {
      expectValue(
        await decisions.record(
          expectValue(
            createReviewDecision({
              decisionId: freshUuid(),
              ownerType: 'item_version',
              ownerVersionId: freshUuid(),
              reviewer,
              outcome: 'approve',
              decidedAt,
              candidatesShownIds: [],
            }),
          ),
        ),
      );
    }

    const result = expectValue(
      await new GetReviewerThroughputHandler(throughputDeps()).handle({ from, to }, as(reviewer)),
    );
    expect(result.hours).toBe(10);
    expect(result.aggregate.decisionCount).toBe(3);
    expect(result.aggregate.decisionsPerHour).toBeCloseTo(0.3, 10);
    expect(result.perReviewer).toEqual([{ reviewerId: reviewer.id, decisionCount: 3, decisionsPerHour: 0.3 }]);
  });

  it('refuses a reviewer reading another reviewer’s throughput — self-scoped, no reviewerId to spoof', async () => {
    const reviewerA: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
    const reviewerB: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
    const from = '2026-08-21T00:00:00.000Z';
    const to = '2026-08-21T05:00:00.000Z';
    expectValue(
      await decisions.record(
        expectValue(
          createReviewDecision({
            decisionId: freshUuid(),
            ownerType: 'item_version',
            ownerVersionId: freshUuid(),
            reviewer: reviewerB,
            outcome: 'approve',
            decidedAt: '2026-08-21T02:00:00.000Z',
            candidatesShownIds: [],
          }),
        ),
      ),
    );

    const result = expectValue(
      await new GetReviewerThroughputHandler(throughputDeps()).handle({ from, to }, as(reviewerA)),
    );
    // Not refused at the policy — both roles may call it — but the result
    // itself carries none of reviewerB's data, which is the actual rule.
    expect(result.perReviewer).toEqual([]);
    expect(result.aggregate.decisionCount).toBe(0);
  });

  it('lets content_ops see every reviewer’s breakdown and the true aggregate', async () => {
    const reviewerA: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
    const reviewerB: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
    const from = '2026-08-22T00:00:00.000Z';
    const to = '2026-08-22T04:00:00.000Z'; // 4 hours
    for (const [reviewer, decidedAt] of [
      [reviewerA, '2026-08-22T01:00:00.000Z'],
      [reviewerB, '2026-08-22T02:00:00.000Z'],
      [reviewerB, '2026-08-22T03:00:00.000Z'],
    ] as const) {
      expectValue(
        await decisions.record(
          expectValue(
            createReviewDecision({
              decisionId: freshUuid(),
              ownerType: 'item_version',
              ownerVersionId: freshUuid(),
              reviewer,
              outcome: 'approve',
              decidedAt,
              candidatesShownIds: [],
            }),
          ),
        ),
      );
    }

    const result = expectValue(
      await new GetReviewerThroughputHandler(throughputDeps()).handle({ from, to }, as(contentOps)),
    );
    expect(result.aggregate.decisionCount).toBe(3);
    expect(result.aggregate.decisionsPerHour).toBeCloseTo(0.75, 10);
    const byId = new Map(result.perReviewer.map((r) => [r.reviewerId, r.decisionCount]));
    expect(byId.get(reviewerA.id)).toBe(1);
    expect(byId.get(reviewerB.id)).toBe(2);
  });

  it('is deterministic — the same range yields the same numbers twice', async () => {
    const reviewer: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] };
    const from = '2026-08-23T00:00:00.000Z';
    const to = '2026-08-23T02:00:00.000Z';
    expectValue(
      await decisions.record(
        expectValue(
          createReviewDecision({
            decisionId: freshUuid(),
            ownerType: 'item_version',
            ownerVersionId: freshUuid(),
            reviewer,
            outcome: 'approve',
            decidedAt: '2026-08-23T01:00:00.000Z',
            candidatesShownIds: [],
          }),
        ),
      ),
    );

    const first = expectValue(await new GetReviewerThroughputHandler(throughputDeps()).handle({ from, to }, as(reviewer)));
    const second = expectValue(await new GetReviewerThroughputHandler(throughputDeps()).handle({ from, to }, as(reviewer)));
    expect(first).toEqual(second);
  });
});
