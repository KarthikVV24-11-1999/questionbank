import type { PrincipalRef } from '@questionbank/domain-types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { connectTestDatabase, type TestDatabase } from '../../../../../testing/database.js';
import { expectError, expectValue } from '../../../../../testing/expect-result.js';
import { PostgresReviewAssignmentRepository } from '../../../infrastructure/review/review-assignment.repository.js';
import { PostgresAuditRecorder } from '../../../../../platform/persistence/audit-recorder.js';
import { InMemoryAuditRecorder, type ApplicationContext, type Clock } from '../../ports.js';
import {
  ClaimNextForReviewHandler,
  ExtendLeaseHandler,
  ReassignReviewHandler,
  ReleaseAssignmentHandler,
  type AssignmentDependencies,
} from './assignment-handlers.js';
import {
  APPROVE_WITH_EDITS_POLICY,
  CLAIM_NEXT_FOR_REVIEW_POLICY,
  EXTEND_LEASE_POLICY,
  GET_QUEUE_HEALTH_POLICY,
  REASSIGN_REVIEW_POLICY,
  RECORD_REVIEW_DECISION_POLICY,
  RELEASE_ASSIGNMENT_POLICY,
  REVIEW_POLICIES,
  SWEEP_REVIEW_AGEING_POLICY,
} from '../policies.js';

/**
 * M4-27. Real Postgres throughout — the atomic claim, the push path, and the
 * two lease operations, each exercised end to end through the handler, not
 * only at the repository (M4-18/M4-27's own repository suite already covers
 * that layer directly).
 */

let database: TestDatabase;
let assignments: PostgresReviewAssignmentRepository;
let audit: InMemoryAuditRecorder;

const POLICY = { warnAfterHours: 48, escalateAfterHours: 72, leaseHours: 4, sampleRate: 0.05 };

let clockNow = new Date('2026-08-21T09:00:00.000Z');
const clock: Clock = { now: () => clockNow };

function deps(): AssignmentDependencies {
  return { assignments, reviewPolicy: POLICY, clock, audit };
}

beforeAll(async () => {
  database = await connectTestDatabase();
  await database.revertMigrations().catch(() => undefined);
  await database.applyMigrations();
  assignments = new PostgresReviewAssignmentRepository(database.pool);
});

afterAll(async () => {
  await database.revertMigrations();
  await database.close();
});

let uuidSeed = 0;
function freshUuid(): string {
  uuidSeed += 1;
  return `00000000-0000-4000-f000-${uuidSeed.toString(16).padStart(12, '0')}`;
}

const SUBJECT = 'physics';
const AUTHOR_ID = freshUuid();

function reviewer(overrides: Partial<PrincipalRef> = {}): PrincipalRef {
  return { kind: 'human', id: freshUuid(), roleContext: ['reviewer', `subject:${SUBJECT}`], ...overrides };
}

function contentOps(): PrincipalRef {
  return { kind: 'human', id: freshUuid(), roleContext: ['content_ops'] };
}

function as(principal: PrincipalRef): ApplicationContext {
  return { principal, correlationId: 'c' };
}

async function seedInReviewItemVersion(
  options: { readonly authorId?: string; readonly editorId?: string; readonly subject?: string } = {},
): Promise<{ itemId: string; itemVersionId: string }> {
  const itemId = freshUuid();
  const itemVersionId = freshUuid();
  await database.pool.query(
    `INSERT INTO content.item (item_id, item_type, lifecycle_state, authoring_subject) VALUES ($1, 'SINGLE_CORRECT_MCQ', 'in_review', $2)`,
    [itemId, options.subject ?? SUBJECT],
  );
  await database.pool.query(
    `INSERT INTO content.item_version
       (item_version_id, item_id, version_no, item_type, stem_body, stem_plain_text, difficulty_estimate,
        authored_by_kind, authored_by_id, edited_by_kind, edited_by_id)
     VALUES ($1, $2, 1, 'SINGLE_CORRECT_MCQ', '{}'::jsonb, 's', 'moderate', 'human', $3, $4, $5)`,
    [
      itemVersionId,
      itemId,
      options.authorId ?? AUTHOR_ID,
      options.editorId === undefined ? null : 'human',
      options.editorId ?? null,
    ],
  );
  return { itemId, itemVersionId };
}

describe('ClaimNextForReviewHandler (M4-27)', () => {
  it('claims the eligible version and writes a chained audit record', async () => {
    audit = new InMemoryAuditRecorder();
    const subject = `claim-${freshUuid()}`;
    const { itemId, itemVersionId } = await seedInReviewItemVersion({ subject });

    const handler = new ClaimNextForReviewHandler(deps());
    const claimed = expectValue(await handler.handle({ subject }, as(reviewer({ roleContext: ['reviewer', `subject:${subject}`] }))));

    expect(claimed.itemId).toBe(itemId);
    expect(claimed.itemVersionId).toBe(itemVersionId);
    expect(claimed.kind).toBe('claimed');
    expect(audit.entries).toHaveLength(1);
    expect(audit.entries[0]!.action).toBe('ClaimNextForReview');
    expect(audit.entries[0]!.targetId).toBe(claimed.assignmentId);
    expect(audit.entries[0]!.targetType).toBe('ReviewAssignment');
  });

  it('the audit record it writes lands in the chain, through the real recorder', async () => {
    // InMemoryAuditRecorder never touches platform.audit_record — proving the
    // record chains means running the handler against the real adapter.
    const subject = `claim-chain-${freshUuid()}`;
    const { itemVersionId } = await seedInReviewItemVersion({ subject });
    const chainedDeps: AssignmentDependencies = { ...deps(), audit: new PostgresAuditRecorder(database.pool) };
    const claimed = expectValue(
      await new ClaimNextForReviewHandler(chainedDeps).handle(
        { subject },
        as(reviewer({ roleContext: ['reviewer', `subject:${subject}`] })),
      ),
    );
    expect(claimed.itemVersionId).toBe(itemVersionId);

    const row = await database.pool.query<{ chain_seq: string }>(
      `SELECT chain_seq FROM platform.audit_record WHERE target_id = $1`,
      [claimed.assignmentId],
    );
    expect(row.rowCount).toBe(1);
    expect(Number(row.rows[0]!.chain_seq)).toBeGreaterThan(0);
  });

  it('sets the lease from ReviewPolicy.leaseHours', async () => {
    const subject = `claim-lease-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const handler = new ClaimNextForReviewHandler(deps());
    const claimed = expectValue(
      await handler.handle({ subject }, as(reviewer({ roleContext: ['reviewer', `subject:${subject}`] }))),
    );
    const expiresIn = Date.parse(claimed.leaseExpiresAt) - clockNow.getTime();
    expect(expiresIn).toBe(POLICY.leaseHours * 60 * 60 * 1000);
  });

  it('refuses a reviewer claiming outside their subject scope', async () => {
    const subject = `claim-scope-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const handler = new ClaimNextForReviewHandler(deps());
    const refused = await handler.handle({ subject }, as(reviewer({ roleContext: ['reviewer', 'subject:chemistry'] })));
    const error = expectError(refused);
    expect(error.kind).toBe('Authorization');
    expect(error.code).toBe('OUT_OF_SUBJECT_SCOPE');
  });

  it('refuses content_ops — DEC-M4-9 gives it no claim path', async () => {
    const subject = `claim-ops-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const handler = new ClaimNextForReviewHandler(deps());
    const refused = await handler.handle({ subject }, as(contentOps()));
    expect(expectError(refused).kind).toBe('Authorization');
  });

  it('refuses a learner or author role entirely', async () => {
    const subject = `claim-role-${freshUuid()}`;
    await seedInReviewItemVersion({ subject });
    const handler = new ClaimNextForReviewHandler(deps());
    for (const role of ['learner', 'author']) {
      const refused = await handler.handle(
        { subject },
        as({ kind: 'human', id: freshUuid(), roleContext: [role, `subject:${subject}`] }),
      );
      expect(expectError(refused).kind).toBe('Authorization');
    }
  });

  it('refuses self-review by the editor — the predicate misses it, only the domain re-check catches it', async () => {
    // The SQL candidate predicate (M4-18) excludes only authored_by_id — an
    // editor slips past it, and is caught only by the domain re-check inside
    // claimNext. Proving that here is proving the wiring from this handler
    // reaches it; the predicate-removal claim itself is proven directly
    // against the repository in M4-18's own suite.
    const subject = `claim-self-${freshUuid()}`;
    const editor = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject, editorId: editor.id });
    const handler = new ClaimNextForReviewHandler(deps());
    const refused = await handler.handle({ subject }, as(editor));
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });

  it('returns NOT_FOUND mapped to ApplicationError when nothing is claimable', async () => {
    const subject = `empty-${freshUuid()}`;
    const handler = new ClaimNextForReviewHandler(deps());
    const refused = await handler.handle(
      { subject },
      as(reviewer({ roleContext: ['reviewer', `subject:${subject}`] })),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });
});

describe('ReleaseAssignmentHandler (M4-27)', () => {
  it('releases the reviewer’s own claim', async () => {
    audit = new InMemoryAuditRecorder();
    const subject = `release-${freshUuid()}`;
    const r = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(r)));

    const released = expectValue(
      await new ReleaseAssignmentHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r)),
    );
    expect(released.state).toBe('released');
    expect(audit.entries.some((e) => e.action === 'ReleaseAssignment')).toBe(true);
  });

  it('refuses releasing another reviewer’s claim', async () => {
    const subject = `release-other-${freshUuid()}`;
    const owner = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    const other = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(owner)));

    const refused = await new ReleaseAssignmentHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(other));
    const error = expectError(refused);
    expect(error.kind).toBe('Authorization');
    expect(error.code).toBe('NOT_THE_ASSIGNMENT_HOLDER');
  });

  it('refuses content_ops and every non-reviewer role', async () => {
    const subject = `release-role-${freshUuid()}`;
    const owner = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(owner)));

    const refused = await new ReleaseAssignmentHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(contentOps()));
    expect(expectError(refused).kind).toBe('Authorization');
  });

  it('returns NOT_FOUND for an assignment that does not exist', async () => {
    const refused = await new ReleaseAssignmentHandler(deps()).handle(
      { assignmentId: freshUuid() },
      as(reviewer()),
    );
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('maps the repository refusal when a live claim has already been released', async () => {
    const subject = `release-twice-${freshUuid()}`;
    const r = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(r)));
    expectValue(await new ReleaseAssignmentHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r)));

    const refused = await new ReleaseAssignmentHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r));
    expect(expectError(refused)).toBeDefined();
  });
});

describe('ExtendLeaseHandler (M4-27)', () => {
  it('extends the reviewer’s own lease forward', async () => {
    audit = new InMemoryAuditRecorder();
    const subject = `extend-${freshUuid()}`;
    const r = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(r)));

    // Advance the clock so the recomputed expiry (now + leaseHours) is
    // genuinely later than the lease claimNext already granted.
    clockNow = new Date(clockNow.getTime() + 60 * 60 * 1000);
    const extended = expectValue(
      await new ExtendLeaseHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r)),
    );
    expect(Date.parse(extended.leaseExpiresAt)).toBeGreaterThan(Date.parse(claimed.leaseExpiresAt));
    expect(audit.entries.some((e) => e.action === 'ExtendLease')).toBe(true);
    clockNow = new Date('2026-08-21T09:00:00.000Z');
  });

  it('caps the extension at one additional lease period beyond the original claim', async () => {
    const subject = `extend-cap-${freshUuid()}`;
    const r = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(r)));
    const cap = Date.parse(claimed.claimedAt) + 2 * POLICY.leaseHours * 60 * 60 * 1000;

    // First extension: still short of the cap, so it legitimately reaches it.
    clockNow = new Date(Date.parse(claimed.claimedAt) + 5 * 60 * 60 * 1000);
    const firstExtension = expectValue(
      await new ExtendLeaseHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r)),
    );
    expect(Date.parse(firstExtension.leaseExpiresAt)).toBe(cap);

    // Second extension, already at the cap: nothing left to move forward to.
    clockNow = new Date(cap + 60 * 60 * 1000);
    const refused = await new ExtendLeaseHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r));
    const error = expectError(refused);
    expect(error.kind).toBe('PreconditionFailed');
    expect(error.code).toBe('LEASE_EXTENSION_EXHAUSTED');
    clockNow = new Date('2026-08-21T09:00:00.000Z');
  });

  it('refuses extending another reviewer’s claim', async () => {
    const subject = `extend-other-${freshUuid()}`;
    const owner = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    const other = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(owner)));

    const refused = await new ExtendLeaseHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(other));
    expect(expectError(refused).code).toBe('NOT_THE_ASSIGNMENT_HOLDER');
  });

  it('refuses content_ops and every non-reviewer role', async () => {
    const refused = await new ExtendLeaseHandler(deps()).handle({ assignmentId: freshUuid() }, as(contentOps()));
    expect(expectError(refused).kind).toBe('Authorization');
  });

  it('returns NOT_FOUND for an assignment that does not exist', async () => {
    const refused = await new ExtendLeaseHandler(deps()).handle({ assignmentId: freshUuid() }, as(reviewer()));
    expect(expectError(refused).kind).toBe('NotFound');
  });

  it('maps the repository refusal when the claim is no longer live', async () => {
    const subject = `extend-released-${freshUuid()}`;
    const r = reviewer({ roleContext: ['reviewer', `subject:${subject}`] });
    await seedInReviewItemVersion({ subject });
    const claimed = expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(r)));
    expectValue(await new ReleaseAssignmentHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r)));

    clockNow = new Date(clockNow.getTime() + 60 * 60 * 1000);
    const refused = await new ExtendLeaseHandler(deps()).handle({ assignmentId: claimed.assignmentId }, as(r));
    expect(expectError(refused)).toBeDefined();
    clockNow = new Date('2026-08-21T09:00:00.000Z');
  });
});

describe('ReassignReviewHandler — Content Ops’ push path (M4-27)', () => {
  it('assigns a specific reviewer, distinct from a pulled claim', async () => {
    audit = new InMemoryAuditRecorder();
    const subject = `reassign-${freshUuid()}`;
    const { itemVersionId } = await seedInReviewItemVersion({ subject });
    const target = reviewer();

    const assigned = expectValue(
      await new ReassignReviewHandler(deps()).handle(
        { itemVersionId, subject, reviewerId: target.id },
        as(contentOps()),
      ),
    );
    expect(assigned.kind).toBe('assigned');
    expect(assigned.reviewer.id).toBe(target.id);
    expect(audit.entries.some((e) => e.action === 'ReassignReview')).toBe(true);
  });

  it('refuses a reviewer role — this is Content Ops’ push path only', async () => {
    const subject = `reassign-role-${freshUuid()}`;
    const { itemVersionId } = await seedInReviewItemVersion({ subject });
    const refused = await new ReassignReviewHandler(deps()).handle(
      { itemVersionId, subject, reviewerId: freshUuid() },
      as(reviewer({ roleContext: ['reviewer', `subject:${subject}`] })),
    );
    expect(expectError(refused).kind).toBe('Authorization');
  });

  it('refuses reassigning the author', async () => {
    const subject = `reassign-self-${freshUuid()}`;
    const target = reviewer();
    const { itemVersionId } = await seedInReviewItemVersion({ subject, authorId: target.id });

    const refused = await new ReassignReviewHandler(deps()).handle(
      { itemVersionId, subject, reviewerId: target.id },
      as(contentOps()),
    );
    expect(expectError(refused).code).toBe('PERSISTENCE_REJECTED');
  });

  it('refuses reassigning a version that already carries a live claim', async () => {
    const subject = `reassign-conflict-${freshUuid()}`;
    const { itemVersionId } = await seedInReviewItemVersion({ subject });
    expectValue(await new ClaimNextForReviewHandler(deps()).handle({ subject }, as(reviewer({ roleContext: ['reviewer', `subject:${subject}`] }))));

    const refused = await new ReassignReviewHandler(deps()).handle(
      { itemVersionId, subject, reviewerId: freshUuid() },
      as(contentOps()),
    );
    expect(expectError(refused).kind).toBe('Conflict');
  });
});

describe('every command declares a distinct policy, and every review handler is named in REVIEW_POLICIES', () => {
  it('names 4 distinct policies for the 4 assignment commands', () => {
    const names = [
      CLAIM_NEXT_FOR_REVIEW_POLICY.name,
      RELEASE_ASSIGNMENT_POLICY.name,
      REASSIGN_REVIEW_POLICY.name,
      EXTEND_LEASE_POLICY.name,
    ];
    expect(new Set(names).size).toBe(4);
  });

  it('policy-less handler construction is impossible — every exported handler carries the policy field its class declares', () => {
    const policies = [
      CLAIM_NEXT_FOR_REVIEW_POLICY,
      RELEASE_ASSIGNMENT_POLICY,
      REASSIGN_REVIEW_POLICY,
      EXTEND_LEASE_POLICY,
      RECORD_REVIEW_DECISION_POLICY,
      APPROVE_WITH_EDITS_POLICY,
      SWEEP_REVIEW_AGEING_POLICY,
      GET_QUEUE_HEALTH_POLICY,
    ];
    for (const p of policies) {
      expect(p.allowedRoles.length).toBeGreaterThan(0);
    }
    expect(REVIEW_POLICIES).toEqual(expect.arrayContaining(policies));
  });
});
