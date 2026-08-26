import { err, ok, type Result } from '../../../domain/result.js';
import type { ContentError } from '../../../domain/content-error.js';
import type {
  ItemRepository,
  ReviewDecisionRepository,
  ReviewEscalationRepository,
} from '../../../domain/repository-ports.js';
import { AGE_STATES, ageState, type AgeState } from '../../../domain/review/ageing.js';
import type { ReviewPolicy } from '../../../domain/review/review-policy.js';
import { applicationError, authorize, DRAFT_OVERSIGHT_ROLES, type ApplicationError } from '../../authorization.js';
import type { ApplicationContext } from '../../ports.js';
import { GET_QUEUE_HEALTH_POLICY, GET_REVIEWER_THROUGHPUT_POLICY } from '../policies.js';

/**
 * Queue health, ageing & throughput (DEC-M4-13, M4-33) — read models over
 * the same population `SweepReviewAgeingHandler` (M4-31) reads:
 * `ItemRepository.findSubmittedForReview`, paged.
 *
 * **The overdue list is derived, never read from `content.review_escalation`
 * (corrected 2026-08-21).** `ageState` (M4-05) answers "has this item waited
 * past the threshold", from `stateEnteredAt`, `now` and `ReviewPolicy` —
 * correct with no scheduler running, which is every deployment M4 ships to.
 * `review_escalation` only the unscheduled sweep (M4-31) ever populates
 * (D36); reading it here would report zero overdue items while items are
 * genuinely overdue.
 *
 * **`notifiedAt` is a second, separately-named, Tier-3-dependent field.** It
 * answers "has Content Ops been told", not "is this overdue" — the two
 * questions DEC-M4-1's correction note insists stay named apart. Absent
 * means only that nothing has swept it yet, never "not overdue".
 *
 * **The throughput query is the timing instrument, not a claim about a real
 * reviewer.** `decisionsPerHour` is `count / hours` over whatever range the
 * caller names — arithmetic over `review_decision.decided_at`, proven
 * against synthetic timestamps (M4-44). Nothing here asserts a reviewer
 * actually worked at that rate.
 */

const PAGE_SIZE = 200;

export interface GetQueueHealth {
  /** DEC-M4-15: supplied, never read from a clock inside this query. */
  readonly now: string;
}

export interface QueueDepth {
  readonly subject: string;
  readonly depth: number;
}

export interface AgeHistogramBucket {
  readonly band: AgeState;
  readonly count: number;
}

export interface OverdueQueueItem {
  readonly itemId: string;
  readonly itemVersionId: string;
  readonly subject: string;
  readonly stateEnteredAt: string;
  /** Tier-3-dependent (D36) — absent means "not yet swept", never "not overdue". */
  readonly notifiedAt?: string;
}

export interface QueueHealthResult {
  readonly depthBySubject: readonly QueueDepth[];
  /** Deterministic bucketing (M4-05's own bands): `fresh` below `warnAfterHours`, `warn` from it, `escalated` from `escalateAfterHours` — every boundary inclusive-lower. */
  readonly ageHistogram: readonly AgeHistogramBucket[];
  readonly overdue: readonly OverdueQueueItem[];
  readonly asOf: string;
}

export interface QueueHealthDependencies {
  readonly items: ItemRepository;
  readonly escalations: ReviewEscalationRepository;
  readonly reviewPolicy: ReviewPolicy;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export class GetQueueHealthHandler {
  readonly name = 'GetQueueHealth';
  readonly policy = GET_QUEUE_HEALTH_POLICY;

  constructor(private readonly deps: QueueHealthDependencies) {}

  async handle(
    query: GetQueueHealth,
    context: ApplicationContext,
  ): Promise<Result<QueueHealthResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const depthBySubject = new Map<string, number>();
    const histogram = new Map<AgeState, number>(AGE_STATES.map((band) => [band, 0]));
    const overdueCandidates: OverdueQueueItem[] = [];

    let cursor: string | undefined;
    for (;;) {
      const page = await this.deps.items.findSubmittedForReview({
        limit: PAGE_SIZE,
        ...(cursor === undefined ? {} : { cursor }),
      });
      if (!page.ok) return err(fromContent(page.error));

      for (const item of page.value.items) {
        // Always present on anything findSubmittedForReview hydrates — the
        // repository writes both unconditionally, never NULL (M4-13).
        const subject = item.authoringSubject as string;
        const stateEnteredAt = item.stateEnteredAt as string;
        depthBySubject.set(subject, (depthBySubject.get(subject) ?? 0) + 1);

        const age = ageState(stateEnteredAt, query.now, this.deps.reviewPolicy);
        // A `now` earlier than this item's own `stateEnteredAt` is clock
        // skew on one row, not a reason to fail the whole report — skipped
        // from the histogram and the overdue list, exactly as
        // `SweepReviewAgeingHandler` skips it from escalation.
        if (!age.ok) continue;
        histogram.set(age.value, (histogram.get(age.value) ?? 0) + 1);

        if (age.value === 'escalated') {
          const version = item.versions[item.versions.length - 1]!;
          overdueCandidates.push({ itemId: item.itemId, itemVersionId: version.versionId, subject, stateEnteredAt });
        }
      }

      if (page.value.nextCursor === undefined) break;
      cursor = page.value.nextCursor;
    }

    const notified = await this.deps.escalations.findNotifiedAt(
      overdueCandidates.map((candidate) => candidate.itemVersionId),
    );
    if (!notified.ok) return err(fromContent(notified.error));

    const overdue = overdueCandidates.map((candidate) => {
      const notifiedAt = notified.value.get(candidate.itemVersionId);
      return notifiedAt === undefined ? candidate : { ...candidate, notifiedAt };
    });

    return ok({
      depthBySubject: [...depthBySubject.entries()]
        .map(([subject, depth]) => ({ subject, depth }))
        .sort((a, b) => a.subject.localeCompare(b.subject)),
      ageHistogram: AGE_STATES.map((band) => ({ band, count: histogram.get(band) ?? 0 })),
      overdue,
      asOf: query.now,
    });
  }
}

export interface GetReviewerThroughput {
  readonly from: string;
  readonly to: string;
}

export interface ThroughputByReviewer {
  readonly reviewerId: string;
  readonly decisionCount: number;
  readonly decisionsPerHour: number;
}

export interface ThroughputAggregate {
  readonly decisionCount: number;
  readonly decisionsPerHour: number;
}

export interface ReviewerThroughputResult {
  readonly from: string;
  readonly to: string;
  readonly hours: number;
  /**
   * Every reviewer with a decision in range, when the caller is
   * `content_ops`. A `reviewer` principal gets, at most, their own single
   * entry — "a reviewer may read their own throughput and no one else's" —
   * never every reviewer's breakdown with the others filtered client-side.
   */
  readonly perReviewer: readonly ThroughputByReviewer[];
  /** Aggregate over exactly the decisions `perReviewer` was built from — the whole queue for `content_ops`, one reviewer's own total otherwise. */
  readonly aggregate: ThroughputAggregate;
}

export interface ThroughputDependencies {
  /** Named `reviews`, matching the bag key every other handler over `ReviewDecisionRepository` already uses. */
  readonly reviews: ReviewDecisionRepository;
}

function ratePerHour(count: number, hours: number): number {
  return hours <= 0 ? 0 : count / hours;
}

export class GetReviewerThroughputHandler {
  readonly name = 'GetReviewerThroughput';
  readonly policy = GET_REVIEWER_THROUGHPUT_POLICY;

  constructor(private readonly deps: ThroughputDependencies) {}

  async handle(
    query: GetReviewerThroughput,
    context: ApplicationContext,
  ): Promise<Result<ReviewerThroughputResult, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const hours = (Date.parse(query.to) - Date.parse(query.from)) / (60 * 60 * 1000);
    const isOversight = context.principal.roleContext.some((role) => DRAFT_OVERSIGHT_ROLES.includes(role));

    const decisions = isOversight
      ? await this.deps.reviews.findWithinRange({ from: query.from, to: query.to })
      : await this.deps.reviews.findByReviewer(context.principal.id, { from: query.from, to: query.to });
    if (!decisions.ok) return err(fromContent(decisions.error));

    const byReviewer = new Map<string, number>();
    for (const decision of decisions.value) {
      byReviewer.set(decision.reviewer.id, (byReviewer.get(decision.reviewer.id) ?? 0) + 1);
    }

    const perReviewer = [...byReviewer.entries()]
      .map(([reviewerId, decisionCount]) => ({
        reviewerId,
        decisionCount,
        decisionsPerHour: ratePerHour(decisionCount, hours),
      }))
      .sort((a, b) => a.reviewerId.localeCompare(b.reviewerId));

    const decisionCount = decisions.value.length;
    return ok({
      from: query.from,
      to: query.to,
      hours,
      perReviewer,
      aggregate: { decisionCount, decisionsPerHour: ratePerHour(decisionCount, hours) },
    });
  }
}
