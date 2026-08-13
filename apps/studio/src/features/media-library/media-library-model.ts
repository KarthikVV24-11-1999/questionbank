import { AssetTypeSchema, type AssetType } from '@questionbank/contracts/content-schemas';
import type { FieldError } from '../../authoring/body-draft.js';

/**
 * The Media library's model (M3-42, FR-QM-06, ACC-03).
 *
 * **The asset-type vocabulary is the generated one**, from the OpenAPI
 * document rather than retyped here (§9 rule 15). A hand-copied enum in the
 * browser is a divergence waiting to ship, and the one it produces is an
 * upload the server refuses for a reason the form never mentioned.
 *
 * **No MIME allowlist lives here.** The bytes go to the store at the upload
 * edge and the store answers with what it holds (M3-27); the form records the
 * answer rather than asking the author to declare it, because a declaration is
 * exactly what the domain refuses to trust.
 */

export const ASSET_TYPES = AssetTypeSchema.options;
export type { AssetType };

export function isAssetType(value: string): value is AssetType {
  return (ASSET_TYPES as readonly string[]).includes(value);
}

/**
 * Asset types whose content *is* information (ACC-03).
 *
 * "A graph of velocity against time" tells a screen-reader user that a figure
 * exists and nothing it shows, so a chart, diagram, graph or reaction scheme
 * needs a long description as well as alt text. A photograph does not.
 */
export const INFORMATION_BEARING_ASSET_TYPES = [
  'diagram',
  'chart',
  'graph',
  'reaction_scheme',
] as const satisfies readonly AssetType[];

export function requiresLongDescription(assetType: AssetType): boolean {
  return (INFORMATION_BEARING_ASSET_TYPES as readonly string[]).includes(assetType);
}

/** What the store answered with. The form never invents any of it. */
export interface StoredObject {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
}

export interface RegistrationDraft {
  readonly assetType: AssetType;
  readonly stored: StoredObject | null;
  readonly altText: string;
  readonly longDescription: string;
}

export const MEDIA_FORM_ERROR_CODES = [
  'OBJECT_NOT_UPLOADED',
  'ALT_TEXT_REQUIRED',
  'LONG_DESCRIPTION_REQUIRED',
] as const;
export type MediaFormErrorCode = (typeof MEDIA_FORM_ERROR_CODES)[number];

/**
 * Why registration is not yet available.
 *
 * **Alt text is a precondition of the action, not a validation after it.** An
 * asset that can be registered and then fixed is an asset that gets referenced
 * before anyone fixes it, and is then either published under deadline or
 * corrected by whoever happens to notice (M3-15's argument, at the surface
 * that produces the content).
 */
export function registrationBlockers(
  draft: RegistrationDraft,
): readonly FieldError<MediaFormErrorCode>[] {
  const blockers: FieldError<MediaFormErrorCode>[] = [];

  if (draft.stored === null) {
    blockers.push({
      code: 'OBJECT_NOT_UPLOADED',
      message: 'Choose a file first.',
      location: 'stored',
      fieldId: 'media-file',
    });
  }

  if (draft.altText.trim().length === 0) {
    blockers.push({
      code: 'ALT_TEXT_REQUIRED',
      message: 'Alt text is required. Describe what the figure shows, not that it is a figure.',
      location: 'altText',
      fieldId: 'media-alt-text',
    });
  }

  if (requiresLongDescription(draft.assetType) && draft.longDescription.trim().length === 0) {
    blockers.push({
      code: 'LONG_DESCRIPTION_REQUIRED',
      message: `A ${draft.assetType.replace(/_/gu, ' ')} carries information, so it needs a long description as well.`,
      location: 'longDescription',
      fieldId: 'media-long-description',
    });
  }

  return blockers;
}

export const USAGE_OWNER_TYPES = ['item', 'stimulus', 'solution'] as const;
export type UsageOwnerType = (typeof USAGE_OWNER_TYPES)[number];

export interface UsageEntry {
  readonly ownerType: UsageOwnerType;
  readonly ownerId: string;
  readonly label: string;
}

export interface MediaAssetSummary {
  readonly assetId: string;
  readonly assetType: AssetType;
  readonly altText: string;
  /** From M3-24's single count across items, stimuli and solutions. */
  readonly referencingPublishedCount: number;
}

export interface MediaLibraryApi {
  list(): Promise<readonly MediaAssetSummary[]>;
  usage(assetId: string): Promise<readonly UsageEntry[]>;
  /** The upload edge: bytes to the store, which answers with what it holds. */
  upload(file: File): Promise<StoredObject>;
  register(input: {
    readonly assetType: AssetType;
    readonly stored: StoredObject;
    readonly altText: string;
    readonly longDescription: string | null;
  }): Promise<{ readonly assetId: string }>;
  retire(assetId: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly message: string }>;
}
