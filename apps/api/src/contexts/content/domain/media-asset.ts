import type { PrincipalRef } from '@questionbank/domain-types';
import { err, ok, type Result } from './result.js';
import { conflictError, ruleViolationError, validationError, type ContentError } from './content-error.js';
import {
  createLicensingStatus,
  UNRESOLVED_LICENSING,
  type CreateLicensingStatusProps,
  type LicensingStatus,
} from './licensing-status.js';
import { applyTransition, type LifecycleState, type LifecycleTransition } from './item-lifecycle.js';

/**
 * `MediaAsset` — diagrams and figures as governed, licensed, accessible
 * content (DOMAIN-MODEL §5, FR-QM-06).
 *
 * **Alt text is required at construction, not at publication.** ACC-03 and
 * FR-QM-06 rule 1 make it mandatory; putting the check at publication would
 * mean assets without it exist, get referenced, and are then either published
 * under pressure or fixed by whoever notices. An asset that cannot exist
 * without alt text is one that cannot reach a student without it.
 *
 * **A complex asset needs a long description as well.** Alt text answers "what
 * is this"; a chart, graph, diagram or reaction scheme also carries
 * *information*, and a screen-reader user who gets only "a graph of velocity
 * against time" has been told the figure exists and nothing it shows.
 *
 * **Bytes never enter the domain, and never enter the database** (DEC-6,
 * TECH-STACK §3). The aggregate holds a `storageKey` and a `checksum`; the
 * object lives in object storage behind the `MediaStore` port (M3-27). A spec
 * asserts no byte-bearing field exists on this module at all — the failure
 * mode being prevented is a base64 blob in a JSONB column, which is invisible
 * until the table is unmanageable.
 *
 * **An asset in use by published content cannot be retired** (FR-QM-06 rule 3).
 * The count is supplied; the domain does no I/O.
 */

/**
 * Asset types, closed.
 *
 * Everything except a photograph carries information rather than illustration,
 * and therefore needs a long description. That is the only distinction this
 * vocabulary has to make, so it is the only one it makes.
 */
export const ASSET_TYPES = ['photograph', 'diagram', 'chart', 'graph', 'reaction_scheme'] as const;
export type AssetType = (typeof ASSET_TYPES)[number];

/** Asset types whose content is information, not decoration (ACC-03). */
export const INFORMATION_BEARING_ASSET_TYPES = [
  'diagram',
  'chart',
  'graph',
  'reaction_scheme',
] as const satisfies readonly AssetType[];

/**
 * The formats that may be stored and served, closed.
 *
 * An unknown type is refused rather than stored: serving a format the renderer
 * cannot handle produces a broken figure on some surface, which INV-14 exists
 * to prevent, and accepting arbitrary types makes the storage bucket a
 * general-purpose file host.
 *
 * `image/svg+xml` is included because diagrams and generated chemistry belong
 * in it — and it is the one format that can carry script, so the storage
 * adapter sanitizes on ingest (M3-27). The domain records the type; it does
 * not see the bytes.
 */
export const ALLOWED_MIME_TYPES = [
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/svg+xml',
] as const;
export type AllowedMimeType = (typeof ALLOWED_MIME_TYPES)[number];

export interface MediaAssetVersion {
  readonly versionId: string;
  readonly versionNo: number;
  readonly storageKey: string;
  readonly checksum: string;
  readonly mimeType: AllowedMimeType;
  readonly width: number;
  readonly height: number;
  readonly altText: string;
  readonly longDescription?: string;
  readonly licensing: LicensingStatus;
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

export interface MediaAsset {
  readonly assetId: string;
  readonly assetType: AssetType;
  readonly lifecycleState: LifecycleState;
  readonly currentPublishedVersionId?: string;
  readonly versions: readonly MediaAssetVersion[];
  readonly retirementReason?: string;
  readonly aggregateVersion: number;
}

export type MediaAssetErrorCode =
  | 'ASSET_ID_REQUIRED'
  | 'ASSET_TYPE_UNKNOWN'
  | 'VERSION_ID_REQUIRED'
  | 'VERSION_NO_INVALID'
  | 'VERSIONS_REQUIRED'
  | 'VERSION_ID_DUPLICATE'
  | 'VERSION_NUMBERS_NOT_CONTIGUOUS'
  | 'VERSION_NOT_FOUND'
  | 'VERSION_NOT_EDITABLE'
  | 'PUBLISHED_VERSION_UNKNOWN'
  | 'PUBLISHED_VERSION_REQUIRED'
  | 'STORAGE_KEY_REQUIRED'
  | 'CHECKSUM_REQUIRED'
  | 'MIME_TYPE_NOT_ALLOWED'
  | 'DIMENSIONS_INVALID'
  | 'ALT_TEXT_REQUIRED'
  | 'LONG_DESCRIPTION_REQUIRED'
  | 'AUTHORED_BY_REQUIRED'
  | 'CREATED_AT_NOT_A_TIMESTAMP'
  | 'RETIREMENT_REASON_REQUIRED'
  | 'STILL_REFERENCED';

export type MediaAssetError = ContentError<MediaAssetErrorCode>;

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/u;

function isBlank(value: string): boolean {
  return value.trim().length === 0;
}

function invalid(code: MediaAssetErrorCode, message: string, location: string): MediaAssetError {
  return validationError(code, message, location);
}

export function isAssetType(assetType: string): assetType is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(assetType);
}

export function isAllowedMimeType(mimeType: string): mimeType is AllowedMimeType {
  return (ALLOWED_MIME_TYPES as readonly string[]).includes(mimeType);
}

/** Whether this asset type carries information a long description must convey. */
export function requiresLongDescription(assetType: AssetType): boolean {
  return (INFORMATION_BEARING_ASSET_TYPES as readonly string[]).includes(assetType);
}

export interface CreateMediaAssetVersionProps {
  readonly versionId: string;
  readonly versionNo: number;
  readonly storageKey: string;
  readonly checksum: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly altText: string;
  readonly longDescription?: string;
  readonly licensing?: CreateLicensingStatusProps;
  readonly authoredBy: PrincipalRef;
  readonly createdAt: string;
}

export function createMediaAssetVersion(
  props: CreateMediaAssetVersionProps,
  assetType: AssetType,
  location = 'mediaAssetVersion',
): Result<MediaAssetVersion, MediaAssetError | ContentError> {
  if (isBlank(props.versionId)) {
    return err(invalid('VERSION_ID_REQUIRED', 'a media version requires a versionId', location));
  }
  if (!Number.isInteger(props.versionNo) || props.versionNo < 1) {
    return err(
      invalid('VERSION_NO_INVALID', `versionNo must be an integer >= 1, got ${props.versionNo}`, location),
    );
  }
  if (isBlank(props.storageKey)) {
    return err(
      invalid('STORAGE_KEY_REQUIRED', 'a media version names where its bytes live', `${location}.storageKey`),
    );
  }
  // Recorded at registration and re-verified before publication (M3-27), so a
  // replaced object is detectable rather than silently served.
  if (isBlank(props.checksum)) {
    return err(
      invalid('CHECKSUM_REQUIRED', 'a media version records the checksum of its bytes', `${location}.checksum`),
    );
  }
  if (!isAllowedMimeType(props.mimeType)) {
    return err(
      invalid(
        'MIME_TYPE_NOT_ALLOWED',
        `mime type "${props.mimeType}" is not among ${ALLOWED_MIME_TYPES.join(', ')}`,
        `${location}.mimeType`,
      ),
    );
  }
  if (
    !Number.isInteger(props.width) ||
    !Number.isInteger(props.height) ||
    props.width < 1 ||
    props.height < 1
  ) {
    return err(
      invalid(
        'DIMENSIONS_INVALID',
        `width and height must be positive integers, got ${props.width} × ${props.height}`,
        location,
      ),
    );
  }

  // ACC-03 / FR-QM-06 rule 1, at construction. An asset that cannot exist
  // without alt text cannot reach a student without it.
  if (isBlank(props.altText)) {
    return err(
      invalid('ALT_TEXT_REQUIRED', 'every media asset carries alt text (ACC-03)', `${location}.altText`),
    );
  }

  if (requiresLongDescription(assetType) && (props.longDescription === undefined || isBlank(props.longDescription))) {
    return err(
      invalid(
        'LONG_DESCRIPTION_REQUIRED',
        `a ${assetType} carries information, not only illustration; alt text alone tells a screen-reader user that the figure exists and nothing it shows`,
        `${location}.longDescription`,
      ),
    );
  }

  if (isBlank(props.authoredBy.id)) {
    return err(
      invalid('AUTHORED_BY_REQUIRED', 'every version records who authored it (INV-02)', `${location}.authoredBy`),
    );
  }
  if (!ISO_INSTANT.test(props.createdAt)) {
    return err(
      invalid(
        'CREATED_AT_NOT_A_TIMESTAMP',
        `createdAt "${props.createdAt}" is not an ISO-8601 instant`,
        `${location}.createdAt`,
      ),
    );
  }

  const licensing =
    props.licensing === undefined
      ? ok(UNRESOLVED_LICENSING)
      : createLicensingStatus(props.licensing, `${location}.licensing`);
  if (!licensing.ok) return err(licensing.error);

  return ok(
    Object.freeze({
      versionId: props.versionId,
      versionNo: props.versionNo,
      storageKey: props.storageKey,
      checksum: props.checksum,
      mimeType: props.mimeType,
      width: props.width,
      height: props.height,
      altText: props.altText,
      ...(props.longDescription === undefined ? {} : { longDescription: props.longDescription }),
      licensing: licensing.value,
      authoredBy: Object.freeze({
        ...props.authoredBy,
        roleContext: Object.freeze([...props.authoredBy.roleContext]),
      }),
      createdAt: props.createdAt,
    }),
  );
}

export interface CreateMediaAssetProps {
  readonly assetId: string;
  readonly assetType: AssetType;
  readonly initialVersion: MediaAssetVersion;
}

export function createMediaAsset(
  props: CreateMediaAssetProps,
  location = 'mediaAsset',
): Result<MediaAsset, MediaAssetError> {
  if (isBlank(props.assetId)) {
    return err(invalid('ASSET_ID_REQUIRED', 'a media asset requires an assetId', location));
  }
  if (!isAssetType(props.assetType)) {
    return err(invalid('ASSET_TYPE_UNKNOWN', `unknown asset type "${props.assetType}"`, location));
  }
  if (props.initialVersion.versionNo !== 1) {
    return err(
      invalid(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `a new asset starts at version 1, got ${props.initialVersion.versionNo}`,
        location,
      ),
    );
  }

  return ok(
    Object.freeze({
      assetId: props.assetId,
      assetType: props.assetType,
      lifecycleState: 'draft' as LifecycleState,
      versions: Object.freeze([props.initialVersion]),
      aggregateVersion: 1,
    }),
  );
}

export interface ReconstituteMediaAssetProps {
  readonly assetId: string;
  readonly assetType: AssetType;
  readonly lifecycleState: LifecycleState;
  readonly versions: readonly MediaAssetVersion[];
  readonly currentPublishedVersionId?: string;
  readonly retirementReason?: string;
  readonly aggregateVersion: number;
}

export function reconstituteMediaAsset(
  props: ReconstituteMediaAssetProps,
  location = 'mediaAsset',
): Result<MediaAsset, MediaAssetError> {
  if (isBlank(props.assetId)) {
    return err(invalid('ASSET_ID_REQUIRED', 'a media asset requires an assetId', location));
  }
  if (props.versions.length === 0) {
    return err(invalid('VERSIONS_REQUIRED', 'a media asset holds at least one version', location));
  }

  const seen = new Set<string>();
  for (const version of props.versions) {
    if (seen.has(version.versionId)) {
      return err(invalid('VERSION_ID_DUPLICATE', `version ${version.versionId} appears twice`, location));
    }
    seen.add(version.versionId);
  }

  const numbers = props.versions.map((version) => version.versionNo).sort((a, b) => a - b);
  for (const [index, number] of numbers.entries()) {
    if (number !== index + 1) {
      return err(
        invalid(
          'VERSION_NUMBERS_NOT_CONTIGUOUS',
          `version numbers must run contiguously from 1, got ${numbers.join(', ')}`,
          location,
        ),
      );
    }
  }

  if (
    props.currentPublishedVersionId !== undefined &&
    !props.versions.some((version) => version.versionId === props.currentPublishedVersionId)
  ) {
    return err(
      invalid(
        'PUBLISHED_VERSION_UNKNOWN',
        `the published version ${props.currentPublishedVersionId} is not among this asset's versions`,
        location,
      ),
    );
  }

  if (
    (props.lifecycleState === 'published' || props.lifecycleState === 'suspended') &&
    props.currentPublishedVersionId === undefined
  ) {
    return err(
      invalid(
        'PUBLISHED_VERSION_REQUIRED',
        `a ${props.lifecycleState} asset names the version that was published`,
        location,
      ),
    );
  }

  return ok(
    Object.freeze({
      assetId: props.assetId,
      assetType: props.assetType,
      lifecycleState: props.lifecycleState,
      versions: Object.freeze([...props.versions]),
      aggregateVersion: props.aggregateVersion,
      ...(props.currentPublishedVersionId === undefined
        ? {}
        : { currentPublishedVersionId: props.currentPublishedVersionId }),
      ...(props.retirementReason === undefined ? {} : { retirementReason: props.retirementReason }),
    }),
  );
}

/**
 * Replaces the bytes by adding a version. FR-QM-06 rule 3 says an in-use asset
 * is *replaced via versioning*, never deleted — so this stays available while
 * published, exactly as a stimulus does.
 */
export function addMediaAssetVersion(
  asset: MediaAsset,
  version: MediaAssetVersion,
): Result<MediaAsset, MediaAssetError> {
  if (asset.lifecycleState === 'retired') {
    return err(
      ruleViolationError('VERSION_NOT_EDITABLE', 'a retired asset does not accept a new version', 'versions'),
    );
  }
  if (asset.versions.some((existing) => existing.versionId === version.versionId)) {
    return err(conflictError('VERSION_ID_DUPLICATE', `version ${version.versionId} already exists`, 'versions'));
  }
  if (version.versionNo !== asset.versions.length + 1) {
    return err(
      invalid(
        'VERSION_NUMBERS_NOT_CONTIGUOUS',
        `the next version is ${asset.versions.length + 1}, got ${version.versionNo}`,
        'versions',
      ),
    );
  }

  return ok(
    Object.freeze({
      ...asset,
      versions: Object.freeze([...asset.versions, version]),
      aggregateVersion: asset.aggregateVersion + 1,
    }),
  );
}

export interface MediaAssetTransitionProps {
  readonly transition: LifecycleTransition;
  readonly versionId?: string;
  readonly retirementReason?: string;
  /** How much **published** content references this asset (M3-24 resolves it). */
  readonly referencingPublishedContentCount?: number;
}

export function transitionMediaAsset(
  asset: MediaAsset,
  props: MediaAssetTransitionProps,
): Result<MediaAsset, MediaAssetError | ContentError> {
  const next = applyTransition(asset.lifecycleState, props.transition);
  if (!next.ok) return err(next.error);

  if (props.transition === 'publish') {
    if (props.versionId === undefined || !asset.versions.some((v) => v.versionId === props.versionId)) {
      return err(
        invalid(
          'VERSION_NOT_FOUND',
          `publication names a version this asset holds; got "${props.versionId ?? 'none'}"`,
          'versions',
        ),
      );
    }
  }

  if (props.transition === 'retire') {
    if (props.retirementReason === undefined || isBlank(props.retirementReason)) {
      return err(invalid('RETIREMENT_REASON_REQUIRED', 'retirement requires a reason', 'retirementReason'));
    }
    const referencing = props.referencingPublishedContentCount;
    // Unknown is not zero. Defaulting it would make FR-QM-06 rule 3 advisory,
    // and the failure mode is a published item rendering a figure that is
    // no longer supposed to exist.
    if (referencing === undefined) {
      return err(
        invalid(
          'STILL_REFERENCED',
          'retirement requires knowing how much published content references this asset',
          'referencingPublishedContentCount',
        ),
      );
    }
    if (referencing > 0) {
      return err(
        ruleViolationError(
          'STILL_REFERENCED',
          `${referencing} published item(s), stimulus/stimuli or solution(s) reference this asset; replace it via a new version instead (FR-QM-06 rule 3)`,
          'referencingPublishedContentCount',
        ),
      );
    }
  }

  return ok(
    Object.freeze({
      ...asset,
      lifecycleState: next.value,
      aggregateVersion: asset.aggregateVersion + 1,
      ...(props.transition === 'publish' && props.versionId !== undefined
        ? { currentPublishedVersionId: props.versionId }
        : {}),
      ...(props.transition === 'retire' && props.retirementReason !== undefined
        ? { retirementReason: props.retirementReason }
        : {}),
    }),
  );
}

export function publishedMediaVersionOf(asset: MediaAsset): MediaAssetVersion | undefined {
  return asset.currentPublishedVersionId === undefined
    ? undefined
    : asset.versions.find((version) => version.versionId === asset.currentPublishedVersionId);
}

export function latestMediaVersionOf(asset: MediaAsset): MediaAssetVersion {
  return asset.versions.reduce((latest, version) =>
    version.versionNo > latest.versionNo ? version : latest,
  );
}

/**
 * The accessible description a renderer emits: alt text always, plus the long
 * description where the asset carries information.
 */
export function accessibleDescriptionOf(version: MediaAssetVersion): {
  readonly altText: string;
  readonly longDescription?: string;
} {
  return version.longDescription === undefined
    ? { altText: version.altText }
    : { altText: version.altText, longDescription: version.longDescription };
}
