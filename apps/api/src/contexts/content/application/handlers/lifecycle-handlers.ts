import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type {
  ItemRepository,
  ReviewDecisionRepository,
  SolutionRepository,
  StimulusRepository,
} from '../../domain/repository-ports.js';
import { publishVersion, transitionItem, type Item } from '../../domain/item.js';
import type { ItemVersion } from '../../domain/item-version.js';
import { checkPublishable, type PublicationFacts } from '../../domain/publication-preconditions.js';
import {
  createReviewDecision,
  isApproving,
  toReviewerSignature,
  type ReviewedOwnerType,
  type ReviewOutcome,
} from '../../domain/review-decision.js';
import {
  latestMediaVersionOf,
  transitionMediaAsset,
  type MediaAsset,
} from '../../domain/media-asset.js';
import type { MediaAssetRepository } from '../../domain/repository-ports.js';
import { checkStoredObjectUnchanged } from './media-handlers.js';
import { transitionSolution, type Solution } from '../../domain/solution.js';
import { transitionStimulus, type Stimulus } from '../../domain/stimulus.js';
import { primaryTagOf } from '../../domain/taxonomy-tag.js';
import type {
  ContentEvent,
  ItemPublished,
  ItemRetired,
  ItemSuspended,
  MediaAssetPublished,
  SolutionPublished,
  StimulusPublished,
} from '../../domain/events/content-events.js';
import type { LifecycleTransition } from '../../domain/item-lifecycle.js';
import { isKeyAcceptedByExecutor } from '../answer-key-projection.js';
import { solutionAgreesWithKey } from '../final-answer-agreement.js';
import { applicationError, authorize, policy, type ApplicationError } from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type {
  ApplicationContext,
  AuditRecorder,
  Clock,
  IdentifierFactory,
  MediaStore,
  RenderValidator,
  ReviewProgress,
} from '../ports.js';
import type {
  PublishMediaAssetVersion,
  RecordMediaAssetReviewDecision,
  SubmitMediaAssetForReview,
  PublishItemVersion,
  PublishSolutionVersion,
  PublishStimulusVersion,
  RecordItemReviewDecision,
  RecordSolutionReviewDecision,
  RecordStimulusReviewDecision,
  RetireItem,
  RetireStimulus,
  SubmitItemForReview,
  SubmitSolutionForReview,
  SubmitStimulusForReview,
  SuspendItem,
  WithdrawItemFromReview,
} from '../commands/lifecycle-commands.js';

/**
 * FR-QM-01 rule 2 and DEC-1. **These handlers drive a machine they do not
 * own.** Every legal transition, every refusal and every publication
 * precondition lives in the domain; this layer authorizes, resolves the facts
 * the domain cannot know, saves and audits.
 *
 * `PublishItemVersion` is the correctness-bearing one: it decides which
 * version students see. It resolves the reviewer signature, the published
 * solution and its agreement with the key, the render verdict and the licence's
 * instant, and hands them to `checkPublishable`. **It decides nothing itself** —
 * a bug here can only produce a refusal or a wrong *input*, never a bypassed
 * precondition, because the aggregate refuses to publish on anything but a
 * satisfied verdict.
 */

export const SUBMIT_ITEM_FOR_REVIEW_POLICY = policy('SubmitItemForReview', ['author', 'content_ops']);
export const WITHDRAW_ITEM_FROM_REVIEW_POLICY = policy('WithdrawItemFromReview', ['author', 'content_ops']);
export const RECORD_ITEM_REVIEW_DECISION_POLICY = policy('RecordItemReviewDecision', ['reviewer', 'content_ops']);
/** SECURITY-ARCHITECTURE §4: only Content Ops publishes, and it is step-up. */
export const PUBLISH_ITEM_VERSION_POLICY = policy('PublishItemVersion', ['content_ops'], true);
export const SUSPEND_ITEM_POLICY = policy('SuspendItem', ['content_ops']);
export const RETIRE_ITEM_POLICY = policy('RetireItem', ['content_ops'], true);

export const SUBMIT_STIMULUS_FOR_REVIEW_POLICY = policy('SubmitStimulusForReview', ['author', 'content_ops']);
export const RECORD_STIMULUS_REVIEW_DECISION_POLICY = policy('RecordStimulusReviewDecision', ['reviewer', 'content_ops']);
export const PUBLISH_STIMULUS_VERSION_POLICY = policy('PublishStimulusVersion', ['content_ops'], true);
export const RETIRE_STIMULUS_POLICY = policy('RetireStimulus', ['content_ops'], true);

export const SUBMIT_SOLUTION_FOR_REVIEW_POLICY = policy('SubmitSolutionForReview', ['author', 'content_ops']);
export const RECORD_SOLUTION_REVIEW_DECISION_POLICY = policy('RecordSolutionReviewDecision', ['reviewer', 'content_ops']);
export const PUBLISH_SOLUTION_VERSION_POLICY = policy('PublishSolutionVersion', ['content_ops'], true);

export const SUBMIT_MEDIA_ASSET_FOR_REVIEW_POLICY = policy('SubmitMediaAssetForReview', ['author', 'content_ops']);
export const RECORD_MEDIA_ASSET_REVIEW_DECISION_POLICY = policy('RecordMediaAssetReviewDecision', ['reviewer', 'content_ops']);
export const PUBLISH_MEDIA_ASSET_VERSION_POLICY = policy('PublishMediaAssetVersion', ['content_ops'], true);

export interface LifecycleDependencies {
  readonly items: ItemRepository;
  readonly assets: MediaAssetRepository;
  readonly store: MediaStore;
  readonly stimuli: StimulusRepository;
  readonly solutions: SolutionRepository;
  readonly reviews: ReviewDecisionRepository;
  readonly renderer: RenderValidator;
  readonly reviewProgress: ReviewProgress;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

/** The lifecycle transition an outcome drives. `approve_with_edits` approves. */
function transitionFor(outcome: ReviewOutcome): LifecycleTransition {
  switch (outcome) {
    case 'approve':
    case 'approve_with_edits':
      return 'approve';
    case 'request_changes':
      return 'request_changes';
    case 'reject':
      return 'reject';
  }
}

abstract class AuditedHandler {
  constructor(protected readonly deps: LifecycleDependencies) {}

  /**
   * The envelope every content event shares. The payload is built per event,
   * field by field, because a payload assembled by spreading an aggregate is
   * one stem away from putting content on the analytics bus (P4/D17).
   */
  protected envelope(context: ApplicationContext) {
    return {
      eventId: this.deps.identifiers.next(),
      schemaVersion: 1,
      occurredAt: this.deps.clock.now(),
      principal: context.principal,
      correlationId: context.correlationId,
    } as const;
  }

  protected async writeAudit(
    context: ApplicationContext,
    action: string,
    targetType: string,
    targetId: string,
    justification?: string,
  ): Promise<void> {
    await this.deps.audit.record({
      principal: context.principal,
      action,
      targetContext: 'content',
      targetType,
      targetId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
      ...(justification === undefined ? {} : { justification }),
    });
  }

  /**
   * Records the decision, then drives the transition it implies. In that
   * order: a transition without its record is an approval nobody can trace to
   * a reviewer, which is what INV-07 exists to prevent.
   */
  protected async recordDecision(
    context: ApplicationContext,
    ownerType: ReviewedOwnerType,
    ownerVersionId: string,
    outcome: ReviewOutcome,
    justification: string | undefined,
  ): Promise<Result<true, ApplicationError>> {
    const decision = createReviewDecision({
      decisionId: this.deps.identifiers.next(),
      ownerType,
      ownerVersionId,
      reviewer: context.principal,
      outcome,
      ...(justification === undefined ? {} : { justification }),
      decidedAt: this.deps.clock.now().toISOString(),
    });
    if (!decision.ok) return err(fromContent(decision.error));

    const recorded = await this.deps.reviews.record(decision.value);
    if (!recorded.ok) return err(fromContent(recorded.error));
    return ok(true);
  }
}

// ── Item ────────────────────────────────────────────────────────────────────

export class SubmitItemForReviewHandler extends AuditedHandler implements Handler<SubmitItemForReview, Item> {
  readonly name = 'SubmitItemForReview';
  readonly policy = SUBMIT_ITEM_FOR_REVIEW_POLICY;

  async handle(command: SubmitItemForReview, context: ApplicationContext): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));

    // The lock of FR-TCH-08 rule 1 is the state itself: `in_review` is not an
    // editable state, so `replaceDraftVersion` refuses from here on.
    const submitted = transitionItem(found.value, { transition: 'submit_for_review' });
    if (!submitted.ok) return err(fromContent(submitted.error));

    const saved = await this.deps.items.save(submitted.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'Item', command.itemId);
    return ok(saved.value);
  }
}

export class WithdrawItemFromReviewHandler
  extends AuditedHandler
  implements Handler<WithdrawItemFromReview, Item>
{
  readonly name = 'WithdrawItemFromReview';
  readonly policy = WITHDRAW_ITEM_FROM_REVIEW_POLICY;

  async handle(
    command: WithdrawItemFromReview,
    context: ApplicationContext,
  ): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));
    const item = found.value;

    // FR-TCH-08 rule 2. Withdrawing work a reviewer has already started on
    // spends their time twice; withdrawing before they pick it up costs
    // nobody anything.
    const versionId = item.versions[item.versions.length - 1]!.versionId;
    if (await this.deps.reviewProgress.hasBegun(versionId)) {
      return err(
        applicationError(
          'PreconditionFailed',
          'REVIEW_ALREADY_BEGUN',
          'review of this version has begun; respond to the reviewer rather than withdrawing (FR-TCH-08 rule 2)',
          'lifecycleState',
        ),
      );
    }

    const withdrawn = transitionItem(item, { transition: 'withdraw' });
    if (!withdrawn.ok) return err(fromContent(withdrawn.error));

    const saved = await this.deps.items.save(withdrawn.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'Item', command.itemId);
    return ok(saved.value);
  }
}

export class RecordItemReviewDecisionHandler
  extends AuditedHandler
  implements Handler<RecordItemReviewDecision, Item>
{
  readonly name = 'RecordItemReviewDecision';
  readonly policy = RECORD_ITEM_REVIEW_DECISION_POLICY;

  async handle(
    command: RecordItemReviewDecision,
    context: ApplicationContext,
  ): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));
    const item = found.value;

    const version = item.versions.find((candidate) => candidate.versionId === command.itemVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `item ${command.itemId} holds no version ${command.itemVersionId}`,
          'itemVersionId',
        ),
      );
    }

    // INV-12, at the decision as well as at assignment (FR-QM-03). Refused
    // here rather than recorded and caught later, because a self-approval on
    // the record is evidence of a hole even if publication then refuses it.
    if (version.authoredBy.id === context.principal.id) {
      return err(
        applicationError(
          'RuleViolation',
          'REVIEWER_IS_AUTHOR',
          'the reviewer is the author of this version; self-review is prohibited (INV-12)',
          'reviewer',
        ),
      );
    }

    const recorded = await this.recordDecision(
      context,
      'item_version',
      command.itemVersionId,
      command.outcome,
      command.justification,
    );
    if (!recorded.ok) return err(recorded.error);

    const moved = transitionItem(item, { transition: transitionFor(command.outcome) });
    if (!moved.ok) return err(fromContent(moved.error));

    const saved = await this.deps.items.save(moved.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'ItemVersion', command.itemVersionId, command.justification);
    return ok(saved.value);
  }
}

export class PublishItemVersionHandler extends AuditedHandler implements Handler<PublishItemVersion, Item> {
  readonly name = 'PublishItemVersion';
  readonly policy = PUBLISH_ITEM_VERSION_POLICY;

  async handle(command: PublishItemVersion, context: ApplicationContext): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));
    const item = found.value;

    const version = item.versions.find((candidate) => candidate.versionId === command.itemVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `item ${command.itemId} holds no version ${command.itemVersionId}`,
          'itemVersionId',
        ),
      );
    }

    const facts = await this.resolveFacts(version);

    // The domain decides. Its refusal carries every unmet precondition at
    // once, and it is passed through whole so the validation panel can group
    // them without string-matching.
    const publishable = checkPublishable(item, version, facts);
    if (!publishable.ok) {
      return err(
        applicationError(
          publishable.error.kind,
          publishable.error.code,
          publishable.error.message,
          publishable.error.location,
          publishable.error.unmet,
        ),
      );
    }

    const published = publishVersion(item, {
      versionId: command.itemVersionId,
      preconditionsSatisfied: true,
    });
    if (!published.ok) return err(fromContent(published.error));

    const primaryTag = primaryTagOf(version.taxonomyTags);
    const event: ItemPublished = {
      ...this.envelope(context),
      eventType: 'ItemPublished',
      payload: {
        itemId: item.itemId,
        itemVersionId: version.versionId,
        itemType: version.itemType,
        versionNo: version.versionNo,
        sourceType: version.provenance.sourceType,
        // The precondition guarantees a primary tag, so reaching here without
        // one is impossible; the fallback would be a branch nothing can take.
        primaryConceptIdentityId: primaryTag!.conceptIdentityId,
        taxonomyVersionId: primaryTag!.taxonomyVersionId,
        // `supersedesItemVersionId` is deliberately never set. Publication is
        // legal only from `approved`, and an `Item` refuses a new version in
        // any state past draft — so nothing can be superseded today. Emitting
        // an optional field on a branch nothing reaches would be dead code
        // pretending to be a feature; the gap is recorded as debt D25.
      },
    };

    const saved = await this.deps.items.save(published.value, [event]);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'ItemVersion', command.itemVersionId);
    return ok(saved.value);
  }

  /** Every fact M3-11 requires, resolved here and decided nowhere. */
  async resolveFacts(version: ItemVersion): Promise<PublicationFacts> {
    const approval = await this.deps.reviews.findApprovalFor('item_version', version.versionId);
    const signature = approval.ok ? toReviewerSignature(approval.value) : undefined;

    const solutionVersion = await this.deps.solutions.findPublishedForItemVersion(version.versionId);
    const solution = solutionVersion.ok
      ? {
          solutionVersionId: solutionVersion.value.versionId,
          targetItemVersionId: version.versionId,
          agreesWithKey: solutionAgreesWithKey(solutionVersion.value, version.responseSpec),
        }
      : undefined;

    const renderVerdict = await this.deps.renderer.validate(version);

    return {
      ...(signature === undefined ? {} : { signature }),
      ...(solution === undefined ? {} : { solution }),
      renderVerdict,
      answerSpecificationAccepted: isKeyAcceptedByExecutor(version.responseSpec),
      asOf: this.deps.clock.now().toISOString(),
    };
  }
}

export class SuspendItemHandler extends AuditedHandler implements Handler<SuspendItem, Item> {
  readonly name = 'SuspendItem';
  readonly policy = SUSPEND_ITEM_POLICY;

  async handle(command: SuspendItem, context: ApplicationContext): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));

    const suspended = transitionItem(found.value, { transition: 'suspend' });
    if (!suspended.ok) return err(fromContent(suspended.error));

    const event: ItemSuspended = {
      ...this.envelope(context),
      eventType: 'ItemSuspended',
      payload: {
        itemId: found.value.itemId,
        // A suspended item names the version it published; the CHECK that
        // requires it is why this cannot be absent.
        itemVersionId: found.value.currentPublishedVersionId!,
        reason: command.justification,
      },
    };

    const saved = await this.deps.items.save(suspended.value, [event]);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'Item', command.itemId, command.justification);
    return ok(saved.value);
  }
}

export class RetireItemHandler extends AuditedHandler implements Handler<RetireItem, Item> {
  readonly name = 'RetireItem';
  readonly policy = RETIRE_ITEM_POLICY;

  async handle(command: RetireItem, context: ApplicationContext): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));

    const retired = transitionItem(found.value, {
      transition: 'retire',
      retirementReason: command.retirementReason,
      ...(command.replacedByItemId === undefined ? {} : { replacedByItemId: command.replacedByItemId }),
    });
    if (!retired.ok) return err(fromContent(retired.error));

    const event: ItemRetired = {
      ...this.envelope(context),
      eventType: 'ItemRetired',
      payload: {
        itemId: found.value.itemId,
        itemVersionId: found.value.currentPublishedVersionId!,
        retirementReason: command.retirementReason,
        ...(command.replacedByItemId === undefined
          ? {}
          : { replacedByItemId: command.replacedByItemId }),
      },
    };

    const saved = await this.deps.items.save(retired.value, [event]);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'Item', command.itemId, command.retirementReason);
    return ok(saved.value);
  }
}

// ── Stimulus ────────────────────────────────────────────────────────────────

export class SubmitStimulusForReviewHandler
  extends AuditedHandler
  implements Handler<SubmitStimulusForReview, Stimulus>
{
  readonly name = 'SubmitStimulusForReview';
  readonly policy = SUBMIT_STIMULUS_FOR_REVIEW_POLICY;

  async handle(
    command: SubmitStimulusForReview,
    context: ApplicationContext,
  ): Promise<Result<Stimulus, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.stimuli.findById(command.stimulusId);
    if (!found.ok) return err(fromContent(found.error));

    const submitted = transitionStimulus(found.value, { transition: 'submit_for_review' });
    if (!submitted.ok) return err(fromContent(submitted.error));

    const saved = await this.deps.stimuli.save(submitted.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'Stimulus', command.stimulusId);
    return ok(saved.value);
  }
}

export class RecordStimulusReviewDecisionHandler
  extends AuditedHandler
  implements Handler<RecordStimulusReviewDecision, Stimulus>
{
  readonly name = 'RecordStimulusReviewDecision';
  readonly policy = RECORD_STIMULUS_REVIEW_DECISION_POLICY;

  async handle(
    command: RecordStimulusReviewDecision,
    context: ApplicationContext,
  ): Promise<Result<Stimulus, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.stimuli.findById(command.stimulusId);
    if (!found.ok) return err(fromContent(found.error));
    const stimulus = found.value;

    const version = stimulus.versions.find((candidate) => candidate.versionId === command.stimulusVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `stimulus ${command.stimulusId} holds no version ${command.stimulusVersionId}`,
          'stimulusVersionId',
        ),
      );
    }
    if (version.authoredBy.id === context.principal.id) {
      return err(
        applicationError(
          'RuleViolation',
          'REVIEWER_IS_AUTHOR',
          'the reviewer is the author of this version; self-review is prohibited (INV-12)',
          'reviewer',
        ),
      );
    }

    const recorded = await this.recordDecision(
      context,
      'stimulus_version',
      command.stimulusVersionId,
      command.outcome,
      command.justification,
    );
    if (!recorded.ok) return err(recorded.error);

    const moved = transitionStimulus(stimulus, { transition: transitionFor(command.outcome) });
    if (!moved.ok) return err(fromContent(moved.error));

    const saved = await this.deps.stimuli.save(moved.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(
      context,
      this.name,
      'StimulusVersion',
      command.stimulusVersionId,
      command.justification,
    );
    return ok(saved.value);
  }
}

export class PublishStimulusVersionHandler
  extends AuditedHandler
  implements Handler<PublishStimulusVersion, Stimulus>
{
  readonly name = 'PublishStimulusVersion';
  readonly policy = PUBLISH_STIMULUS_VERSION_POLICY;

  async handle(
    command: PublishStimulusVersion,
    context: ApplicationContext,
  ): Promise<Result<Stimulus, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.stimuli.findById(command.stimulusId);
    if (!found.ok) return err(fromContent(found.error));

    // A stimulus carries no key and no solution, so its preconditions are the
    // signature and the transition itself. The signature is still required:
    // shared context reaches as many students as the items that pin it.
    const approval = await this.deps.reviews.findApprovalFor('stimulus_version', command.stimulusVersionId);
    if (!approval.ok) {
      return err(
        applicationError(
          'PreconditionFailed',
          'REVIEWER_SIGNATURE_MISSING',
          `stimulus version ${command.stimulusVersionId} carries no approving review decision (INV-07)`,
          'reviewDecision',
        ),
      );
    }

    const published = transitionStimulus(found.value, {
      transition: 'publish',
      versionId: command.stimulusVersionId,
    });
    if (!published.ok) return err(fromContent(published.error));

    // `transitionStimulus` already refused a version this stimulus does not
    // hold, so the lookup cannot miss; a fallback here would be a branch
    // nothing can reach.
    const version = found.value.versions.find(
      (candidate) => candidate.versionId === command.stimulusVersionId,
    )!;
    const event: StimulusPublished = {
      ...this.envelope(context),
      eventType: 'StimulusPublished',
      payload: {
        stimulusId: found.value.stimulusId,
        stimulusVersionId: version.versionId,
        stimulusType: found.value.stimulusType,
        versionNo: version.versionNo,
      },
    };

    const saved = await this.deps.stimuli.save(published.value, [event]);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'StimulusVersion', command.stimulusVersionId);
    return ok(saved.value);
  }
}

export class RetireStimulusHandler extends AuditedHandler implements Handler<RetireStimulus, Stimulus> {
  readonly name = 'RetireStimulus';
  readonly policy = RETIRE_STIMULUS_POLICY;

  async handle(command: RetireStimulus, context: ApplicationContext): Promise<Result<Stimulus, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.stimuli.findById(command.stimulusId);
    if (!found.ok) return err(fromContent(found.error));
    const stimulus = found.value;

    // FR-TCH-03 rule 3. Resolved, never defaulted — the domain refuses when
    // the count is simply unknown, and so does this.
    const referenced = stimulus.currentPublishedVersionId;
    const count =
      referenced === undefined
        ? ok(0)
        : await this.deps.items.countPublishedItemsUsingStimulusVersion(referenced);
    if (!count.ok) return err(fromContent(count.error));

    const retired = transitionStimulus(stimulus, {
      transition: 'retire',
      retirementReason: command.retirementReason,
      referencingPublishedItemCount: count.value,
    });
    if (!retired.ok) return err(fromContent(retired.error));

    const saved = await this.deps.stimuli.save(retired.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'Stimulus', command.stimulusId, command.retirementReason);
    return ok(saved.value);
  }
}

// ── Solution ────────────────────────────────────────────────────────────────

export class SubmitSolutionForReviewHandler
  extends AuditedHandler
  implements Handler<SubmitSolutionForReview, Solution>
{
  readonly name = 'SubmitSolutionForReview';
  readonly policy = SUBMIT_SOLUTION_FOR_REVIEW_POLICY;

  async handle(
    command: SubmitSolutionForReview,
    context: ApplicationContext,
  ): Promise<Result<Solution, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.solutions.findById(command.solutionId);
    if (!found.ok) return err(fromContent(found.error));

    const submitted = transitionSolution(found.value, { transition: 'submit_for_review' });
    if (!submitted.ok) return err(fromContent(submitted.error));

    const saved = await this.deps.solutions.save(submitted.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'Solution', command.solutionId);
    return ok(saved.value);
  }
}

export class RecordSolutionReviewDecisionHandler
  extends AuditedHandler
  implements Handler<RecordSolutionReviewDecision, Solution>
{
  readonly name = 'RecordSolutionReviewDecision';
  readonly policy = RECORD_SOLUTION_REVIEW_DECISION_POLICY;

  async handle(
    command: RecordSolutionReviewDecision,
    context: ApplicationContext,
  ): Promise<Result<Solution, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.solutions.findById(command.solutionId);
    if (!found.ok) return err(fromContent(found.error));
    const solution = found.value;

    const version = solution.versions.find((candidate) => candidate.versionId === command.solutionVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `solution ${command.solutionId} holds no version ${command.solutionVersionId}`,
          'solutionVersionId',
        ),
      );
    }
    if (version.authoredBy.id === context.principal.id) {
      return err(
        applicationError(
          'RuleViolation',
          'REVIEWER_IS_AUTHOR',
          'the reviewer is the author of this version; self-review is prohibited (INV-12)',
          'reviewer',
        ),
      );
    }

    const recorded = await this.recordDecision(
      context,
      'solution_version',
      command.solutionVersionId,
      command.outcome,
      command.justification,
    );
    if (!recorded.ok) return err(recorded.error);

    const moved = transitionSolution(solution, { transition: transitionFor(command.outcome) });
    if (!moved.ok) return err(fromContent(moved.error));

    const saved = await this.deps.solutions.save(moved.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(
      context,
      this.name,
      'SolutionVersion',
      command.solutionVersionId,
      command.justification,
    );
    return ok(saved.value);
  }
}

export class PublishSolutionVersionHandler
  extends AuditedHandler
  implements Handler<PublishSolutionVersion, Solution>
{
  readonly name = 'PublishSolutionVersion';
  readonly policy = PUBLISH_SOLUTION_VERSION_POLICY;

  async handle(
    command: PublishSolutionVersion,
    context: ApplicationContext,
  ): Promise<Result<Solution, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.solutions.findById(command.solutionId);
    if (!found.ok) return err(fromContent(found.error));
    const solution = found.value;

    const version = solution.versions.find((candidate) => candidate.versionId === command.solutionVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `solution ${command.solutionId} holds no version ${command.solutionVersionId}`,
          'solutionVersionId',
        ),
      );
    }

    const approval = await this.deps.reviews.findApprovalFor('solution_version', command.solutionVersionId);
    if (!approval.ok) {
      return err(
        applicationError(
          'PreconditionFailed',
          'REVIEWER_SIGNATURE_MISSING',
          `solution version ${command.solutionVersionId} carries no approving review decision (INV-07)`,
          'reviewDecision',
        ),
      );
    }

    // D5, re-checked at publication rather than trusted from authoring time:
    // the item's key can change after the solution was written, and a solution
    // contradicting the key is the defect that generates answer-key challenges.
    const item = await this.deps.items.findById(solution.itemId);
    if (!item.ok) return err(fromContent(item.error));
    const target = item.value.versions.find(
      (candidate) => candidate.versionId === solution.targetItemVersionId,
    );
    if (target === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `item ${solution.itemId} holds no version ${solution.targetItemVersionId}`,
          'targetItemVersionId',
        ),
      );
    }
    if (!solutionAgreesWithKey(version, target.responseSpec)) {
      return err(
        applicationError(
          'PreconditionFailed',
          'SOLUTION_DISAGREES_WITH_KEY',
          'the solution’s stated final answer no longer matches the item’s key',
          'solution.finalAnswerAssertion',
        ),
      );
    }

    const published = transitionSolution(solution, {
      transition: 'publish',
      versionId: command.solutionVersionId,
    });
    if (!published.ok) return err(fromContent(published.error));

    // No explanation text: a solution is the product's value and is
    // entitlement-gated above basic correctness (INV-08), and the outbox
    // drains to analytics.
    const event: SolutionPublished = {
      ...this.envelope(context),
      eventType: 'SolutionPublished',
      payload: {
        solutionId: solution.solutionId,
        solutionVersionId: version.versionId,
        itemId: solution.itemId,
        targetItemVersionId: solution.targetItemVersionId,
      },
    };

    const saved = await this.deps.solutions.save(published.value, [event]);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'SolutionVersion', command.solutionVersionId);
    return ok(saved.value);
  }
}

// ── Media asset ─────────────────────────────────────────────────────────────

export class SubmitMediaAssetForReviewHandler
  extends AuditedHandler
  implements Handler<SubmitMediaAssetForReview, MediaAsset>
{
  readonly name = 'SubmitMediaAssetForReview';
  readonly policy = SUBMIT_MEDIA_ASSET_FOR_REVIEW_POLICY;

  async handle(
    command: SubmitMediaAssetForReview,
    context: ApplicationContext,
  ): Promise<Result<MediaAsset, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.assets.findById(command.assetId);
    if (!found.ok) return err(fromContent(found.error));

    const submitted = transitionMediaAsset(found.value, { transition: 'submit_for_review' });
    if (!submitted.ok) return err(fromContent(submitted.error));

    const saved = await this.deps.assets.save(submitted.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'MediaAsset', command.assetId);
    return ok(saved.value);
  }
}

export class RecordMediaAssetReviewDecisionHandler
  extends AuditedHandler
  implements Handler<RecordMediaAssetReviewDecision, MediaAsset>
{
  readonly name = 'RecordMediaAssetReviewDecision';
  readonly policy = RECORD_MEDIA_ASSET_REVIEW_DECISION_POLICY;

  async handle(
    command: RecordMediaAssetReviewDecision,
    context: ApplicationContext,
  ): Promise<Result<MediaAsset, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.assets.findById(command.assetId);
    if (!found.ok) return err(fromContent(found.error));
    const asset = found.value;

    const version = asset.versions.find((candidate) => candidate.versionId === command.assetVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `asset ${command.assetId} holds no version ${command.assetVersionId}`,
          'assetVersionId',
        ),
      );
    }
    if (version.authoredBy.id === context.principal.id) {
      return err(
        applicationError(
          'RuleViolation',
          'REVIEWER_IS_AUTHOR',
          'the reviewer is the author of this version; self-review is prohibited (INV-12)',
          'reviewer',
        ),
      );
    }

    // A media asset carries alt text and a long description, which are the
    // accessibility contract ACC-03 makes — so it is reviewed like anything
    // else that reaches a student.
    const recorded = await this.recordDecision(
      context,
      'media_asset_version',
      command.assetVersionId,
      command.outcome,
      command.justification,
    );
    if (!recorded.ok) return err(recorded.error);

    const moved = transitionMediaAsset(asset, { transition: transitionFor(command.outcome) });
    if (!moved.ok) return err(fromContent(moved.error));

    const saved = await this.deps.assets.save(moved.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(
      context,
      this.name,
      'MediaAssetVersion',
      command.assetVersionId,
      command.justification,
    );
    return ok(saved.value);
  }
}

export class PublishMediaAssetVersionHandler
  extends AuditedHandler
  implements Handler<PublishMediaAssetVersion, MediaAsset>
{
  readonly name = 'PublishMediaAssetVersion';
  readonly policy = PUBLISH_MEDIA_ASSET_VERSION_POLICY;

  async handle(
    command: PublishMediaAssetVersion,
    context: ApplicationContext,
  ): Promise<Result<MediaAsset, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.assets.findById(command.assetId);
    if (!found.ok) return err(fromContent(found.error));
    const asset = found.value;

    const version = asset.versions.find((candidate) => candidate.versionId === command.assetVersionId);
    if (version === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `asset ${command.assetId} holds no version ${command.assetVersionId}`,
          'assetVersionId',
        ),
      );
    }

    const approval = await this.deps.reviews.findApprovalFor('media_asset_version', command.assetVersionId);
    if (!approval.ok) {
      return err(
        applicationError(
          'PreconditionFailed',
          'REVIEWER_SIGNATURE_MISSING',
          `asset version ${command.assetVersionId} carries no approving review decision (INV-07)`,
          'reviewDecision',
        ),
      );
    }

    // M3-27's checksum, re-read here. The failure it catches is an object
    // swapped behind its key after review — a figure that passed inspection
    // and is not the figure a student sees.
    const unchanged = await checkStoredObjectUnchanged(this.deps.store, version);
    if (!unchanged.ok) return err(unchanged.error);

    const published = transitionMediaAsset(asset, {
      transition: 'publish',
      versionId: command.assetVersionId,
    });
    if (!published.ok) return err(fromContent(published.error));

    const event: MediaAssetPublished = {
      ...this.envelope(context),
      eventType: 'MediaAssetPublished',
      payload: {
        assetId: asset.assetId,
        assetVersionId: version.versionId,
        assetType: asset.assetType,
        mimeType: version.mimeType,
      },
    };

    const saved = await this.deps.assets.save(published.value, [event]);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.writeAudit(context, this.name, 'MediaAssetVersion', command.assetVersionId);
    return ok(saved.value);
  }
}

/** Exported so `latestMediaVersionOf` has a caller in the surface that lists them. */
export { latestMediaVersionOf };
