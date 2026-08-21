import { err, ok, type Result } from '../../../domain/result.js';
import type { ContentError } from '../../../domain/content-error.js';
import type {
  ItemRepository,
  ReviewAssignmentRepository,
  ReviewEscalationRepository,
} from '../../../domain/repository-ports.js';
import type { ReviewAssignment } from '../../../domain/review/review-assignment.js';
import type { ReviewPolicy } from '../../../domain/review/review-policy.js';
import { ageState, escalationTarget } from '../../../domain/review/ageing.js';
import { applicationError, authorize, type ApplicationError } from '../../authorization.js';
import type { ApplicationContext, AuditRecorder, Clock, IdentifierFactory, TransactionRunner } from '../../ports.js';
import { SWEEP_REVIEW_AGEING_POLICY } from '../policies.js';
import type { SweepReviewAgeing } from '../commands/ageing-commands.js';

/**
 * `SweepReviewAgeing` (FR-ADM-05, DEC-M4-1, DEC-M4-15, M4-31) — the ageing
 * sweep and escalation, as an ordinary command with a handler rather than
 * anything that implies a timer. It releases every expired lease
 * (`ReviewAssignmentRepository.releaseExpired`, M4-18) and writes one
 * `review_escalation` row — with its `ItemReviewEscalated` event, in the
 * same transaction — for every item newly past the escalation threshold.
 *
 * **Pure orchestration over M4-05.** No threshold arithmetic lives here;
 * `ageState` decides `fresh`/`warn`/`escalated` from `ReviewPolicy`, and
 * this handler only acts on the answer. A `now` earlier than an item's
 * `stateEnteredAt` is `ageState`'s own refusal (clock skew, not a negative
 * age) — that one item is skipped, not the whole sweep failed.
 *
 * **Escalation does not reassign** (DEC-M4-1). `escalateIfNew` writes a
 * role-targeted row Content Ops acts on; nothing here claims, assigns or
 * otherwise touches who is holding the item.
 *
 * **Idempotent by construction.** `escalateIfNew` returns `false` for an
 * item version that already has a row, so a second sweep at the same (or a
 * later) instant emits nothing for anything already escalated — this
 * handler does not track what it saw last time, because it does not need
 * to.
 *
 * **Tier 3, named verbatim, not attempted here (DEC-M4-15).** The
 * *scheduled invocation* — this handler run hourly, in a deployed
 * environment — is `Fail — blocked`: no scheduler, no deployment exist
 * anywhere in M4. **D36.** This handler is the whole of what M4 ships;
 * calling it on a schedule is the successor.
 */

const PAGE_SIZE = 200;

export interface AgeingDependencies {
  readonly items: ItemRepository;
  readonly assignments: ReviewAssignmentRepository;
  readonly escalations: ReviewEscalationRepository;
  readonly reviewPolicy: ReviewPolicy;
  readonly transactions: TransactionRunner;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

export interface AgeingSweepResult {
  readonly releasedAssignments: readonly ReviewAssignment[];
  readonly escalatedItemVersionIds: readonly string[];
}

/**
 * `ReviewAssignmentRepository`/`ReviewEscalationRepository`'s errors are
 * already `ContentError`-shaped; the same one-line unpacking every other
 * `application/review/**` handler already does — not a second
 * implementation of a rule, and this layer cannot import
 * `lifecycle-handlers.ts`'s private one (DEC-M4-7's sub-boundary).
 */
function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export class SweepReviewAgeingHandler {
  readonly name = 'SweepReviewAgeing';
  readonly policy = SWEEP_REVIEW_AGEING_POLICY;

  constructor(private readonly deps: AgeingDependencies) {}

  async handle(
    command: SweepReviewAgeing,
    context: ApplicationContext,
  ): Promise<Result<AgeingSweepResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const released = await this.deps.assignments.releaseExpired(command.now);
    if (!released.ok) return err(fromContent(released.error));

    const escalatedItemVersionIds: string[] = [];
    let cursor: string | undefined;

    for (;;) {
      const page = await this.deps.items.findSubmittedForReview({
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!page.ok) return err(fromContent(page.error));

      for (const item of page.value.items) {
        // Always present on anything findSubmittedForReview hydrates — the
        // repository writes it unconditionally, never NULL (M4-13).
        const stateEnteredAt = item.stateEnteredAt as string;
        const age = ageState(stateEnteredAt, command.now, this.deps.reviewPolicy);
        if (!age.ok) continue;
        if (age.value !== 'escalated') continue;

        const version = item.versions[item.versions.length - 1]!;
        // Always present on anything findSubmittedForReview hydrates — the
        // repository writes it unconditionally (never NULL, defaulted to
        // 'unclassified'), the same fact authoring-handlers.ts's own
        // `as string` casts already rely on.
        const subject = item.authoringSubject as string;
        const written = await this.deps.transactions.run(async (tx) =>
          this.deps.escalations.escalateIfNew(
            {
              itemId: item.itemId,
              itemVersionId: version.versionId,
              subject,
              reason: `past the ${this.deps.reviewPolicy.escalateAfterHours}h escalation threshold with no decision (DEC-M4-1)`,
              escalatedAt: command.now,
            },
            {
              eventId: this.deps.identifiers.next(),
              eventType: 'ItemReviewEscalated',
              schemaVersion: 1,
              occurredAt: this.deps.clock.now(),
              principal: context.principal,
              correlationId: context.correlationId,
              payload: {
                itemId: item.itemId,
                itemVersionId: version.versionId,
                subject,
                targetRoleType: escalationTarget(),
              },
            },
            tx,
          ),
        );
        if (!written.ok) return err(fromContent(written.error));
        if (written.value) escalatedItemVersionIds.push(version.versionId);
      }

      if (page.value.nextCursor === undefined) break;
      cursor = page.value.nextCursor;
    }

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'ReviewSweep',
      targetId: command.now,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok({ releasedAssignments: released.value, escalatedItemVersionIds });
  }
}
