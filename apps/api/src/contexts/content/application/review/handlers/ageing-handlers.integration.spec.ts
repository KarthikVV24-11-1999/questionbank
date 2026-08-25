import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../../testing/database.js';
import { expectError, expectValue } from '../../../../../testing/expect-result.js';
import { originalProvenance, singleCorrectSpec, textBody } from '../../../../../testing/content-fixtures.js';
import { createItem, transitionItem, type Item } from '../../../domain/item.js';
import { createItemVersion } from '../../../domain/item-version.js';
import { InMemoryAuditRecorder, type ApplicationContext, type Clock, type IdentifierFactory } from '../../ports.js';
import { PostgresItemRepository } from '../../../infrastructure/item.repository.js';
import { PostgresReviewAssignmentRepository } from '../../../infrastructure/review/review-assignment.repository.js';
import { PostgresReviewEscalationRepository } from '../../../infrastructure/review/review-escalation.repository.js';
import { PostgresTransactionRunner } from '../../../infrastructure/transaction-runner.js';
import { err, ok, type Result } from '../../../domain/result.js';
import { validationError } from '../../../domain/content-error.js';
import type {
  ItemRepository,
  RepositoryError,
  ReviewAssignmentRepository,
  ReviewEscalationRepository,
} from '../../../domain/repository-ports.js';
import { SweepReviewAgeingHandler, type AgeingDependencies } from './ageing-handlers.js';

function forced(): RepositoryError {
  return validationError('PERSISTENCE_REJECTED', 'forced for this test', 'test');
}

let database: TestDatabase;
let items: PostgresItemRepository;
let assignments: PostgresReviewAssignmentRepository;
let escalations: PostgresReviewEscalationRepository;

const POLICY = { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 };
const BASE_NOW = new Date('2026-08-21T09:00:00.000Z');
const clock: Clock = { now: () => BASE_NOW };

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  items = new PostgresItemRepository(database.pool);
  assignments = new PostgresReviewAssignmentRepository(database.pool);
  escalations = new PostgresReviewEscalationRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-d000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const AUTHOR: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['author'] };
const contentOps: PrincipalRef = { kind: 'human', id: freshUuid(), roleContext: ['content_ops'] };
const as = (principal: PrincipalRef): ApplicationContext => ({ principal, correlationId: 'corr-1' });

function deps(): AgeingDependencies & { readonly audit: InMemoryAuditRecorder } {
  return {
    items,
    assignments,
    escalations,
    reviewPolicy: POLICY,
    transactions: new PostgresTransactionRunner(database.pool),
    clock,
    identifiers: { next: () => freshUuid() } satisfies IdentifierFactory,
    audit: new InMemoryAuditRecorder(),
  };
}

/** An item, submitted for review, with a specific `stateEnteredAt` — the ageing sweep's own clock. */
async function inReviewItem(stateEnteredAt: string, subject = `ageing-${freshUuid()}`): Promise<Item> {
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
        createdAt: BASE_NOW.toISOString(),
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
  return new Date(BASE_NOW.getTime() - hours * 60 * 60 * 1000).toISOString();
}

describe('SweepReviewAgeingHandler (M4-31, FR-ADM-05, DEC-M4-1, DEC-M4-15)', () => {
  it('releases expired leases', async () => {
    const item = await inReviewItem(hoursBefore(1));
    const versionId = item.versions[0]!.versionId;
    const claimed = expectValue(
      await assignments.assign({
        itemVersionId: versionId,
        subject: item.authoringSubject as string,
        reviewer: { kind: 'human', id: freshUuid(), roleContext: ['reviewer'] },
        now: hoursBefore(6),
        leaseExpiresAt: hoursBefore(2), // expired an hour before BASE_NOW
      }),
    );

    const result = expectValue(await new SweepReviewAgeingHandler(deps()).handle({ now: BASE_NOW.toISOString() }, as(contentOps)));
    expect(result.releasedAssignments.map((a) => a.assignmentId)).toContain(claimed.assignmentId);

    const reloaded = expectValue(await assignments.findById(claimed.assignmentId));
    expect(reloaded.state).toBe('expired');
  });

  it('emits an escalation exactly at the threshold, and nothing below it', async () => {
    const atThreshold = await inReviewItem(hoursBefore(POLICY.escalateAfterHours));
    const belowThreshold = await inReviewItem(hoursBefore(POLICY.escalateAfterHours - 0.5));

    const result = expectValue(await new SweepReviewAgeingHandler(deps()).handle({ now: BASE_NOW.toISOString() }, as(contentOps)));

    expect(result.escalatedItemVersionIds).toContain(atThreshold.versions[0]!.versionId);
    expect(result.escalatedItemVersionIds).not.toContain(belowThreshold.versions[0]!.versionId);

    const escalatedRow = await database.pool.query(`SELECT 1 FROM content.review_escalation WHERE item_version_id = $1`, [
      atThreshold.versions[0]!.versionId,
    ]);
    expect(escalatedRow.rowCount).toBe(1);
    const notEscalatedRow = await database.pool.query(`SELECT 1 FROM content.review_escalation WHERE item_version_id = $1`, [
      belowThreshold.versions[0]!.versionId,
    ]);
    expect(notEscalatedRow.rowCount).toBe(0);

    const outboxed = await database.pool.query(
      `SELECT 1 FROM platform.outbox_message WHERE aggregate_id = $1 AND event_type = 'ItemReviewEscalated'`,
      [atThreshold.itemId],
    );
    expect(outboxed.rowCount).toBe(1);
  });

  it('escalates once, not twice — a second sweep at the same instant emits nothing further', async () => {
    const item = await inReviewItem(hoursBefore(POLICY.escalateAfterHours + 1));

    const first = expectValue(await new SweepReviewAgeingHandler(deps()).handle({ now: BASE_NOW.toISOString() }, as(contentOps)));
    expect(first.escalatedItemVersionIds).toContain(item.versions[0]!.versionId);

    const second = expectValue(await new SweepReviewAgeingHandler(deps()).handle({ now: BASE_NOW.toISOString() }, as(contentOps)));
    expect(second.escalatedItemVersionIds).not.toContain(item.versions[0]!.versionId);

    const rows = await database.pool.query(`SELECT count(*)::int AS n FROM content.review_escalation WHERE item_version_id = $1`, [
      item.versions[0]!.versionId,
    ]);
    expect((rows.rows[0] as { n: number }).n).toBe(1);
  });

  it('a sweep at a clock-skewed earlier instant is a no-op for that item, not a negative age', async () => {
    const item = await inReviewItem(BASE_NOW.toISOString());

    // now is earlier than the item's own stateEnteredAt — ageState's own
    // refusal, which this handler must treat as "skip this item", not fail
    // the whole sweep.
    const result = expectValue(
      await new SweepReviewAgeingHandler(deps()).handle({ now: hoursBefore(1) }, as(contentOps)),
    );
    expect(result.escalatedItemVersionIds).not.toContain(item.versions[0]!.versionId);
  });

  it('is a no-op when there is nothing to sweep', async () => {
    const result = expectValue(await new SweepReviewAgeingHandler(deps()).handle({ now: BASE_NOW.toISOString() }, as(contentOps)));
    expect(result.releasedAssignments).toEqual([]);
  });

  it('refuses a principal outside Content Ops', async () => {
    const refused = await new SweepReviewAgeingHandler(deps()).handle(
      { now: BASE_NOW.toISOString() },
      as({ kind: 'human', id: freshUuid(), roleContext: ['reviewer'] }),
    );
    expect(expectError(refused).kind).toBe('Authorization');
  });

  it('reports the repository error verbatim when releasing expired leases fails', async () => {
    const failingAssignments: ReviewAssignmentRepository = {
      claimNext: (...args) => assignments.claimNext(...args),
      assign: (...args) => assignments.assign(...args),
      release: (...args) => assignments.release(...args),
      extendLease: (...args) => assignments.extendLease(...args),
      releaseExpired: async () => err(forced()),
      findById: (...args) => assignments.findById(...args),
      hasLiveClaim: (...args) => assignments.hasLiveClaim(...args),
    };
    const refused = await new SweepReviewAgeingHandler({ ...deps(), assignments: failingAssignments }).handle(
      { now: BASE_NOW.toISOString() },
      as(contentOps),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });

  it('reports the repository error verbatim when reading the submitted-for-review page fails', async () => {
    const failingItems: ItemRepository = {
      save: (...args) => items.save(...args),
      findById: (...args) => items.findById(...args),
      deleteDraft: (...args) => items.deleteDraft(...args),
      findDraftsByAuthor: (...args) => items.findDraftsByAuthor(...args),
      findPublishedVersion: (...args) => items.findPublishedVersion(...args),
      countPublishedItemsUsingStimulusVersion: (...args) => items.countPublishedItemsUsingStimulusVersion(...args),
      findSubmittedForReview: async () => err(forced()),
    };
    const refused = await new SweepReviewAgeingHandler({ ...deps(), items: failingItems }).handle(
      { now: BASE_NOW.toISOString() },
      as(contentOps),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });

  it('reports the repository error verbatim when writing an escalation fails', async () => {
    await inReviewItem(hoursBefore(POLICY.escalateAfterHours + 1));
    const failingEscalations: ReviewEscalationRepository = {
      escalateIfNew: async (): Promise<Result<boolean, RepositoryError>> => err(forced()),
      findNotifiedAt: async (): Promise<Result<ReadonlyMap<string, string>, RepositoryError>> => ok(new Map()),
    };
    const refused = await new SweepReviewAgeingHandler({ ...deps(), escalations: failingEscalations }).handle(
      { now: BASE_NOW.toISOString() },
      as(contentOps),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });

  it('pages through more than one page of submitted items without missing the second page', async () => {
    // PAGE_SIZE is 200. content.uuid_generate_v7() is time-ordered, and
    // findSubmittedForReview orders by item_id ascending, so 200 fresh
    // (non-escalating) items inserted first, then one old (escalating) item
    // inserted last, land that one item on the second page specifically —
    // it is found only if the cursor is actually followed.
    const subject = `pagination-${freshUuid()}`;
    for (let i = 0; i < 200; i += 1) {
      await inReviewItem(hoursBefore(1), subject);
    }
    const onSecondPage = await inReviewItem(hoursBefore(POLICY.escalateAfterHours + 1), subject);

    const result = expectValue(await new SweepReviewAgeingHandler(deps()).handle({ now: BASE_NOW.toISOString() }, as(contentOps)));
    expect(result.escalatedItemVersionIds).toContain(onSecondPage.versions[0]!.versionId);
  }, 30000);
});
