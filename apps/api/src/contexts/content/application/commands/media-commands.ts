import type { CreateLicensingStatusProps } from '../../domain/licensing-status.js';
import type { AssetType } from '../../domain/media-asset.js';

/**
 * FR-QM-06. Governed assets, with the bytes outside the database and outside
 * these commands (DEC-6).
 *
 * **A command names a `storageKey`, never content.** The upload edge puts the
 * bytes and the store answers with a key; registration records what the store
 * already holds. The checksum is deliberately absent here — the handler reads
 * it from the store, because a checksum a caller supplies verifies nothing:
 * whoever replaced the object would supply the new one.
 */

export interface AuthoredMediaVersion {
  readonly storageKey: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  /** ACC-03. Enforced at construction, so an asset without it cannot exist. */
  readonly altText: string;
  readonly longDescription?: string;
  readonly licensing?: CreateLicensingStatusProps;
}

export interface RegisterMediaAsset {
  readonly assetType: AssetType;
  readonly subject: string;
  readonly version: AuthoredMediaVersion;
}

export interface AddMediaAssetVersion {
  readonly assetId: string;
  readonly subject: string;
  readonly version: AuthoredMediaVersion;
}

/** Refused while published content still references the asset (FR-QM-06 rule 3). */
export interface RetireMediaAsset {
  readonly assetId: string;
  readonly retirementReason: string;
}
