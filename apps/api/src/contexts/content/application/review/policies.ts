import { DRAFT_OVERSIGHT_ROLES, policy, type AuthorizationPolicy } from '../authorization.js';
import { ROLES } from '../../../../platform/auth/roles.js';

/**
 * The review workspace's authorization policies (M4-26, DEC-M4-7). Declared
 * beside content's existing ones, in the same module family, because under
 * DEC-M4-7 the review write path is ordinary content plumbing — not a
 * second policy set for a second context.
 *
 * **`DRAFT_OVERSIGHT_ROLES` is reused here, never copied**, and
 * **`CROSS_SUBJECT_ROLES` is reused by `ClaimNextForReview`'s handler
 * (M4-27) calling `authorizeSubjectScope` directly** rather than declaring a
 * parallel subject-scope check — that function already reads
 * `CROSS_SUBJECT_ROLES` internally, so nothing in `application/review/`
 * needs its own copy of the constant to reuse the rule. `DRAFT_OVERSIGHT_ROLES`
 * already equals `['content_ops']`; writing a second literal array here
 * would be exactly the drift M4-01's sub-boundary exists to keep out — two
 * names for the same role set are one of them one edit away from
 * disagreeing with the other. `policies.spec.ts` asserts the constant is
 * imported, not retyped.
 *
 * **Role assignment, per DEC-M4-9 and DEC-M4-1:**
 *
 *   - **`reviewer`** claims (pulls, `ClaimNextForReview`), decides
 *     (`RecordReviewDecision`, M4-28) and edits in scope
 *     (`approve_with_edits`, M4-29) — plus releases and extends the lease on
 *     their own claim.
 *   - **`content_ops`** reassigns (`ReassignReview`, the push path DEC-M4-9
 *     names for handling an escalation), sweeps ageing (`SweepReviewAgeing`,
 *     M4-31) and reads queue health (M4-33). Reassignment is push-only:
 *     `content_ops` does not pull from the queue the way a reviewer does,
 *     because DEC-M4-9 gives Content Ops exactly one write path onto the
 *     queue and it is the escalation response, not a second claim route.
 *   - **Neither publishes without content's existing step-up.** No policy
 *     here grants `PublishItemVersion` or weakens `PUBLISH_ITEM_VERSION_POLICY`
 *     (`lifecycle-handlers.ts`) — that policy is untouched, which is the
 *     whole assertion.
 *
 * A decision may be recorded by either role — `content_ops` already could
 * under M3 (`RECORD_ITEM_REVIEW_DECISION_POLICY`), and DEC-M4-7 gives that
 * role no new restriction, only new capabilities (reassign, sweep, queue
 * health).
 */

export const CLAIM_NEXT_FOR_REVIEW_POLICY: AuthorizationPolicy = policy('ClaimNextForReview', [ROLES.reviewer]);

/** A reviewer releases their own claim; ownership is checked at the handler, the same way `authorizeDraftAccess` checks it for a draft. */
export const RELEASE_ASSIGNMENT_POLICY: AuthorizationPolicy = policy('ReleaseAssignment', [ROLES.reviewer]);

/** Content Ops' push path (DEC-M4-9) — the only way an assignment is created without a claim. */
export const REASSIGN_REVIEW_POLICY: AuthorizationPolicy = policy('ReassignReview', DRAFT_OVERSIGHT_ROLES);

/** A reviewer extends their own lease before it expires; ownership is checked at the handler. */
export const EXTEND_LEASE_POLICY: AuthorizationPolicy = policy('ExtendLease', [ROLES.reviewer]);

/** Both roles could already record a decision under M3; DEC-M4-7 adds no restriction here. */
export const RECORD_REVIEW_DECISION_POLICY: AuthorizationPolicy = policy('RecordReviewDecision', [
  ROLES.reviewer,
  ROLES.contentOps,
]);

/** Approve-with-edits (M4-29, DEC-M4-3) is a reviewer act — the reviewer edits, the author stays the author. */
export const APPROVE_WITH_EDITS_POLICY: AuthorizationPolicy = policy('ApproveWithEdits', [ROLES.reviewer]);

/** DEC-M4-15: a command any scheduler can call, restricted to the role that already owns escalation and queue health. */
export const SWEEP_REVIEW_AGEING_POLICY: AuthorizationPolicy = policy('SweepReviewAgeing', DRAFT_OVERSIGHT_ROLES);

/** DEC-M4-13: capacity planning is Content Ops' surface. */
export const GET_QUEUE_HEALTH_POLICY: AuthorizationPolicy = policy('GetQueueHealth', DRAFT_OVERSIGHT_ROLES);

/** M4-32, DEC-M4-2's operational half. Maintenance, the same surface as `SweepReviewAgeing` — nothing a reviewer triggers. */
export const REFRESH_FINGERPRINTS_POLICY: AuthorizationPolicy = policy('RefreshFingerprints', DRAFT_OVERSIGHT_ROLES);

/**
 * M4-32. Both roles that touch a claimed item read its duplicate signal — the reviewer deciding, and Content Ops overseeing.
 * M6-17 adds `system`: form assembly asks the same question of the items it is choosing between, and uses content's own
 * detection rather than a second implementation of it. It reads; it decides nothing about any item.
 */
export const GET_DUPLICATE_CANDIDATES_POLICY: AuthorizationPolicy = policy('GetDuplicateCandidates', [
  ROLES.reviewer,
  ROLES.contentOps,
  ROLES.system,
]);

/**
 * M5-33. A proposal's duplicate check is asked for by whatever is deciding
 * whether the proposal is worth keeping — Content Ops, or the generation
 * pipeline's pre-check — and by no reviewer, who sees the claimed item's own.
 * The pipeline's role is named here as curriculum names it on its taxonomy read:
 * a role string, not an import, so content still knows nothing of generation.
 */
export const GET_PROPOSAL_DUPLICATES_POLICY: AuthorizationPolicy = policy('GetDuplicateCandidatesForProposal', [
  ROLES.contentOps,
  ROLES.generationPipeline,
]);

/**
 * M4-33, DEC-M4-13. Both roles may call it — the handler itself narrows a
 * `reviewer` principal's result to their own decisions and no one else's,
 * the same ownership discipline `refuseUnlessOwner` gives a claim; only
 * `content_ops` sees every reviewer's breakdown and the true aggregate.
 */
export const GET_REVIEWER_THROUGHPUT_POLICY: AuthorizationPolicy = policy('GetReviewerThroughput', [
  ROLES.reviewer,
  ROLES.contentOps,
]);

/** Every policy this module declares — what `policies.spec.ts` walks to assert each names roles and no policy invents its own array. */
export const REVIEW_POLICIES: readonly AuthorizationPolicy[] = Object.freeze([
  CLAIM_NEXT_FOR_REVIEW_POLICY,
  RELEASE_ASSIGNMENT_POLICY,
  REASSIGN_REVIEW_POLICY,
  EXTEND_LEASE_POLICY,
  RECORD_REVIEW_DECISION_POLICY,
  APPROVE_WITH_EDITS_POLICY,
  SWEEP_REVIEW_AGEING_POLICY,
  GET_QUEUE_HEALTH_POLICY,
  REFRESH_FINGERPRINTS_POLICY,
  GET_DUPLICATE_CANDIDATES_POLICY,
  GET_PROPOSAL_DUPLICATES_POLICY,
  GET_REVIEWER_THROUGHPUT_POLICY,
]);
