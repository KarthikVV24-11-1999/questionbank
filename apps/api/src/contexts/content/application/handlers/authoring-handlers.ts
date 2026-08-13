import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type { ItemRepository } from '../../domain/repository-ports.js';
import {
  addVersion,
  checkDeletable,
  createItem,
  latestVersionOf,
  replaceDraftVersion,
  type Item,
} from '../../domain/item.js';
import { createItemVersion, deriveDraft, type ItemVersion } from '../../domain/item-version.js';
import type { ProvenanceContext } from '../../domain/provenance.js';
import {
  applicationError,
  authorize,
  authorizeDraftAccess,
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
  AuthoredItemContent,
  CreateItemDraft,
  DeleteItemDraft,
  DeriveDraftFromVersion,
  UpdateItemDraft,
} from '../commands/authoring-commands.js';

/**
 * Orchestration only (§1). Every decision about whether an item is valid, may
 * be edited, or may be discarded belongs to the domain; this layer authorizes,
 * supplies the clock and the identifiers, saves, and audits.
 *
 * **Drafts are scoped to their author** (FR-TCH-06 rule 1). The role check
 * says a principal may act on drafts at all; `authorizeDraftAccess` says they
 * may act on *this* one. Both run on every command here, and the negative path
 * of each is tested — §5 makes 100% on authorization negative paths a
 * requirement rather than a target.
 */

export const CREATE_ITEM_DRAFT_POLICY = policy('CreateItemDraft', ['author', 'content_ops']);
export const UPDATE_ITEM_DRAFT_POLICY = policy('UpdateItemDraft', ['author', 'content_ops']);
export const DERIVE_DRAFT_FROM_VERSION_POLICY = policy('DeriveDraftFromVersion', ['author', 'content_ops']);
export const DELETE_ITEM_DRAFT_POLICY = policy('DeleteItemDraft', ['author', 'content_ops']);

export interface ItemAuthoringDependencies {
  readonly items: ItemRepository;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
  readonly idempotency: IdempotencyStore;
}

/** Domain and repository failures cross into the application taxonomy unchanged. */
function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

/**
 * The domain reads no clock, so the "is this source year plausible" bound is
 * supplied. Read from the same instant as everything else in the command, so a
 * command spanning midnight on 31 December does not validate against two
 * different years.
 */
function provenanceContextAt(at: Date): ProvenanceContext {
  return { latestPlausibleYear: at.getUTCFullYear() };
}

function versionProps(
  content: AuthoredItemContent,
  identity: { readonly versionId: string; readonly versionNo: number },
  itemType: Item['itemType'],
  authoredBy: ItemVersion['authoredBy'],
  createdAt: string,
): Parameters<typeof createItemVersion>[0] {
  return { ...content, ...identity, itemType, authoredBy, createdAt };
}

export class CreateItemDraftHandler implements Handler<CreateItemDraft, Item> {
  readonly name = 'CreateItemDraft';
  readonly policy = CREATE_ITEM_DRAFT_POLICY;

  constructor(private readonly deps: ItemAuthoringDependencies) {}

  async handle(command: CreateItemDraft, context: ApplicationContext): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const at = this.deps.clock.now();
    const version = createItemVersion(
      versionProps(
        command.content,
        { versionId: this.deps.identifiers.next(), versionNo: 1 },
        command.itemType,
        context.principal,
        at.toISOString(),
      ),
      provenanceContextAt(at),
    );
    if (!version.ok) return err(fromContent(version.error));

    const item = createItem({
      itemId: this.deps.identifiers.next(),
      itemType: command.itemType,
      initialVersion: version.value,
    });
    if (!item.ok) return err(fromContent(item.error));

    const saved = await this.deps.items.save(item.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'Item',
      targetId: saved.value.itemId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    return ok(saved.value);
  }
}

export class UpdateItemDraftHandler implements Handler<UpdateItemDraft, Item> {
  readonly name = 'UpdateItemDraft';
  readonly policy = UPDATE_ITEM_DRAFT_POLICY;

  constructor(private readonly deps: ItemAuthoringDependencies) {}

  async handle(command: UpdateItemDraft, context: ApplicationContext): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));
    const item = found.value;

    const current = latestVersionOf(item);
    const owns = authorizeDraftAccess(current.authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    // A retried save returns what already exists rather than rewriting the row
    // and writing a second audit record. Checked after authorization, so a
    // principal who may not touch this draft is still refused.
    if (await this.deps.idempotency.seen(command.idempotencyKey)) return ok(item);

    const at = this.deps.clock.now();
    // Same version identity, same authorship, same authored instant: this is
    // an edit of the draft, not a new snapshot of it. `authoredBy` deliberately
    // stays the original author — Content Ops fixing a typo in somebody's
    // draft must not take ownership of it and lock the author out (FR-TCH-06
    // rule 1).
    const version = createItemVersion(
      versionProps(
        command.content,
        { versionId: current.versionId, versionNo: current.versionNo },
        item.itemType,
        current.authoredBy,
        current.createdAt,
      ),
      provenanceContextAt(at),
    );
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
      occurredAt: at,
    });

    // Remembered only after the write landed: a save that failed must stay
    // retryable, or a dropped connection loses the author's work permanently.
    await this.deps.idempotency.remember(command.idempotencyKey);

    return ok(saved.value);
  }
}

export class DeriveDraftFromVersionHandler implements Handler<DeriveDraftFromVersion, Item> {
  readonly name = 'DeriveDraftFromVersion';
  readonly policy = DERIVE_DRAFT_FROM_VERSION_POLICY;

  constructor(private readonly deps: ItemAuthoringDependencies) {}

  async handle(
    command: DeriveDraftFromVersion,
    context: ApplicationContext,
  ): Promise<Result<Item, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));
    const item = found.value;

    const owns = authorizeDraftAccess(latestVersionOf(item).authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    const from = item.versions.find((version) => version.versionId === command.fromVersionId);
    if (from === undefined) {
      return err(
        applicationError(
          'NotFound',
          'VERSION_NOT_FOUND',
          `version ${command.fromVersionId} is not among item ${command.itemId}'s versions`,
          'fromVersionId',
        ),
      );
    }

    const at = this.deps.clock.now();
    // Here `authoredBy` *is* the editing principal: a derived version is a new
    // snapshot, and the audit trail follows the change rather than the lineage
    // (M3-09).
    const derived = deriveDraft(from, {
      versionId: this.deps.identifiers.next(),
      authoredBy: context.principal,
      createdAt: at.toISOString(),
    });
    if (!derived.ok) return err(fromContent(derived.error));

    const extended = addVersion(item, derived.value);
    if (!extended.ok) return err(fromContent(extended.error));

    const saved = await this.deps.items.save(extended.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'ItemVersion',
      targetId: derived.value.versionId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    return ok(saved.value);
  }
}

export class DeleteItemDraftHandler implements Handler<DeleteItemDraft, true> {
  readonly name = 'DeleteItemDraft';
  readonly policy = DELETE_ITEM_DRAFT_POLICY;

  constructor(private readonly deps: ItemAuthoringDependencies) {}

  async handle(command: DeleteItemDraft, context: ApplicationContext): Promise<Result<true, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.items.findById(command.itemId);
    if (!found.ok) return err(fromContent(found.error));
    const item = found.value;

    const owns = authorizeDraftAccess(latestVersionOf(item).authoredBy.id, context);
    if (!owns.ok) return err(owns.error);

    // FR-TCH-06 rule 3. The domain decides; anything past draft is withdrawn,
    // never deleted.
    const deletable = checkDeletable(item);
    if (!deletable.ok) return err(fromContent(deletable.error));

    const deleted = await this.deps.items.deleteDraft(item.itemId);
    if (!deleted.ok) return err(fromContent(deleted.error));

    // Written last and unconditionally: the deletion is permanent, so this
    // record is the only remaining evidence the item existed.
    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'Item',
      targetId: item.itemId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
      justification: command.justification,
    });

    return ok(true);
  }
}
