import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type { ItemRepository, StimulusRepository } from '../../domain/repository-ports.js';
import { latestVersionOf, replaceDraftVersion, type Item } from '../../domain/item.js';
import { pinStimulusVersion } from '../../domain/item-version.js';
import {
  createStimulus,
  createStimulusVersion,
  latestStimulusVersionOf,
  publishedStimulusVersionOf,
  replaceDraftStimulusVersion,
  type Stimulus,
} from '../../domain/stimulus.js';
import {
  applicationError,
  authorize,
  authorizeDraftAccess,
  authorizeSubjectScope,
  policy,
  type ApplicationError,
} from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type {
  ApplicationContext,
  AuditRecorder,
  Clock,
  IdempotencyStore,
  IdentifierFactory,
} from '../ports.js';
import type {
  AttachStimulusToItem,
  CreateStimulusDraft,
  UpdateStimulusDraft,
} from '../commands/stimulus-commands.js';

/**
 * Orchestration only (§1).
 *
 * **Attachment resolves the version; it does not take one.** FR-TCH-03 rule 2
 * says an association pins the version current at attachment time and does not
 * follow later edits. Letting the caller name the version would make that a
 * convention rather than a property, and the failure it prevents — an item
 * silently asking about a passage it was never authored against — is invisible
 * until a candidate disputes a mark.
 */

export const CREATE_STIMULUS_DRAFT_POLICY = policy('CreateStimulusDraft', ['author', 'content_ops']);
export const UPDATE_STIMULUS_DRAFT_POLICY = policy('UpdateStimulusDraft', ['author', 'content_ops']);
export const ATTACH_STIMULUS_TO_ITEM_POLICY = policy('AttachStimulusToItem', ['author', 'content_ops']);

export interface StimulusAuthoringDependencies {
  readonly stimuli: StimulusRepository;
  readonly items: ItemRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly idempotency: IdempotencyStore;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

export class CreateStimulusDraftHandler implements Handler<CreateStimulusDraft, Stimulus> {
  readonly name = 'CreateStimulusDraft';
  readonly policy = CREATE_STIMULUS_DRAFT_POLICY;

  constructor(private readonly deps: StimulusAuthoringDependencies) {}

  async handle(
    command: CreateStimulusDraft,
    context: ApplicationContext,
  ): Promise<Result<Stimulus, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const scoped = authorizeSubjectScope(command.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const at = this.deps.clock.now();
    const version = createStimulusVersion({
      versionId: this.deps.identifiers.next(),
      versionNo: 1,
      body: command.body,
      ...(command.licensing === undefined ? {} : { licensing: command.licensing }),
      authoredBy: context.principal,
      createdAt: at.toISOString(),
    });
    if (!version.ok) return err(fromContent(version.error));

    const stimulus = createStimulus({
      stimulusId: this.deps.identifiers.next(),
      stimulusType: command.stimulusType,
      initialVersion: version.value,
    });
    if (!stimulus.ok) return err(fromContent(stimulus.error));

    const saved = await this.deps.stimuli.save(stimulus.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'Stimulus',
      targetId: saved.value.stimulusId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    return ok(saved.value);
  }
}

export class UpdateStimulusDraftHandler implements Handler<UpdateStimulusDraft, Stimulus> {
  readonly name = 'UpdateStimulusDraft';
  readonly policy = UPDATE_STIMULUS_DRAFT_POLICY;

  constructor(private readonly deps: StimulusAuthoringDependencies) {}

  async handle(
    command: UpdateStimulusDraft,
    context: ApplicationContext,
  ): Promise<Result<Stimulus, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const scoped = authorizeSubjectScope(command.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const found = await this.deps.stimuli.findById(command.stimulusId);
    if (!found.ok) return err(fromContent(found.error));
    const stimulus = found.value;

    const current = latestStimulusVersionOf(stimulus);
    const owns = authorizeDraftAccess(current.authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    if (await this.deps.idempotency.seen(command.idempotencyKey)) return ok(stimulus);

    const at = this.deps.clock.now();
    const version = createStimulusVersion({
      versionId: current.versionId,
      versionNo: current.versionNo,
      body: command.body,
      ...(command.licensing === undefined ? {} : { licensing: command.licensing }),
      authoredBy: current.authoredBy,
      createdAt: current.createdAt,
    });
    if (!version.ok) return err(fromContent(version.error));

    const updated = replaceDraftStimulusVersion(stimulus, version.value);
    if (!updated.ok) return err(fromContent(updated.error));

    const saved = await this.deps.stimuli.save(updated.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'StimulusVersion',
      targetId: current.versionId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    await this.deps.idempotency.remember(command.idempotencyKey);
    return ok(saved.value);
  }
}

export class AttachStimulusToItemHandler implements Handler<AttachStimulusToItem, Item> {
  readonly name = 'AttachStimulusToItem';
  readonly policy = ATTACH_STIMULUS_TO_ITEM_POLICY;

  constructor(private readonly deps: StimulusAuthoringDependencies) {}

  async handle(
    command: AttachStimulusToItem,
    context: ApplicationContext,
  ): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const foundItem = await this.deps.items.findById(command.itemId);
    if (!foundItem.ok) return err(fromContent(foundItem.error));
    const item = foundItem.value;

    const current = latestVersionOf(item);
    const owns = authorizeDraftAccess(current.authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    const foundStimulus = await this.deps.stimuli.findById(command.stimulusId);
    if (!foundStimulus.ok) return err(fromContent(foundStimulus.error));
    const stimulus = foundStimulus.value;

    if (stimulus.lifecycleState === 'retired') {
      return err(
        applicationError(
          'RuleViolation',
          'STIMULUS_RETIRED',
          `stimulus ${stimulus.stimulusId} is retired and cannot be attached to new items`,
          'stimulusId',
        ),
      );
    }

    // The published version if there is one, and otherwise the latest draft —
    // an author writing a passage and its items in one sitting has published
    // nothing yet, and refusing the attachment would invert the workflow the
    // aggregate exists to support. What stops unapproved content circulating
    // is the *item's* own publication gate, not this.
    const pinned = publishedStimulusVersionOf(stimulus) ?? latestStimulusVersionOf(stimulus);

    const version = pinStimulusVersion(current, pinned.versionId);
    if (!version.ok) return err(fromContent(version.error));

    const updated = replaceDraftVersion(item, version.value);
    if (!updated.ok) return err(fromContent(updated.error));

    const saved = await this.deps.items.save(updated.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'ItemVersion',
      targetId: current.versionId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
    });

    return ok(saved.value);
  }
}
