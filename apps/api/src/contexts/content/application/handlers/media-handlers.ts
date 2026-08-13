import { err, ok, type Result } from '../../domain/result.js';
import type { ContentError } from '../../domain/content-error.js';
import type { MediaAssetRepository } from '../../domain/repository-ports.js';
import {
  addMediaAssetVersion,
  createMediaAsset,
  createMediaAssetVersion,
  latestMediaVersionOf,
  transitionMediaAsset,
  type MediaAsset,
  type MediaAssetVersion,
} from '../../domain/media-asset.js';
import {
  applicationError,
  authorize,
  authorizeSubjectScope,
  policy,
  type ApplicationError,
} from '../authorization.js';
import type { Handler } from '../handler-registry.js';
import type {
  ApplicationContext,
  AuditRecorder,
  Clock,
  IdentifierFactory,
  MediaStore,
  StoredObject,
} from '../ports.js';
import type {
  AddMediaAssetVersion,
  AuthoredMediaVersion,
  RegisterMediaAsset,
  RetireMediaAsset,
} from '../commands/media-commands.js';

/**
 * Orchestration only (§1), and the one place the content context talks to
 * object storage.
 *
 * **The checksum is read from the store, at registration, and re-checked
 * before publication.** The failure it catches is an object replaced behind a
 * key that content still believes it knows — a figure swapped after review,
 * which is a governance hole rather than a storage detail. A caller-supplied
 * checksum would not catch it.
 */

export const REGISTER_MEDIA_ASSET_POLICY = policy('RegisterMediaAsset', ['author', 'content_ops']);
export const ADD_MEDIA_ASSET_VERSION_POLICY = policy('AddMediaAssetVersion', ['author', 'content_ops']);
/** Retirement removes a figure from everything that may still be assembled. */
export const RETIRE_MEDIA_ASSET_POLICY = policy('RetireMediaAsset', ['content_ops']);

export interface MediaAuthoringDependencies {
  readonly assets: MediaAssetRepository;
  readonly store: MediaStore;
  readonly clock: Clock;
  readonly identifiers: IdentifierFactory;
  readonly audit: AuditRecorder;
}

function fromContent(error: ContentError): ApplicationError {
  return applicationError(error.kind, error.code, error.message, error.location);
}

/**
 * What the store holds behind the key, refusing a key it does not hold and a
 * key whose object is not the type the author says it is.
 */
async function resolveStoredObject(
  store: MediaStore,
  version: AuthoredMediaVersion,
): Promise<Result<StoredObject, ApplicationError>> {
  const stored = await store.head(version.storageKey);
  if (stored === undefined) {
    return err(
      applicationError(
        'NotFound',
        'OBJECT_NOT_STORED',
        `the store holds no object at ${version.storageKey}; upload it before registering it`,
        'storageKey',
      ),
    );
  }
  if (stored.contentType !== version.mimeType) {
    return err(
      applicationError(
        'Validation',
        'MIME_TYPE_DISAGREES_WITH_STORED_OBJECT',
        `the object at ${version.storageKey} is ${stored.contentType}, not the declared ${version.mimeType}`,
        'mimeType',
      ),
    );
  }
  return ok(stored);
}

/**
 * The precondition M3-28 consumes before publishing an asset version: the
 * object behind the key is still the object that was reviewed.
 */
export async function checkStoredObjectUnchanged(
  store: MediaStore,
  version: MediaAssetVersion,
): Promise<Result<true, ApplicationError>> {
  const stored = await store.head(version.storageKey);
  if (stored === undefined) {
    return err(
      applicationError(
        'PreconditionFailed',
        'OBJECT_NOT_STORED',
        `the object at ${version.storageKey} is gone; the asset cannot be published`,
        'storageKey',
      ),
    );
  }
  return stored.checksum === version.checksum
    ? ok(true)
    : err(
        applicationError(
          'PreconditionFailed',
          'CHECKSUM_MISMATCH',
          `the object at ${version.storageKey} has been replaced since it was registered`,
          'checksum',
        ),
      );
}

export class RegisterMediaAssetHandler implements Handler<RegisterMediaAsset, MediaAsset> {
  readonly name = 'RegisterMediaAsset';
  readonly policy = REGISTER_MEDIA_ASSET_POLICY;

  constructor(private readonly deps: MediaAuthoringDependencies) {}

  async handle(
    command: RegisterMediaAsset,
    context: ApplicationContext,
  ): Promise<Result<MediaAsset, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const scoped = authorizeSubjectScope(command.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const stored = await resolveStoredObject(this.deps.store, command.version);
    if (!stored.ok) return err(stored.error);

    const at = this.deps.clock.now();
    const version = createMediaAssetVersion(
      {
        ...command.version,
        versionId: this.deps.identifiers.next(),
        versionNo: 1,
        checksum: stored.value.checksum,
        authoredBy: context.principal,
        createdAt: at.toISOString(),
      },
      command.assetType,
    );
    if (!version.ok) return err(fromContent(version.error));

    const asset = createMediaAsset({
      assetId: this.deps.identifiers.next(),
      assetType: command.assetType,
      initialVersion: version.value,
    });
    if (!asset.ok) return err(fromContent(asset.error));

    const saved = await this.deps.assets.save(asset.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'MediaAsset',
      targetId: saved.value.assetId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    return ok(saved.value);
  }
}

export class AddMediaAssetVersionHandler implements Handler<AddMediaAssetVersion, MediaAsset> {
  readonly name = 'AddMediaAssetVersion';
  readonly policy = ADD_MEDIA_ASSET_VERSION_POLICY;

  constructor(private readonly deps: MediaAuthoringDependencies) {}

  async handle(
    command: AddMediaAssetVersion,
    context: ApplicationContext,
  ): Promise<Result<MediaAsset, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);
    const scoped = authorizeSubjectScope(command.subject, context);
    if (!scoped.ok) return err(scoped.error);

    const found = await this.deps.assets.findById(command.assetId);
    if (!found.ok) return err(fromContent(found.error));
    const asset = found.value;

    const stored = await resolveStoredObject(this.deps.store, command.version);
    if (!stored.ok) return err(stored.error);

    const at = this.deps.clock.now();
    const version = createMediaAssetVersion(
      {
        ...command.version,
        versionId: this.deps.identifiers.next(),
        versionNo: latestMediaVersionOf(asset).versionNo + 1,
        checksum: stored.value.checksum,
        authoredBy: context.principal,
        createdAt: at.toISOString(),
      },
      asset.assetType,
    );
    if (!version.ok) return err(fromContent(version.error));

    const extended = addMediaAssetVersion(asset, version.value);
    if (!extended.ok) return err(fromContent(extended.error));

    const saved = await this.deps.assets.save(extended.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'MediaAssetVersion',
      targetId: version.value.versionId,
      correlationId: context.correlationId,
      occurredAt: at,
    });

    return ok(saved.value);
  }
}

export class RetireMediaAssetHandler implements Handler<RetireMediaAsset, MediaAsset> {
  readonly name = 'RetireMediaAsset';
  readonly policy = RETIRE_MEDIA_ASSET_POLICY;

  constructor(private readonly deps: MediaAuthoringDependencies) {}

  async handle(
    command: RetireMediaAsset,
    context: ApplicationContext,
  ): Promise<Result<MediaAsset, ApplicationError>> {
    const permitted = authorize(this.policy, context);
    if (!permitted.ok) return err(permitted.error);

    const found = await this.deps.assets.findById(command.assetId);
    if (!found.ok) return err(fromContent(found.error));
    const asset = found.value;

    // The published version is the one content references. Nothing published
    // means nothing to reference, and the domain still refuses the transition
    // from a state that has no published version.
    const referenced = asset.currentPublishedVersionId;
    const count =
      referenced === undefined
        ? ok(0)
        : await this.deps.assets.countReferencingPublishedContent(referenced);
    if (!count.ok) return err(fromContent(count.error));

    const retired = transitionMediaAsset(asset, {
      transition: 'retire',
      retirementReason: command.retirementReason,
      // Resolved, never defaulted: unknown is not zero (FR-QM-06 rule 3).
      referencingPublishedContentCount: count.value,
    });
    if (!retired.ok) return err(fromContent(retired.error));

    const saved = await this.deps.assets.save(retired.value);
    if (!saved.ok) return err(fromContent(saved.error));

    await this.deps.audit.record({
      principal: context.principal,
      action: this.name,
      targetContext: 'content',
      targetType: 'MediaAsset',
      targetId: asset.assetId,
      correlationId: context.correlationId,
      occurredAt: this.deps.clock.now(),
      justification: command.retirementReason,
    });

    return ok(saved.value);
  }
}
