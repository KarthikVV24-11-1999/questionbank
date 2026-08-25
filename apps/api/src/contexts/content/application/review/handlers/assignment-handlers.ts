import { err, ok, type Result } from '../../../domain/result.js';
import type { ContentError } from '../../../domain/content-error.js';
import type { FingerprintRepository, ItemRepository } from '../../../domain/repository-ports.js';
import type { ReviewAssignmentRepository } from '../../../domain/repository-ports.js';
import type { ReviewAssignment } from '../../../domain/review/review-assignment.js';
import type { ReviewPolicy } from '../../../domain/review/review-policy.js';
import {
  exactHash,
  normalizedText,
  skeletonHash,
  type ItemFingerprintFacts,
} from '../../../domain/review/fingerprint.js';
import { optionsOf } from '../../../domain/response-specification.js';
import { applicationError, authorize, authorizeSubjectScope, type ApplicationError } from '../../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock } from '../../ports.js';
import {
  CLAIM_NEXT_FOR_REVIEW_POLICY,
  EXTEND_LEASE_POLICY,
  REASSIGN_REVIEW_POLICY,
  RELEASE_ASSIGNMENT_POLICY,
} from '../policies.js';
import type { ClaimNextForReview, ExtendLease, ReassignReview, ReleaseAssignment } from '../commands/assignment-commands.js';

/**
 * Claim, release, reassign, extend (M4-27) — the queue, driven. Under
 * DEC-M4-7 these are ordinary content handlers; there is no facade and no
 * cross-context transaction, only content's own `ReviewAssignmentRepository`.
 *
 * **Candidate resolution happens inside `claimNext` (M4-18), never through a
 * separate query.** `ListSubmittedForReview` (M4-16) runs its own `SELECT` on
 * its own connection; routing a claim through it would reopen the
 * SELECT-then-INSERT race `claimNext`'s single locking statement exists to
 * close. See the dated correction on M4-27's entry in
 * `docs/tasks/M4-GOVERNANCE-REVIEW.md`.
 *
 * **Ordering is `'escalated_first'`, always** — `claimNext`'s two supported
 * orderings, escalated-then-oldest. DEC-M4-9's full precedence also names
 * concept batching and confidence, computed from M3's validation report;
 * wiring those into the atomic claim's `SELECT … FOR UPDATE SKIP LOCKED`
 * would mean scoring every candidate row inside the lock, which this task
 * does not attempt and which the candidate-resolution constraint above rules
 * out doing any other way. A real, stated gap — not a silent one.
 *
 * **Self-review is not re-checked here.** `claimNext` and `assign` both
 * already re-check it, on the same terms, inside
 * `infrastructure/review/review-assignment.repository.ts` — the third of
 * `self-review.ts`'s three call sites. A fourth copy in this file would be
 * exactly the drift M4-04's "one function" rule exists to prevent.
 *
 * **The lease-extension cap.** `ExtendLeaseHandler` bounds the new expiry at
 * `claimedAt + 2 × leaseHours` — one full lease period beyond the original,
 * never more. The trigger (M4-27's own migration) only enforces the *shape*
 * of a lease move (forward, alone, versioned); the *policy* of how far
 * belongs here, in the handler, reading `ReviewPolicy` the same way every
 * other review threshold does.
 */

export interface AssignmentDependencies {
  readonly assignments: ReviewAssignmentRepository;
  readonly items: ItemRepository;
  readonly fingerprints: FingerprintRepository;
  readonly reviewPolicy: ReviewPolicy;
  readonly clock: Clock;
  readonly audit: AuditRecorder;
}

/**
 * `ReviewAssignmentRepository`'s errors are already `ContentError`-shaped
 * (`domain/repository-ports.ts`'s `RepositoryError`); this is the same
 * one-line unpacking `lifecycle-handlers.ts`'s own `fromContent` does. Not a
 * second implementation of a *rule* — there is no judgement here to drift,
 * only field names — and `application/review/**` cannot import that file's
 * private helper (DEC-M4-7's sub-boundary).
 */
function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

const HOUR_MS = 60 * 60 * 1000;

abstract class AssignmentHandler {
  constructor(protected readonly deps: AssignmentDependencies) {}

  protected async writeAudit(
    context: ApplicationContext,
    action: string,
    targetId: string,
  ): Promise<void> {
    await this.deps.audit.record({
      principal: context.principal,
      action,
      targetContext: 'content',
      targetType: 'ReviewAssignment',
      targetId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });
  }

  /** Ownership: only the reviewer who holds the claim may release or extend it — `authorizeDraftAccess`'s discipline, inline, since neither policy exempts Content Ops. */
  protected refuseUnlessOwner(
    assignment: ReviewAssignment,
    context: ApplicationContext,
  ): Result<true, ApplicationError> {
    if (assignment.reviewer.id === context.principal.id) return ok(true);
    return err(
      applicationError(
        'Authorization',
        'NOT_THE_ASSIGNMENT_HOLDER',
        `principal ${context.principal.id} does not hold review assignment ${assignment.assignmentId}`,
        'assignmentId',
      ),
    );
  }
}

export class ClaimNextForReviewHandler extends AssignmentHandler {
  readonly name = 'ClaimNextForReview';
  readonly policy = CLAIM_NEXT_FOR_REVIEW_POLICY;

  async handle(
    command: ClaimNextForReview,
    context: ApplicationContext,
  ): Promise<Result<ReviewAssignment, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const scoped = authorizeSubjectScope(command.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const now = this.deps.clock.now();
    const claimed = await this.deps.assignments.claimNext({
      subject: command.subject,
      reviewer: context.principal,
      ordering: 'escalated_first',
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.deps.reviewPolicy.leaseHours * HOUR_MS).toISOString(),
      escalateAfterHours: this.deps.reviewPolicy.escalateAfterHours,
    });
    if (!claimed.ok) return err(fromContent(claimed.error));

    await this.writeAudit(context, this.name, claimed.value.assignmentId);
    await this.ensureFingerprint(claimed.value);
    return ok(claimed.value);
  }

  /**
   * Computes and persists the claimed item's fingerprint if none exists yet
   * (M4-32, DEC-M4-2, resolving the 2026-08-21 OPEN flag). Runs after
   * `claimNext`'s transaction has already committed — this is the read that
   * builds the claimed item's payload, which already needs the full
   * `ItemVersion`, so the `ContentBody` is in hand with no extra fetch
   * `claimNext` (M4-18) would otherwise have had to make inside its one
   * locking statement.
   *
   * A lookup or hashing failure here never rolls back or invalidates the
   * claim — the claim already committed. It is reported the same way
   * `GetDuplicateCandidates` reports staleness: by there being no record
   * yet, `'not_evaluated'`, honestly, rather than a claim the reviewer holds
   * disappearing because a hash could not be computed.
   */
  private async ensureFingerprint(assignment: ReviewAssignment): Promise<void> {
    try {
      const existing = await this.deps.fingerprints.findByItemVersionId(assignment.itemVersionId);
      if (!existing.ok || existing.value !== undefined) return;

      const item = await this.deps.items.findById(assignment.itemId);
      if (!item.ok) return;
      const version = item.value.versions.find((candidate) => candidate.versionId === assignment.itemVersionId);
      if (version === undefined) return;

      const facts: ItemFingerprintFacts = {
        stem: version.stem,
        options: optionsOf(version.responseSpec).map((option) => option.body),
      };
      await this.deps.fingerprints.save({
        itemId: assignment.itemId,
        itemVersionId: assignment.itemVersionId,
        subject: assignment.subject,
        exactHash: exactHash(facts),
        skeletonHash: skeletonHash(facts),
        normalizedText: normalizedText(facts),
        computedAt: this.deps.clock.now().toISOString(),
      });
    } catch {
      // Advisory, per DEC-M4-2 — never surfaces to the caller.
    }
  }
}

export class ReleaseAssignmentHandler extends AssignmentHandler {
  readonly name = 'ReleaseAssignment';
  readonly policy = RELEASE_ASSIGNMENT_POLICY;

  async handle(
    command: ReleaseAssignment,
    context: ApplicationContext,
  ): Promise<Result<ReviewAssignment, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.assignments.findById(command.assignmentId);
    if (!found.ok) return err(fromContent(found.error));

    const owns = this.refuseUnlessOwner(found.value, context);
    if (!owns.ok) return err(owns.error);

    const released = await this.deps.assignments.release(
      command.assignmentId,
      this.deps.clock.now().toISOString(),
      found.value.aggregateVersion,
    );
    if (!released.ok) return err(fromContent(released.error));

    await this.writeAudit(context, this.name, command.assignmentId);
    return ok(released.value);
  }
}

export class ReassignReviewHandler extends AssignmentHandler {
  readonly name = 'ReassignReview';
  readonly policy = REASSIGN_REVIEW_POLICY;

  async handle(
    command: ReassignReview,
    context: ApplicationContext,
  ): Promise<Result<ReviewAssignment, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const now = this.deps.clock.now();
    const assigned = await this.deps.assignments.assign({
      itemVersionId: command.itemVersionId,
      subject: command.subject,
      reviewer: { kind: 'human', id: command.reviewerId, roleContext: ['reviewer'] },
      now: now.toISOString(),
      leaseExpiresAt: new Date(now.getTime() + this.deps.reviewPolicy.leaseHours * HOUR_MS).toISOString(),
    });
    if (!assigned.ok) return err(fromContent(assigned.error));

    await this.writeAudit(context, this.name, assigned.value.assignmentId);
    return ok(assigned.value);
  }
}

export class ExtendLeaseHandler extends AssignmentHandler {
  readonly name = 'ExtendLease';
  readonly policy = EXTEND_LEASE_POLICY;

  async handle(
    command: ExtendLease,
    context: ApplicationContext,
  ): Promise<Result<ReviewAssignment, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.assignments.findById(command.assignmentId);
    if (!found.ok) return err(fromContent(found.error));
    const assignment = found.value;

    const owns = this.refuseUnlessOwner(assignment, context);
    if (!owns.ok) return err(owns.error);

    const now = this.deps.clock.now();
    const leaseWindowMs = this.deps.reviewPolicy.leaseHours * HOUR_MS;
    // Never more than one full lease period beyond the original claim — the
    // policy half of the bound; the trigger's own "must move forward" is the
    // tamper-shape half, and this check is what turns that into a named,
    // non-opaque refusal before the write is even attempted.
    const cap = Date.parse(assignment.claimedAt) + 2 * leaseWindowMs;
    const requested = now.getTime() + leaseWindowMs;
    const newLeaseExpiresAt = new Date(Math.min(requested, cap)).toISOString();

    if (Date.parse(newLeaseExpiresAt) <= Date.parse(assignment.leaseExpiresAt)) {
      return err(
        applicationError(
          'PreconditionFailed',
          'LEASE_EXTENSION_EXHAUSTED',
          `review assignment ${command.assignmentId} has already been extended to its cap of one additional lease period`,
          'assignmentId',
        ),
      );
    }

    const extended = await this.deps.assignments.extendLease(
      command.assignmentId,
      newLeaseExpiresAt,
      assignment.aggregateVersion,
    );
    if (!extended.ok) return err(fromContent(extended.error));

    await this.writeAudit(context, this.name, command.assignmentId);
    return ok(extended.value);
  }
}
